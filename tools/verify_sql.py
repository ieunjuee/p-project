"""엔진이 계산한 값을 SQL로 다시 계산해 일치하는지 확인합니다.

실행: python3 tools/verify_sql.py
JavaScript 엔진과 SQLite가 서로 다른 방식으로 같은 숫자를 내는지 보는 교차 검증입니다.
"""
import json
import os
import sqlite3
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "data", "insure.db")

DUMP = """
const E=require('./dist/person-engine.js');
const data=require('./dist/data/mock.json');
const out={};
for(const r of E.analyzeAll(data).results){
  const find=(a,id)=>r.signals[a].find(s=>s.id===id).observed;
  out[r.person_id]={
    risk:r.risk, overall:Math.round(r.scores.overall),
    medCount:find('med','med_count'), medHospital:find('med','med_hospital'),
    autoCount:find('auto','auto_count'),
    certain:r.cross.certain.length, overlap:r.cross.overlapAmount,
    disclosure:r.cross.disclosure.length, links:r.cross.links.length,
  };
}
process.stdout.write(JSON.stringify(out));
"""

# 같은 병명으로 30일 창 안의 최대 진료 횟수
# 창의 시작점은 청구 한 건(a.claim_id)입니다. 날짜로 묶으면 같은 날 청구가 여러 건일 때
# 짝의 수를 세어 과대 집계됩니다 (처음 작성 시 실제로 그 오류가 있었습니다).
SQL_MED_COUNT = """
SELECT person_id, MAX(n) FROM (
  SELECT a.person_id AS person_id, a.claim_id, COUNT(*) AS n
  FROM med_claim a JOIN med_claim b
    ON b.person_id=a.person_id AND b.disease_code=a.disease_code
   AND julianday(b.visit_date)-julianday(a.visit_date) BETWEEN 0 AND 29
  GROUP BY a.person_id, a.claim_id)
GROUP BY person_id"""

# 같은 병명으로 30일 창 안에 이용한 최대 병원 수
SQL_MED_HOSPITAL = """
SELECT person_id, MAX(n) FROM (
  SELECT a.person_id AS person_id, a.claim_id, COUNT(DISTINCT b.hospital_id) AS n
  FROM med_claim a JOIN med_claim b
    ON b.person_id=a.person_id AND b.disease_code=a.disease_code
   AND julianday(b.visit_date)-julianday(a.visit_date) BETWEEN 0 AND 29
  GROUP BY a.person_id, a.claim_id)
GROUP BY person_id"""

# 90일 창 안의 최대 사고 수
SQL_AUTO_COUNT = """
SELECT person_id, MAX(n) FROM (
  SELECT a.person_id AS person_id, a.accident_id, COUNT(*) AS n
  FROM auto_accident a JOIN auto_accident b
    ON b.person_id=a.person_id
   AND julianday(b.accident_date)-julianday(a.accident_date) BETWEEN 0 AND 89
  GROUP BY a.person_id, a.accident_id)
GROUP BY person_id"""

# 중복 확실: 같은 영수증 번호가 자동차 대인치료비와 의료에서 모두 지급된 건
SQL_CERTAIN = """
SELECT m.person_id, COUNT(*), SUM(MIN(ac.paid_amount, m.paid_amount))
FROM auto_accident a
JOIN auto_claim ac ON ac.accident_id=a.accident_id AND ac.claim_type='대인치료비'
JOIN med_claim m ON m.person_id=a.person_id AND m.receipt_no=ac.receipt_no
JOIN kcd_master k ON k.disease_code=m.disease_code AND k.injury_flag=1
WHERE julianday(m.visit_date)-julianday(a.accident_date) BETWEEN 0 AND 30
  AND ac.paid_amount>0 AND m.paid_amount>0 AND m.receipt_no IS NOT NULL
GROUP BY m.person_id"""

# 사고와 연결되는 손상 진료 건수 (교차 연결 수)
SQL_LINKS = """
SELECT m.person_id, COUNT(*)
FROM auto_accident a
JOIN med_claim m ON m.person_id=a.person_id
JOIN kcd_master k ON k.disease_code=m.disease_code AND k.injury_flag=1
WHERE julianday(m.visit_date)-julianday(a.accident_date) BETWEEN 0 AND 30
GROUP BY m.person_id"""


def main():
    if not os.path.exists(DB):
        sys.exit("data/insure.db가 없습니다. python3 data/build_db.py 를 먼저 실행하세요.")
    engine = json.loads(subprocess.run(
        ["node", "-e", DUMP], cwd=ROOT, capture_output=True, text=True, check=True).stdout)

    con = sqlite3.connect(DB)
    med_count = dict(con.execute(SQL_MED_COUNT).fetchall())
    med_hospital = dict(con.execute(SQL_MED_HOSPITAL).fetchall())
    auto_count = dict(con.execute(SQL_AUTO_COUNT).fetchall())
    links = dict(con.execute(SQL_LINKS).fetchall())
    certain, overlap = {}, {}
    for pid, n, total in con.execute(SQL_CERTAIN).fetchall():
        certain[pid] = n
        overlap[pid] = total
    con.close()

    checks = [
        ("진료 횟수 (같은 병명 30일 최대)", "medCount", med_count),
        ("병원 분산 (같은 병명 30일 최대)", "medHospital", med_hospital),
        ("사고 횟수 (90일 최대)", "autoCount", auto_count),
        ("중복 확실 건수", "certain", certain),
        ("교차 연결 건수", "links", links),
    ]
    failures, report = 0, []
    for title, key, table in checks:
        bad = []
        for pid, values in engine.items():
            expected = table.get(pid, 0) or 0
            actual = values[key] or 0
            if expected != actual:
                bad.append((pid, expected, actual))
        failures += len(bad)
        report.append((title, len(engine), len(bad), bad[:3]))

    # 겹친 금액은 중복 확실 건만 비교합니다 (중복 의심은 SQL 조건이 더 복잡해 제외).
    amount_bad = []
    for pid, values in engine.items():
        if certain.get(pid):
            if values["overlap"] < overlap[pid]:
                amount_bad.append((pid, overlap[pid], values["overlap"]))
    report.append(("중복 확실 겹친 금액 (SQL 합계 이상인지)", len(certain), len(amount_bad), amount_bad[:3]))
    failures += len(amount_bad)

    width = max(len(t) for t, *_ in report)
    print("SQL 교차 검증 결과")
    print("-" * (width + 28))
    for title, total, bad, samples in report:
        mark = "일치" if bad == 0 else f"불일치 {bad}건"
        print(f"{title.ljust(width)}  대상 {total:>4}  {mark}")
        for pid, expected, actual in samples:
            print(f"{'':{width}}    {pid}: SQL {expected} / 엔진 {actual}")
    print("-" * (width + 28))
    print("결론:", "모든 항목이 일치합니다." if failures == 0 else f"{failures}건이 어긋납니다.")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
