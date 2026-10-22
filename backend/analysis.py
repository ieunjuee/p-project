"""Deterministic domain scores and expense-level cross checking. Never imports labels."""
from collections import Counter, defaultdict
from datetime import timedelta
from statistics import median

from sqlalchemy import select

from .db import AutoAccident, AutoClaim, KCD, MedClaim, Person


def record(row):
    result = {col.name: getattr(row, col.name) for col in row.__table__.columns}
    return {k: v.isoformat() if hasattr(v, "isoformat") else v for k, v in result.items()}


def overall(med, auto, cross):
    if any(not isinstance(x, (int, float)) or not 0 <= x <= 100 for x in (med, auto, cross)):
        raise ValueError("점수는 0~100의 유한한 수여야 합니다.")
    return round(float(max(cross, .3 * med + .3 * auto + .4 * cross)), 4)


def max_window(dates, days):
    dates = sorted(set(dates))
    left, largest = 0, 0
    for right, day in enumerate(dates):
        while (day - dates[left]).days > days:
            left += 1
        largest = max(largest, right - left + 1)
    return largest


def min_gap(dates):
    dates = sorted(set(dates))
    return min(((b - a).days for a, b in zip(dates, dates[1:])), default=None)


class Analysis:
    def __init__(self, session, config):
        self.session, self.config = session, config
        self.people = {p.id: p for p in session.scalars(select(Person))}
        self.med, self.auto, self.accidents = defaultdict(list), defaultdict(list), defaultdict(list)
        for cls, target in ((MedClaim, self.med), (AutoClaim, self.auto), (AutoAccident, self.accidents)):
            for row in session.scalars(select(cls).order_by(cls.id)):
                target[row.person_id].append(row)
        self.injury = {k.code for k in session.scalars(select(KCD).where(KCD.injury.is_(True)))}
        costs = defaultdict(list)
        repairs = []
        for pid, person in self.people.items():
            if person.partition == "tuning":
                for m in self.med[pid]:
                    if m.actual_cost is not None:
                        costs[(m.kcd_code, m.treatment_type)].append(m.actual_cost)
                repairs.extend(a.actual_cost for a in self.auto[pid] if a.component == "repair" and a.actual_cost is not None)
        self.med_baseline = {k: median(v) for k, v in costs.items() if v}
        self.med_peers = costs
        self.repair_peers = defaultdict(list)
        for pid in self.people:
            if self.people[pid].partition == "tuning":
                for row in self.auto[pid]:
                    if row.component == "repair" and row.actual_cost is not None:
                        accident = next(a for a in self.accidents[pid] if a.id == row.accident_id)
                        self.repair_peers[accident.accident_type].append(row.actual_cost)
        self.repair_baseline = median(repairs) if repairs else None
        self.cache, self.models = {}, {}
        self._fit_models()

    def person(self, pid):
        if pid not in self.people:
            raise ValueError("고객이 없습니다.")
        return self.people[pid]

    def profile(self, pid):
        p = self.person(pid)
        prior = sorted({m.kcd_code for m in self.med[pid] if m.service_date < p.policy_start and m.kcd_code not in self.injury and m.kcd_code not in p.declared_conditions})
        return {"person": record(p), "med_count": len(self.med[pid]), "accident_count": len(self.accidents[pid]), "auto_claim_count": len(self.auto[pid]), "undeclared_prior_codes": prior, "evidence_ids": [f"PERSON:{pid}"] + [f"MED:{m.id}" for m in self.med[pid] if m.service_date < p.policy_start]}

    def _features(self, pid, domain):
        cfg = self.config["medical" if domain == "med" else "auto"]
        def percentile(value, peers):
            return sum(x < value for x in peers) / len(peers) if peers else 0
        if domain == "med":
            rows = self.med[pid]
            diseases = defaultdict(list)
            for r in rows:
                diseases[r.kcd_code].append(r)
            frequency = max((max_window([r.service_date for r in rs], cfg["window_days"]) for rs in diseases.values()), default=0)
            gaps = []
            for rs in diseases.values():
                dates = sorted(set(r.service_date for r in rs))
                if len(dates) > 1:
                    gaps.append(sum((b-a).days for a,b in zip(dates,dates[1:]))/(len(dates)-1))
            cost = max((percentile(r.actual_cost, self.med_peers[(r.kcd_code,r.treatment_type)]) for r in rows if r.actual_cost is not None), default=0)
            repeat = max(max(Counter(r.receipt_id for r in rows if r.receipt_id).values(), default=0), max(Counter((r.service_date,r.hospital_id,r.claimed_amount) for r in rows).values(), default=0))
            hospitals = max((len({r.hospital_id for r in rs if day <= r.service_date <= day + timedelta(days=cfg["window_days"])}) for rs in diseases.values() for day in {r.service_date for r in rs}), default=0)
            return [frequency, min(gaps, default=None), cost, repeat, hospitals]
        acc, claims = self.accidents[pid], self.auto[pid]
        repair = max((percentile(r.actual_cost,self.repair_peers[next(a.accident_type for a in acc if a.id == r.accident_id)]) for r in claims if r.component == "repair" and r.actual_cost is not None),default=0)
        minor = int(any(a.severity == "minor" and any(c.accident_id == a.id and c.component == "treatment" for c in claims) for a in acc))
        repeat = max(max(Counter(a.counterparty_id for a in acc if a.counterparty_id != "unknown").values(),default=0),max(Counter(a.repair_shop_id for a in acc if a.repair_shop_id != "unknown").values(),default=0),max(Counter((c.accident_id,c.component) for c in claims).values(),default=0))
        return [max_window([a.accident_date for a in acc],cfg["window_days"]), min_gap([a.accident_date for a in acc]), minor, repair, repeat]

    def _fit_models(self):
        tuning = [pid for pid, p in self.people.items() if p.partition == "tuning"]
        if len(tuning) < self.config["model"]["min_tuning_people"]:
            return
        from sklearn.ensemble import IsolationForest
        for domain in ("med", "auto"):
            matrix = [self._features(pid, domain) for pid in tuning]
            impute = [median([row[i] for row in matrix if row[i] is not None]) if any(row[i] is not None for row in matrix) else 0 for i in range(5)]
            fill = lambda row: [v if v is not None else impute[i] for i, v in enumerate(row)]
            cfg = self.config["model"]
            model = IsolationForest(n_estimators=cfg["trees"], max_samples=min(len(matrix), cfg["sample_size"]), random_state=cfg["seed"], n_jobs=1).fit([fill(r) for r in matrix])
            scores = sorted(-model.score_samples([fill(r) for r in matrix]))
            all_ids = sorted(self.people)
            all_scores = -model.score_samples([fill(self._features(pid, domain)) for pid in all_ids])
            self.models[domain] = (dict(zip(all_ids, map(float, all_scores))), scores)

    def signals(self, pid, domain):
        self.person(pid)
        key = (pid, domain)
        if key in self.cache:
            return self.cache[key]
        cfg = self.config["medical" if domain == "med" else "auto"]
        values = self._features(pid, domain)
        if domain == "med":
            names = ["진료 횟수", "진료 간격", "진료비 이상도", "반복 청구", "의료기관 분산"]
            limits = [cfg["visit_count"], cfg["short_gap_days"], cfg["cost_percentile"], cfg["repeat_count"], cfg["hospital_count"]]
        else:
            names = ["사고 횟수", "사고 간격", "사고 유형(반복 경미)", "수리비 이상도", "반복 청구"]
            limits = [cfg["accident_count"], cfg["short_gap_days"], 1, cfg["repair_percentile"], cfg["repeat_count"]]
        signals = [{"name": name, "value": round(value, 5) if value is not None else None, "threshold": limit, "hit": value is not None and (value < limit if i == 1 else value >= limit), "weight": cfg["weights"][i]} for i, (name, value, limit) in enumerate(zip(names, values, limits))]
        rule = sum(s["weight"] for s in signals if s["hit"])
        ml, enabled = 0, domain in self.models
        if enabled:
            predictions, reference = self.models[domain]
            value = predictions[pid]
            # Percentile only above training median. Equal values have zero anomaly contribution.
            ml = max(0, (sum(x < value - 1e-12 for x in reference) / len(reference) - .5) * 200)
        weight = self.config["model"]["rule_weight"] if enabled else 1
        score = round(float(min(100, weight * rule + (1 - weight) * ml)), 4)
        if not (self.med[pid] if domain == "med" else self.accidents[pid]):
            score = 0
        ids = [f"MED:{r.id}" for r in self.med[pid]] if domain == "med" else [f"ACC:{r.id}" for r in self.accidents[pid]] + [f"AUTO:{r.id}" for r in self.auto[pid]]
        result = {"score": score, "rule_score": rule, "model_score": round(float(ml), 4), "model_enabled": enabled, "fit_partition": "tuning", "signals": signals, "evidence_ids": ids, "baseline": {"|".join(k): v for k,v in self.med_baseline.items()} if domain == "med" else self.repair_baseline}
        self.cache[key] = result
        return result

    def link(self, pid):
        self.person(pid)
        links = []
        for m in self.med[pid]:
            if m.kcd_code not in self.injury:
                continue
            for a in self.accidents[pid]:
                gap = (m.service_date - a.accident_date).days
                if not 0 <= gap <= self.config["cross"]["link_days"]:
                    continue
                treatments = [c for c in self.auto[pid] if c.accident_id == a.id and c.component == "treatment"]
                same_hospital = any(c.hospital_id == m.hospital_id for c in treatments)
                overlap = any(max(c.service_date, m.service_date) <= min(c.treatment_end, m.treatment_end) for c in treatments)
                if True:
                    links.append({"med_id": m.id, "accident_id": a.id, "day_gap": gap, "injury_kcd": m.kcd_code, "same_hospital": same_hospital, "treatment_overlap": overlap, "evidence_ids": [f"MED:{m.id}", f"ACC:{a.id}"] + [f"AUTO:{c.id}" for c in treatments]})
        return {"links": links, "count": len(links), "evidence_ids": sorted({e for l in links for e in l["evidence_ids"]})}

    def duplicate(self, pid):
        linked = self.link(pid)
        allowed = {(l["med_id"], l["accident_id"]) for l in linked["links"]}
        linked_mids = {l["med_id"] for l in linked["links"]}
        candidates = []
        for m in self.med[pid]:
            for a in self.auto[pid]:
                if (m.id,a.accident_id) not in allowed or a.component == "repair":
                    continue
                exact = bool(m.receipt_id and m.receipt_id == a.receipt_id)
                same_day_hospital = m.hospital_id == a.hospital_id and m.service_date == a.service_date
                similar = abs(m.claimed_amount-a.claimed_amount) <= self.config["cross"]["amount_tolerance"]*max(m.claimed_amount,a.claimed_amount,1)
                separate = m.component != a.component or m.treatment_end < a.service_date or a.treatment_end < m.service_date
                if exact or same_day_hospital and similar or separate:
                    candidates.append((not exact, m.id,a.id,m,a,exact,separate))
        # Disjoint claim matching: no payout can be counted in two candidate pairs.
        used_m,used_a,matches = set(),set(),[]
        for _,_,_,m,a,exact,separate in sorted(candidates,key=lambda x:(x[0],-min(x[3].paid_amount or 0,x[4].paid_amount or 0),x[1],x[2])):
            if m.id in used_m or a.id in used_a:
                continue
            if not exact and not separate and (not m.receipt_id or not a.receipt_id):
                status="unknown"
            elif separate:
                status="normal_split"
            elif m.paid_amount is None or a.paid_amount is None:
                status="unknown"
            elif m.paid_amount > 0 and a.paid_amount > 0:
                status="confirmed_payment_overlap" if exact else "suspected"
            else:
                status="normal_split"
            used_m.add(m.id); used_a.add(a.id)
            d=min(m.paid_amount,a.paid_amount) if status in {"confirmed_payment_overlap","suspected"} else 0
            matches.append({"status":status,"receipt_id":m.receipt_id,"hospital_id":m.hospital_id,"service_date":m.service_date.isoformat(),"med_paid":m.paid_amount,"auto_paid":a.paid_amount,"actual_cost":m.actual_cost,"D":d,"evidence_ids":[f"MED:{m.id}",f"AUTO:{a.id}"]})
        denominator=sum(m.paid_amount or 0 for m in self.med[pid] if m.id in linked_mids)
        total_d=sum(m["D"] for m in matches)
        disclosure=[m for m in self.med[pid] if m.id in linked_mids and m.accident_flag == "disease"]
        preexisting=set()
        for l in linked["links"]:
            acc=next(a for a in self.accidents[pid] if a.id == l["accident_id"])
            for m in self.med[pid]:
                if 0 < (acc.accident_date-m.service_date).days <= self.config["cross"]["prior_days"] and m.kcd_code == l["injury_kcd"]:
                    preexisting.add(m.id)
        ratio=total_d/denominator if denominator else 0
        cfg=self.config["cross"]
        score=min(100,ratio*cfg["ratio_weight"]+len(disclosure)*cfg["disclosure_weight"]+len(preexisting)*cfg["preexisting_weight"])
        concerns=(["accident_disclosure_check"] if disclosure else [])+(["preexisting_condition_check"] if preexisting else [])
        statuses={m["status"] for m in matches}
        return {"matches":matches,"D":total_d,"duplicate_ratio":round(ratio,6) if denominator else None,"ratio_denominator":denominator,"score":round(score,4),"confirmed":"confirmed_payment_overlap" in statuses,"unknown":"unknown" in statuses or any(m.paid_amount is None for m in self.med[pid] if m.id in linked_mids),"concerns":concerns,"disclosure_count":len(disclosure),"preexisting_count":len(preexisting),"formula_status":"PDF_page_4","evidence_ids":sorted({e for m in matches for e in m["evidence_ids"]}|set(linked["evidence_ids"])|{f"MED:{m.id}" for m in disclosure}|{f"MED:{i}" for i in preexisting})}

    def compute(self, pid):
        med, auto, cross = self.signals(pid, "med"), self.signals(pid, "auto"), self.duplicate(pid)
        return {"S_med": med["score"], "S_auto": auto["score"], "S_cross": cross["score"], "S_overall": overall(med["score"], auto["score"], cross["score"]), "confirmed_payment_overlap": cross["confirmed"], "evidence_ids": [f"SCORE:{pid}"], "formula": "max(S_cross, 0.3*S_med + 0.3*S_auto + 0.4*S_cross)"}

    def claims(self, pid, kind="med", offset=0, limit=12):
        self.person(pid)
        if kind not in {"med", "auto", "accident"}:
            raise ValueError("지원하지 않는 보험 유형입니다.")
        rows = {"med": self.med, "auto": self.auto, "accident": self.accidents}[kind][pid]
        prefix = {"med": "MED", "auto": "AUTO", "accident": "ACC"}[kind]
        return {"rows": [record(r) for r in rows[offset:offset+limit]], "total": len(rows), "offset": offset, "evidence_ids": [f"{prefix}:{r.id}" for r in rows[offset:offset+limit]]}
