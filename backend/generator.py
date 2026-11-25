"""Seeded, relational synthetic ledger. Labels are written only to the evaluator table."""
import random
from collections import Counter
from datetime import date, timedelta

from sqlalchemy import delete

from .db import (AutoAccident, AutoClaim, Dataset, Investigation, KCD, MedClaim,
                 Person, ScenarioLabel, audit)

SCENARIOS = {"normal", "normal_split", "frequent_normal", "duplicate", "nondisclosure", "repeated_minor", "excessive_treatment", "compound"}
KCD_ROWS = [("J00", "합성 급성 비인두염", False), ("E11", "합성 만성질환", False), ("S13", "합성 목 부위 손상", True), ("S33", "합성 요추 부위 손상", True)]


def generate(session, config, seed=42, people=None, ratios=None):
    cfg = config["generation"]
    n = people or cfg["people"]
    ratios = ratios or cfg["scenarios"]
    if set(ratios) != SCENARIOS or any(v < 0 for v in ratios.values()) or abs(sum(ratios.values()) - 1) > 1e-8:
        raise ValueError("시나리오 이름과 비율 합계(1)를 확인하세요.")
    if not 10 <= n <= 5000:
        raise ValueError("고객 수는 10~5000명입니다.")
    rng = random.Random(seed)
    for model in (Investigation, ScenarioLabel, AutoClaim, MedClaim, AutoAccident, Person):
        session.execute(delete(model))
    if not session.get(KCD, "J00"):
        session.add_all([KCD(code=k, description=d, injury=i, body_part="neck" if k == "S13" else "lumbar" if k == "S33" else "other") for k, d, i in KCD_ROWS])
        session.flush()
    # Largest remainder allocation makes even small synthetic sets stratified and reproducible.
    allocation = {k: int(n * v) for k, v in ratios.items()}
    for k in sorted(ratios, key=lambda k: (-(n * ratios[k] - allocation[k]), k))[:n - sum(allocation.values())]:
        allocation[k] += 1
    scenarios = [k for k, count in allocation.items() for _ in range(count)]
    rng.shuffle(scenarios)
    order = list(range(n))
    rng.shuffle(order)
    tuning = set(order[:round(n * cfg["tuning_fraction"] )])
    persons, meds, accidents, autos, labels = [], [], [], [], []
    base = date(2025, 1, 1)
    counts = [5] * n
    weights = [3 if s in ("frequent_normal", "excessive_treatment", "compound") else 1 for s in scenarios]
    for i in rng.choices(range(n), weights, k=round(cfg["med_claims"] * n / cfg["people"]) - 5 * n):
        counts[i] += 1
    accident_counts = [4 if s in {"repeated_minor", "compound"} else int(s in {"normal_split", "duplicate", "excessive_treatment", "nondisclosure"}) for s in scenarios]
    target = round(cfg["accidents"] * n / cfg["people"])
    for i in rng.choices(range(n), [8 if s in ("repeated_minor", "compound") else 1 for s in scenarios], k=max(0, target - sum(accident_counts))):
        accident_counts[i] += 1
    for i, scenario in enumerate(scenarios):
        pid = f"P{i+1:04d}"
        policy_start = base + timedelta(days=60)
        declared = ["E11"] if scenario == "frequent_normal" else []
        persons.append(Person(id=pid, age=rng.randint(20, 79), partition="tuning" if i in tuning else "evaluation", sex=rng.choice(["female", "male"]), policy_start=policy_start, declared_conditions=declared))
        labels.append(ScenarioLabel(person_id=pid, scenario=scenario, risky=scenario not in {"normal", "normal_split", "frequent_normal"}, duplicate=scenario in {"duplicate", "compound"}, injected_signals=[] if scenario == "normal" else [scenario], confusing_normal=scenario in {"normal_split", "frequent_normal"}))
        event_day = base + timedelta(days=rng.randint(100, 250))
        for j in range(accident_counts[i]):
            ad = event_day + timedelta(days=j * (8 if scenario in {"repeated_minor", "compound"} else 36))
            aid = f"A{i+1:04d}-{j+1}"
            hospital, receipt = f"H{rng.randint(1,20):03d}", f"R-{aid}"
            accidents.append(AutoAccident(id=aid, person_id=pid, accident_date=ad, accident_type=rng.choice(["rear_end", "parking", "side"]), severity="minor", report_date=ad + timedelta(days=1), counterparty_id=f"CP-{pid}" if scenario in {"repeated_minor", "compound"} else f"CP-{aid}", repair_shop_id=f"G-{pid}" if scenario in {"repeated_minor", "compound"} else f"G-{aid}", fault_ratio=rng.randint(0,100)))
            repair = rng.randrange(200000, 1200000, 10000) * (4 if scenario == "compound" else 1)
            autos.append(AutoClaim(id=f"AC-{aid}-R", person_id=pid, accident_id=aid, service_date=ad, treatment_end=ad, hospital_id="GARAGE", receipt_id=f"REPAIR-{aid}", component="repair", kcd_code=None, actual_cost=repair, claimed_amount=repair, paid_amount=repair))
            cost = rng.randrange(100000, 400000, 10000)
            apaid = cost
            autos.append(AutoClaim(id=f"AC-{aid}-T", person_id=pid, accident_id=aid, service_date=ad + timedelta(days=1), treatment_end=ad + timedelta(days=7), hospital_id=hospital, receipt_id=receipt, component="treatment", kcd_code="S13", actual_cost=cost, claimed_amount=cost, paid_amount=apaid))
            if j == 0 and scenario in {"duplicate", "compound", "normal_split"}:
                mpaid = cost * 3 // 10 if scenario == "normal_split" else cost * 8 // 10
                meds.append(MedClaim(id=f"M-{pid}-LINK", person_id=pid, service_date=ad + timedelta(days=1), treatment_end=ad + timedelta(days=7), hospital_id=hospital, receipt_id=receipt + "-NONCOVERED" if scenario == "normal_split" else receipt, component="noncovered" if scenario == "normal_split" else "treatment", kcd_code="S13", accident_flag="injury", actual_cost=cost, claimed_amount=cost, paid_amount=mpaid))
        for j in range(counts[i] - int(scenario in {"duplicate", "compound", "normal_split"})):
            clustered = scenario in {"frequent_normal", "excessive_treatment", "compound"}
            day = event_day + timedelta(days=j) if clustered else base + timedelta(days=70 + (j * 29 + rng.randint(0, 5)) % 270)
            kcd = "E11" if scenario == "frequent_normal" else ("S13" if scenario in {"excessive_treatment", "compound", "nondisclosure"} else "J00")
            if scenario == "nondisclosure":
                day = event_day + timedelta(days=1 + j)
            if scenario == "compound" and j == 0:
                day = event_day - timedelta(days=20)
            cost = rng.randrange(20000, 130000, 1000) * (8 if scenario in {"excessive_treatment", "compound"} else 1)
            meds.append(MedClaim(id=f"M-{pid}-{j:03d}", person_id=pid, service_date=day, treatment_end=day, hospital_id=f"H{(j % 6 + 1) if scenario == 'compound' else (i % 20 + 1):03d}", receipt_id=f"RM-{pid}-{j}", component="treatment", kcd_code=kcd, accident_flag="disease" if scenario == "nondisclosure" or kcd not in {"S13", "S33"} else "injury", treatment_type="physical_therapy" if scenario == "frequent_normal" else "outpatient", actual_cost=cost, claimed_amount=cost, paid_amount=cost * 8 // 10))
    for row in meds + autos:
        row.claim_date = row.service_date + timedelta(days=3)
    session.add_all(persons)
    session.flush()
    session.add_all(accidents)
    session.flush()
    session.add_all(meds + autos + labels)
    session.flush()
    summary = {"people": n, "med_claims": len(meds), "accidents": len(accidents), "auto_claims": len(autos), "tuning": len(tuning), "evaluation": n - len(tuning), "synthetic": True}
    session.add(Dataset(seed=seed, summary=summary))
    audit(session, "dataset_generated", {"seed": seed, **summary, "spec_status": config["spec_status"]})
    return summary
