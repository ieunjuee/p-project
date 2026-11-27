"""검증용 데이터를 seed 여러 개로 만들어 "높음" 예측 성능의 평균과 편차를 냅니다.

실행: python tools/eval_seeds.py            (기본: seed 5개, 2,000명, 위험 비율 5%)
      python tools/eval_seeds.py --seeds 20261120 20261121 --people 1000 --fraud-rate 0.05
      python tools/eval_seeds.py --stress   (함정 정상·기준 밖 위험 유형을 더한 경계 시험)
결과 데이터는 data/test_seeds/<seed>/ 에 만들어지며 커밋하지 않습니다.
"""
import argparse
import os
import re
import statistics
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LINE = re.compile(r"정밀도 ([\d.]+) · 재현율 ([\d.]+) · F1 ([\d.]+)")
MISS = re.compile(r'"낮음"으로 보낸 건수: (\d+)건')
ADJ = re.compile(r"환산한 정밀도 ([\d.]+)")
CHECK = re.compile(r"위험 사례 중 확인 대상 ([\d.]+)% · 정상 사례 중 확인 대상\(심사 부담\) ([\d.]+)%")


def run(cmd):
    # Windows 기본 인코딩(cp949)이 아니라 UTF-8로 읽어야 한글 출력이 깨지지 않음
    # 자식 Python(build_db.py)도 UTF-8로 출력하게 함
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                          env={**os.environ, "PYTHONUTF8": "1"}, check=True).stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, nargs="+", default=[20261120 + i for i in range(5)])
    ap.add_argument("--people", type=int, default=2000)
    ap.add_argument("--fraud-rate", type=float, default=0.05)
    ap.add_argument("--stress", action="store_true", help="경계 시험 데이터로 평가")
    args = ap.parse_args()

    rows = []
    for seed in args.seeds:
        out = os.path.join("data", "test_seeds", ("stress-" if args.stress else "") + str(seed))
        run([sys.executable, "data/build_db.py", "--seed", str(seed), "--people", str(args.people),
             "--fraud-rate", str(args.fraud_rate), "--out", out] + (["--stress"] if args.stress else []))
        text = run(["node", "tools/evaluate.mjs", out])
        m, miss, adj, chk = LINE.search(text), MISS.search(text), ADJ.search(text), CHECK.search(text)
        if not (m and miss and adj and chk):
            sys.exit(f"seed {seed}: evaluate.mjs 출력에서 성능 줄을 찾지 못했습니다.\n{text}")
        rows.append([float(x) for x in m.groups()] + [int(miss.group(1)), float(adj.group(1)),
                                                      float(chk.group(1)), float(chk.group(2))])
        print(f"seed {seed}: 정밀도 {rows[-1][0]:.3f} · 재현율 {rows[-1][1]:.3f} · F1 {rows[-1][2]:.3f}"
              f" · 위험한데 낮음 {rows[-1][3]}건")

    print(f"\n{len(rows)}개 seed, {args.people}명, 위험 비율 {args.fraud_rate:.0%}" + (" · 경계 시험" if args.stress else ""))
    names = ["정밀도", "재현율", "F1", "위험한데 낮음(건)", "위험 5% 환산 정밀도",
             "위험 중 확인 대상(%)", "정상 중 확인 대상(%)"]
    for i, name in enumerate(names):
        vals = [r[i] for r in rows]
        sd = statistics.stdev(vals) if len(vals) > 1 else 0.0
        print(f"  {name}: 평균 {statistics.mean(vals):.3f} · 표준편차 {sd:.3f} · 범위 {min(vals):.3f}~{max(vals):.3f}")


if __name__ == "__main__":
    main()
