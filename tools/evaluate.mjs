/* 가상 데이터 정답표와 비교한 성능을 출력합니다.
 * 실행: node tools/evaluate.mjs
 * 정답표(scenario_label)는 SQLite에서만 읽고 화면 데이터에는 넣지 않습니다. */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const E = require(path.join(root, 'dist', 'person-engine.js'));
const data = require(path.join(root, 'dist', 'data', 'mock.json'));

const db = new DatabaseSync(path.join(root, 'data', 'insure.db'));
const labels = {};
for (const row of db.prepare('SELECT * FROM scenario_label').all()) labels[row.person_id] = row;

const started = Date.now();
const analysis = E.analyzeAll(data);
const elapsed = Date.now() - started;
const result = E.evaluate(analysis.results, labels);

console.log(`대상 ${result.n}명 · 계산 ${elapsed}ms (1명당 ${(elapsed / result.n).toFixed(1)}ms)`);
console.log('위험도 분포:', analysis.summary);
console.log('');
console.log('"높음" 예측 기준');
console.log(`  정밀도 ${result.precision.toFixed(3)} · 재현율 ${result.recall.toFixed(3)} · F1 ${result.f1.toFixed(3)}`);
console.log(`  TP ${result.tp} / FP ${result.fp} / FN ${result.fn} / TN ${result.tn}`);
console.log(`  위험한 사람을 "낮음"으로 보낸 건수: ${result.fastTrackMiss}건 (안전 지표, 0이어야 함)`);
console.log('');
console.log('시나리오별 분류');
const width = Math.max(...Object.keys(result.byScenario).map((k) => k.length));
for (const [name, row] of Object.entries(result.byScenario).sort((a, b) => b[1].n - a[1].n)) {
  const suspicious = labels[analysis.results.find((r) => labels[r.person_id].scenario === name).person_id].is_suspicious;
  console.log(`  ${name.padEnd(width)} ${String(row.n).padStart(4)}명 [${suspicious ? '위험' : '정상'}]`
    + ` 높음 ${String(row['높음']).padStart(3)} · 보통 ${String(row['보통']).padStart(3)}`
    + ` · 낮음 ${String(row['낮음']).padStart(3)} · 판단 불가 ${String(row['판단 불가']).padStart(3)}`);
}
console.log('');
console.log('해석: 이 숫자는 우리가 만든 가상 데이터에 대한 결과이며 실제 탐지 성능이 아닙니다.');
console.log('      정상인데 "높음"으로 분류된 사람(FP)과 위험한데 "낮음"인 사람을 함께 보세요.');
