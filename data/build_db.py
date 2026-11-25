"""모의 데이터 생성기.

실행: python3 data/build_db.py
결과: data/insure.db (SQLite 6개 테이블), dist/data/mock.json (화면용 동일 데이터), dist/data/insure.db (화면용 DB, 정답표 제외)

시나리오 비율과 지표 기준값은 초안이며, 팀 합의 후 조정해야 합니다.
"""
import json
import os
import random
import shutil
import sqlite3
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB_PATH = os.path.join(HERE, "insure.db")
JSON_PATH = os.path.join(ROOT, "dist", "data", "mock.json")
SEED = 20261022
START = date(2026, 1, 1)
DAYS = 273  # 2026-01-01 ~ 2026-09-30

# 질병코드표: (코드, 명칭, 부위, 손상 여부)
KCD = [
    ("S13", "경추 염좌", "목", 1),
    ("S33", "요추 염좌", "허리", 1),
    ("S93", "발목 염좌", "발목", 1),
    ("S60", "손목 타박상", "손목", 1),
    ("S80", "무릎 타박상", "무릎", 1),
    ("M54", "요통", "허리", 0),
    ("M25", "관절통", "무릎", 0),
    ("M75", "어깨 병변", "어깨", 0),
    ("J00", "감기", "호흡기", 0),
    ("K21", "역류성 식도염", "소화기", 0),
]
INJURY = [k for k in KCD if k[3] == 1]
DISEASE = [k for k in KCD if k[3] == 0]

# 시나리오와 인원 비율 (합계 100%)
SCENARIOS = [
    ("일반정상", 0.60, 0),
    ("정상분리청구", 0.08, 0),
    ("잦은정상진료", 0.07, 0),
    ("중복보상", 0.06, 1),
    ("고지누락", 0.05, 1),
    ("반복경미사고", 0.05, 1),
    ("경미사고과잉진료", 0.05, 1),
    ("복합", 0.04, 1),
]
TOTAL_PEOPLE = 500
AGE = ["20대", "30대", "40대", "50대", "60대"]


