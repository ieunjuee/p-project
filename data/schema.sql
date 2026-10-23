PRAGMA foreign_keys = ON;

-- person: 계산에는 안 쓰고 대시보드 프로필 표시용 (age_group, gender)
CREATE TABLE person (
    person_id       TEXT PRIMARY KEY,
    age_group       TEXT,
    gender          TEXT CHECK (gender IN ('M','F'))
);

CREATE TABLE kcd_master (
    disease_code    TEXT PRIMARY KEY,
    disease_name    TEXT NOT NULL,
    body_part       TEXT,
    injury_flag     INTEGER NOT NULL CHECK (injury_flag IN (0,1))
);

-- claim_date: 대시보드 표시용
CREATE TABLE med_claim (
    claim_id        TEXT PRIMARY KEY,
    person_id       TEXT NOT NULL REFERENCES person(person_id),
    visit_date      TEXT NOT NULL,
    claim_date      TEXT NOT NULL,
    disease_code    TEXT NOT NULL REFERENCES kcd_master(disease_code),
    treatment_type  TEXT NOT NULL CHECK (treatment_type IN ('외래','입원','물리치료')),
    hospital_id     TEXT NOT NULL,
    receipt_no      TEXT,
    claim_amount    INTEGER NOT NULL,
    paid_amount     INTEGER NOT NULL DEFAULT 0,
    accident_flag   TEXT NOT NULL CHECK (accident_flag IN ('상해','질병'))
);

-- report_date, role, fault_ratio: 대시보드 표시용
CREATE TABLE auto_accident (
    accident_id     TEXT PRIMARY KEY,
    person_id       TEXT NOT NULL REFERENCES person(person_id),
    accident_date   TEXT NOT NULL,
    report_date     TEXT NOT NULL,
    accident_type   TEXT NOT NULL CHECK (accident_type IN ('접촉','추돌','단독','보행자')),
    role            TEXT NOT NULL CHECK (role IN ('가해','피해')),
    fault_ratio     INTEGER CHECK (fault_ratio BETWEEN 0 AND 100),
    counterparty_id TEXT,
    repair_shop_id  TEXT
);

-- claim_date: 대시보드 표시용
CREATE TABLE auto_claim (
    auto_claim_id   TEXT PRIMARY KEY,
    accident_id     TEXT NOT NULL REFERENCES auto_accident(accident_id),
    person_id       TEXT NOT NULL REFERENCES person(person_id),
    claim_type      TEXT NOT NULL CHECK (claim_type IN ('대물수리비','대인치료비','자차')),
    claim_date      TEXT NOT NULL,
    amount          INTEGER NOT NULL,
    paid_amount     INTEGER NOT NULL DEFAULT 0,
    hospital_id     TEXT,
    receipt_no      TEXT,
    treat_start     TEXT,
    treat_end       TEXT
);

CREATE TABLE scenario_label (
    person_id        TEXT PRIMARY KEY REFERENCES person(person_id),
    scenario         TEXT NOT NULL CHECK (scenario IN (
                        '일반정상','정상분리청구','잦은정상진료',
                        '중복보상','고지누락','반복경미사고','경미사고과잉진료','복합')),
    is_suspicious    INTEGER NOT NULL CHECK (is_suspicious IN (0,1)),
    injected_signals TEXT
);

CREATE INDEX idx_med_person_date   ON med_claim(person_id, visit_date);
CREATE INDEX idx_med_receipt       ON med_claim(receipt_no);
CREATE INDEX idx_acc_person_date   ON auto_accident(person_id, accident_date);
CREATE INDEX idx_auto_person       ON auto_claim(person_id);
CREATE INDEX idx_auto_receipt      ON auto_claim(receipt_no);
