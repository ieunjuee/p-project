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
    return round(max(cross, .3 * med + .3 * auto + .4 * cross), 4)


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
                        costs[m.kcd_code].append(m.actual_cost)
                repairs.extend(a.actual_cost for a in self.auto[pid] if a.component == "repair" and a.actual_cost is not None)
        self.med_baseline = {k: median(v) for k, v in costs.items() if v}
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
        if domain == "med":
            rows = self.med[pid]
            dates = [r.service_date for r in rows]
            ratio = max((r.actual_cost / self.med_baseline[r.kcd_code] for r in rows if r.actual_cost is not None and self.med_baseline.get(r.kcd_code, 0) > 0), default=None)
            repeat = max(Counter((r.receipt_id, r.hospital_id, r.service_date, r.component) for r in rows if r.receipt_id).values(), default=0)
            hospitals = max((len({r.hospital_id for r in rows if day <= r.service_date <= day + timedelta(days=cfg["window_days"])}) for day in set(dates)), default=0)
            return [max_window(dates, cfg["window_days"]), min_gap(dates), ratio, repeat, hospitals]
        acc, claims = self.accidents[pid], self.auto[pid]
        dates = [r.accident_date for r in acc]
        repairs = [r.actual_cost for r in claims if r.component == "repair" and r.actual_cost is not None]
        ratio = max(repairs) / self.repair_baseline if repairs and self.repair_baseline else None
        repeat = max(Counter((r.receipt_id, r.hospital_id, r.service_date, r.component) for r in claims if r.receipt_id).values(), default=0)
        # A minor accident on its own is not an abnormal accident type.
        minor = sum(a.severity == "minor" for a in acc) / len(acc) if len(acc) >= cfg["accident_count"] else 0
        return [max_window(dates, cfg["window_days"]), min_gap(dates), minor, ratio, repeat]

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
            limits = [cfg["visit_count"], cfg["short_gap_days"], cfg["cost_ratio"], cfg["repeat_count"], cfg["hospital_count"]]
        else:
            names = ["사고 횟수", "사고 간격", "사고 유형(반복 경미)", "수리비 이상도", "반복 청구"]
            limits = [cfg["accident_count"], cfg["short_gap_days"], cfg["minor_ratio"], cfg["repair_ratio"], cfg["repeat_count"]]
        signals = [{"name": name, "value": round(value, 5) if value is not None else None, "threshold": limit, "hit": value is not None and (value <= limit if i == 1 else value >= limit), "weight": cfg["weights"][i]} for i, (name, value, limit) in enumerate(zip(names, values, limits))]
        rule = sum(s["weight"] for s in signals if s["hit"])
        ml, enabled = 0, domain in self.models
        if enabled:
            predictions, reference = self.models[domain]
            value = predictions[pid]
            # Percentile only above training median. Equal values have zero anomaly contribution.
            ml = max(0, (sum(x < value - 1e-12 for x in reference) / len(reference) - .5) * 200)
        weight = self.config["model"]["rule_weight"] if enabled else 1
        score = round(min(100, weight * rule + (1 - weight) * ml), 4)
        if not (self.med[pid] if domain == "med" else self.accidents[pid]):
            score = 0
        ids = [f"MED:{r.id}" for r in self.med[pid]] if domain == "med" else [f"ACC:{r.id}" for r in self.accidents[pid]] + [f"AUTO:{r.id}" for r in self.auto[pid]]
        result = {"score": score, "rule_score": rule, "model_score": round(ml, 4), "model_enabled": enabled, "fit_partition": "tuning", "signals": signals, "evidence_ids": ids, "baseline": self.med_baseline if domain == "med" else self.repair_baseline}
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
                if same_hospital or overlap:
                    links.append({"med_id": m.id, "accident_id": a.id, "day_gap": gap, "injury_kcd": m.kcd_code, "same_hospital": same_hospital, "treatment_overlap": overlap, "evidence_ids": [f"MED:{m.id}", f"ACC:{a.id}"] + [f"AUTO:{c.id}" for c in treatments]})
        return {"links": links, "count": len(links), "evidence_ids": sorted({e for l in links for e in l["evidence_ids"]})}

    def duplicate(self, pid):
        linked = self.link(pid)
        allowed = {(l["med_id"], l["accident_id"]) for l in linked["links"]}
        med_groups, auto_groups = defaultdict(list), defaultdict(list)
        for rows, groups in ((self.med[pid], med_groups), (self.auto[pid], auto_groups)):
            for r in rows:
                if r.component != "treatment":
                    continue
                # Missing receipts stay in one date/hospital/component pool, never a Cartesian product.
                key = (r.hospital_id, r.service_date, r.component)
                groups[key].append(r)
        matches, total_d, denominator = [], 0, 0
        for key, med_rows in med_groups.items():
            auto_rows = auto_groups.get(key, [])
            if not auto_rows:
                continue
            used_m, used_a = set(), set()
            receipts = sorted({r.receipt_id for r in med_rows if r.receipt_id} & {r.receipt_id for r in auto_rows if r.receipt_id})
            pools = []
            for receipt in receipts:
                ms, acs = [r for r in med_rows if r.receipt_id == receipt], [r for r in auto_rows if r.receipt_id == receipt]
                if not any((m.id, a.accident_id) in allowed for m in ms for a in acs):
                    continue
                pools.append((ms, acs, True))
                used_m.update(m.id for m in ms)
                used_a.update(a.id for a in acs)
            ms, acs = [r for r in med_rows if r.id not in used_m], [r for r in auto_rows if r.id not in used_a]
            if ms and acs and any((m.id, a.accident_id) in allowed for m in ms for a in acs):
                pools.append((ms, acs, False))
            for ms, acs, exact in pools:
                costs = {r.actual_cost for r in ms + acs}
                paid_known = all(r.paid_amount is not None for r in ms + acs)
                cost_known = exact and None not in costs and len(costs) == 1
                mp = sum(r.paid_amount or 0 for r in ms)
                ap = sum(r.paid_amount or 0 for r in acs)
                cost = next(iter(costs)) if cost_known else None
                d = min(mp, ap, max(0, mp + ap - cost)) if cost_known and paid_known else None
                if not paid_known or (exact and not cost_known):
                    status = "unknown"
                elif not exact:
                    status = "suspected" if mp > 0 and ap > 0 else "unknown"
                else:
                    status = "confirmed_payment_overlap" if d > 0 else "normal_split"
                total_d += d or 0
                denominator += cost or 0
                matches.append({"status": status, "receipt_id": ms[0].receipt_id if exact else None, "hospital_id": key[0], "service_date": key[1].isoformat(), "med_paid": mp if paid_known else None, "auto_paid": ap if paid_known else None, "actual_cost": cost, "D": d, "evidence_ids": [f"MED:{m.id}" for m in ms] + [f"AUTO:{a.id}" for a in acs]})
        statuses = {m["status"] for m in matches}
        profile = self.profile(pid)
        med = self.signals(pid, "med")
        auto = self.signals(pid, "auto")
        concerns = []
        if profile["undeclared_prior_codes"]:
            concerns.append("policy_disclosure_conflict")
        if auto["signals"][0]["hit"] and auto["signals"][2]["hit"]:
            concerns.append("repeated_minor_accidents")
        if linked["count"] and med["signals"][0]["hit"] and med["signals"][2]["hit"]:
            concerns.append("minor_accident_excessive_treatment")
        cfg = self.config["cross"]
        score = cfg["confirmed_score"] if "confirmed_payment_overlap" in statuses else cfg["suspected_score"] if "suspected" in statuses or concerns else cfg["unknown_score"] if "unknown" in statuses else 0
        return {"matches": matches, "D": total_d, "duplicate_ratio": round(total_d / denominator, 6) if denominator else None, "ratio_denominator": denominator, "score": score, "confirmed": "confirmed_payment_overlap" in statuses, "unknown": "unknown" in statuses, "concerns": concerns, "formula_status": "provisional_pending_PDF", "evidence_ids": sorted({e for m in matches for e in m["evidence_ids"]} | set(profile["evidence_ids"]) | set(linked["evidence_ids"]))}

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