class Builder:
    def __init__(self, seed=SEED):
        self.r = random.Random(seed)
        self.person, self.med, self.acc, self.auto, self.label = [], [], [], [], []
        self.seq = {"M": 0, "A": 0, "AC": 0, "RC": 0}

    def nid(self, kind):
        self.seq[kind] += 1
        return f"{kind}{self.seq[kind]:05d}"

    def day(self, offset):
        return (START + timedelta(days=offset)).isoformat()

    def hospital(self):
        return f"H{self.r.randint(1, 40):03d}"

    # --- 삽입 도우미 -----------------------------------------------------
    def add_med(self, pid, offset, code, treatment, hospital, amount,
                receipt=None, flag="질병", paid=None):
        claim_id = self.nid("M")
        self.med.append({
            "claim_id": claim_id,
            "person_id": pid,
            "visit_date": self.day(offset),
            "claim_date": self.day(offset + self.r.randint(1, 10)),
            "disease_code": code,
            "treatment_type": treatment,
            "hospital_id": hospital,
            "receipt_no": receipt,
            "claim_amount": amount,
            "paid_amount": amount if paid is None else paid,
            "accident_flag": flag,
        })
        return claim_id

    def add_accident(self, pid, offset, kind, role="피해",
                     counterparty=None, shop=None):
        accident_id = self.nid("A")
        self.acc.append({
            "accident_id": accident_id,
            "person_id": pid,
            "accident_date": self.day(offset),
            "report_date": self.day(offset + self.r.randint(0, 3)),
            "accident_type": kind,
            "role": role,
            "fault_ratio": 0 if role == "피해" else self.r.choice([70, 80, 100]),
            "counterparty_id": counterparty or f"C{self.r.randint(1, 300):04d}",
            "repair_shop_id": shop or f"S{self.r.randint(1, 50):03d}",
        })
        return accident_id

    def add_auto(self, pid, accident_id, kind, offset, amount,
                 hospital=None, receipt=None, treat=None, paid=None):
        self.auto.append({
            "auto_claim_id": self.nid("AC"),
            "accident_id": accident_id,
            "person_id": pid,
            "claim_type": kind,
            "claim_date": self.day(offset),
            "amount": amount,
            "paid_amount": amount if paid is None else paid,
            "hospital_id": hospital,
            "receipt_no": receipt,
            "treat_start": self.day(treat[0]) if treat else None,
            "treat_end": self.day(treat[1]) if treat else None,
        })

    # --- 공통 패턴 -------------------------------------------------------
    def normal_medical(self, pid, count=None):
        """흩어진 일반 진료. 같은 병명이 30일 안에 몰리지 않게 만듭니다."""
        for _ in range(self.r.randint(0, 4) if count is None else count):
            code = self.r.choice(DISEASE)[0]
            treatment = self.r.choices(["외래", "물리치료", "입원"], [0.75, 0.2, 0.05])[0]
            self.add_med(pid, self.r.randrange(DAYS), code, treatment,
                         self.hospital(), self.amount(treatment),
                         receipt=self.nid("RC"))

    def amount(self, treatment, high=False):
        base = {"외래": (45000, 150000), "물리치료": (80000, 200000),
                "입원": (800000, 2600000)}[treatment]
        value = self.r.randint(*base)
        if high:
            value = int(value * self.r.uniform(2.2, 3.2))
        return round(value, -3)

    def minor_accident(self, pid, offset, counterparty=None, shop=None, injury=True):
        accident_id = self.add_accident(pid, offset, "접촉",
                                        counterparty=counterparty, shop=shop)
        self.add_auto(pid, accident_id, "대물수리비", offset + 3,
                      self.r.randint(400000, 1800000))
        return accident_id

    # --- 시나리오별 생성 --------------------------------------------------
    def build_person(self, pid, scenario):
        signals = []
        self.person.append({
            "person_id": pid,
            "age_group": self.r.choice(AGE),
            "gender": self.r.choice(["M", "F"]),
        })

        if scenario == "일반정상":
            self.normal_medical(pid)
            if self.r.random() < 0.25:
                offset = self.r.randrange(DAYS - 30)
                accident_id = self.minor_accident(pid, offset)
                # 정상 접촉 사고에도 대인 치료비 청구가 흔하다고 가정 (치료기간 5~20일).
                # 기존 데이터 순서를 바꾸지 않으려고 별도 난수를 씁니다.
                rr = random.Random(f"{SEED}-{pid}-정상치료")
                if rr.random() < 0.5:
                    self.add_auto(pid, accident_id, "대인치료비", offset + 6,
                                  rr.randrange(200000, 900000, 1000),
                                  hospital=self.hospital(), receipt=self.nid("RC"),
                                  treat=(offset + 1, offset + rr.randint(5, 20)))

        elif scenario == "정상분리청구":
            # 같은 사고지만 비용 항목과 기간이 겹치지 않는 정상 청구
            signals.append("사고-진료 연결(정상 분리)")
            offset = self.r.randrange(DAYS - 60)
            code, _, part, _ = self.r.choice(INJURY)
            hospital = self.hospital()
            accident_id = self.add_accident(pid, offset, self.r.choice(["추돌", "접촉"]))
            self.add_auto(pid, accident_id, "대물수리비", offset + 3,
                          self.r.randint(500000, 2200000))
            for k in range(self.r.randint(1, 3)):
                self.add_med(pid, offset + 2 + k * 9, code, "외래", hospital,
                             self.amount("외래"), receipt=self.nid("RC"), flag="상해")
            self.normal_medical(pid, count=self.r.randint(0, 2))

        elif scenario == "잦은정상진료":
            # 만성 질환으로 물리치료를 자주 받는 정상인 (규칙에 걸리는 정상)
            signals.append("진료 횟수/간격 (정상)")
            code = self.r.choice([k for k in DISEASE if k[2] in ("허리", "무릎")])[0]
            hospital, offset = self.hospital(), self.r.randrange(DAYS - 40)
            for k in range(self.r.randint(9, 14)):
                self.add_med(pid, offset + k * 2, code, "물리치료", hospital,
                             self.amount("물리치료"), receipt=self.nid("RC"))

        elif scenario in ("중복보상", "복합"):
            signals.append("중복 확실 (같은 영수증 양쪽 지급)")
            offset = self.r.randrange(DAYS - 60)
            code, _, part, _ = self.r.choice(INJURY)
            hospital, receipt = self.hospital(), self.nid("RC")
            amount = self.amount("외래")
            accident_id = self.add_accident(pid, offset, self.r.choice(["추돌", "접촉"]))
            self.add_auto(pid, accident_id, "대물수리비", offset + 3,
                          self.r.randint(500000, 2000000))
            self.add_auto(pid, accident_id, "대인치료비", offset + 5, amount,
                          hospital=hospital, receipt=receipt,
                          treat=(offset + 1, offset + random.Random(f"{SEED}-{pid}-치료").randint(12, 18)))
            self.add_med(pid, offset + 1, code, "외래", hospital, amount,
                         receipt=receipt, flag="상해")
            for k in range(self.r.randint(1, 3)):
                self.add_med(pid, offset + 4 + k * 3, code, "물리치료", hospital,
                             self.amount("물리치료"), receipt=self.nid("RC"), flag="상해")
            if scenario == "복합":
                signals.append("반복 경미사고")
                shop, counter = f"S{self.r.randint(1, 50):03d}", f"C{self.r.randint(1, 300):04d}"
                base = self.r.randrange(DAYS - 100)
                for k in range(3):
                    self.minor_accident(pid, base + k * self.r.randint(12, 26),
                                        counterparty=counter, shop=shop)

        elif scenario == "고지누락":
            signals.append("고지 확인 (사고 진료를 질병으로 청구)")
            offset = self.r.randrange(DAYS - 60)
            code = self.r.choice(INJURY)[0]
            hospital = self.hospital()
            accident_id = self.add_accident(pid, offset, self.r.choice(["추돌", "접촉", "단독"]))
            self.add_auto(pid, accident_id, "대물수리비", offset + 3,
                          self.r.randint(600000, 2400000))
            for k in range(self.r.randint(2, 4)):
                self.add_med(pid, offset + 2 + k * 5, code, "외래", hospital,
                             self.amount("외래"), receipt=self.nid("RC"), flag="질병")

        elif scenario == "반복경미사고":
            signals.append("사고 횟수/간격/반복 상대방")
            shop, counter = f"S{self.r.randint(1, 50):03d}", f"C{self.r.randint(1, 300):04d}"
            base = self.r.randrange(DAYS - 110)
            for k in range(self.r.randint(3, 4)):
                accident_id = self.minor_accident(
                    pid, base + k * self.r.randint(14, 28),
                    counterparty=counter, shop=shop)
            self.normal_medical(pid, count=self.r.randint(0, 2))

        elif scenario == "경미사고과잉진료":
            signals.append("경미 사고 후 과잉 진료")
            offset = self.r.randrange(DAYS - 60)
            code, _, part, _ = self.r.choice(INJURY)
            accident_id = self.add_accident(pid, offset, "접촉")
            self.add_auto(pid, accident_id, "대물수리비", offset + 3,
                          self.r.randint(300000, 900000))
            self.add_auto(pid, accident_id, "대인치료비", offset + 6,
                          self.r.randint(600000, 1500000),
                          hospital=self.hospital(), receipt=self.nid("RC"),
                          treat=(offset + 1, offset + random.Random(f"{SEED}-{pid}-치료").randint(24, 40)))
            for k in range(self.r.randint(9, 13)):
                self.add_med(pid, offset + 1 + k * 2, code,
                             self.r.choices(["물리치료", "외래"], [0.7, 0.3])[0],
                             self.hospital(),
                             self.amount("물리치료", high=self.r.random() < 0.4),
                             receipt=self.nid("RC"), flag="상해")

        return signals


def inject_missing_receipt(builder, count=8):
    """영수증 번호가 비어 중복 판정을 못 하는 사람을 소수 만듭니다 (판단 불가 검증용)."""
    targets, affected = [], []
    for row in builder.label:
        if row["scenario"] == "중복보상":
            targets.append(row["person_id"])
    for pid in targets[:count]:
        touched = False
        for claim in builder.med:
            if claim["person_id"] == pid and claim["accident_flag"] == "상해":
                claim["receipt_no"] = None
                touched = True
        for claim in builder.auto:
            if claim["person_id"] == pid:
                claim["receipt_no"] = None
        if touched:
            affected.append(pid)
            for row in builder.label:
                if row["person_id"] == pid:
                    row["injected_signals"] += ", 영수증 번호 결측"
    return affected


def main():
    builder = Builder()
    plan = []
    for name, ratio, suspicious in SCENARIOS:
        plan += [(name, suspicious)] * round(TOTAL_PEOPLE * ratio)
    plan = plan[:TOTAL_PEOPLE]
    while len(plan) < TOTAL_PEOPLE:
        plan.append(("일반정상", 0))
    builder.r.shuffle(plan)

    for index, (scenario, suspicious) in enumerate(plan, start=1):
        pid = f"P{index:04d}"
        signals = builder.build_person(pid, scenario)
        builder.label.append({
            "person_id": pid,
            "scenario": scenario,
            "is_suspicious": suspicious,
            "injected_signals": ", ".join(signals) if signals else "없음",
        })
    missing = inject_missing_receipt(builder)

    # --- SQLite 저장 ---
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    con = sqlite3.connect(DB_PATH)
    con.executescript(open(os.path.join(HERE, "schema.sql"), encoding="utf-8").read())
    con.executemany("INSERT INTO person VALUES (:person_id,:age_group,:gender)", builder.person)
    con.executemany("INSERT INTO kcd_master VALUES (?,?,?,?)", KCD)
    con.executemany(
        "INSERT INTO med_claim VALUES (:claim_id,:person_id,:visit_date,:claim_date,"
        ":disease_code,:treatment_type,:hospital_id,:receipt_no,:claim_amount,"
        ":paid_amount,:accident_flag)", builder.med)
    con.executemany(
        "INSERT INTO auto_accident VALUES (:accident_id,:person_id,:accident_date,"
        ":report_date,:accident_type,:role,:fault_ratio,:counterparty_id,"
        ":repair_shop_id)", builder.acc)
    con.executemany(
        "INSERT INTO auto_claim VALUES (:auto_claim_id,:accident_id,:person_id,"
        ":claim_type,:claim_date,:amount,:paid_amount,:hospital_id,:receipt_no,"
        ":treat_start,:treat_end)", builder.auto)
    con.executemany(
        "INSERT INTO scenario_label VALUES (:person_id,:scenario,:is_suspicious,"
        ":injected_signals)", builder.label)
    con.commit()
    con.close()

    # --- 화면용 JSON (정답표 제외) ---
    payload = {
        "generated": date.today().isoformat(),
        "seed": SEED,
        "kcd": [dict(zip(("disease_code", "disease_name", "body_part", "injury_flag"), k)) for k in KCD],
        "person": builder.person,
        "med_claim": builder.med,
        "auto_accident": builder.acc,
        "auto_claim": builder.auto,
    }
    os.makedirs(os.path.dirname(JSON_PATH), exist_ok=True)
    with open(JSON_PATH, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, separators=(",", ":"))

    # 정답표는 별도 파일로 둡니다. 화면의 "검증 결과" 탭에서만 읽고,
    # 위험도 계산에는 절대 넣지 않습니다.
    labels_path = os.path.join(os.path.dirname(JSON_PATH), "labels.json")
    with open(labels_path, "w", encoding="utf-8") as fp:
        json.dump({row["person_id"]: row for row in builder.label}, fp,
                  ensure_ascii=False, separators=(",", ":"))

    # 화면(브라우저의 SQLite)용 DB는 정답표 테이블을 뺀 복사본입니다.
    web_db = os.path.join(os.path.dirname(JSON_PATH), "insure.db")
    shutil.copyfile(DB_PATH, web_db)
    con = sqlite3.connect(web_db)
    con.execute("DROP TABLE scenario_label")
    con.commit()
    con.execute("VACUUM")
    con.close()

    counts = {}
    for row in builder.label:
        counts[row["scenario"]] = counts.get(row["scenario"], 0) + 1
    print(f"person {len(builder.person)}, med_claim {len(builder.med)}, "
          f"auto_accident {len(builder.acc)}, auto_claim {len(builder.auto)}")
    print("시나리오:", counts)
    print("영수증 결측 주입:", len(missing), "명")
    print("DB:", DB_PATH)
    print("화면용 DB:", web_db, f"{os.path.getsize(web_db)/1024:.0f}KB")
    print("JSON:", JSON_PATH, f"{os.path.getsize(JSON_PATH)/1024:.0f}KB")


if __name__ == "__main__":
    main()
