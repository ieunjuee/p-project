const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../dist/person-engine.js');
const S = require('../dist/person-sql.js');
const data = require('../dist/data/mock.json');

// SQL 계산(sql.js)이 JS 계산과 사람 전원에게 같은 결과를 내는지 확인합니다.
// 근거 번호의 나열 순서만 정렬해서 비교합니다.
const normalize = (r) => {
  const copy = JSON.parse(JSON.stringify({ ...r, config: undefined }));
  for (const area of ['med', 'auto']) for (const s of copy.signals[area]) s.evidence.sort();
  return copy;
};
async function openDb() {
  const SQL = await require('sql.js')();
  return new SQL.Database(fs.readFileSync(path.join(__dirname, '../dist/data/insure.db')));
}
const settings = [
  {},
  { medVisitCount: 5, costPercentile: 0.9, amountTolerance: 0.2, crossWindowDays: 14, priorDays: 30, minPeers: 5, repeatCount: 3 },
];

for (const cfg of settings) {
  test(`SQL 계산은 JS 계산과 사람 전원에게 같은 결과 ${JSON.stringify(cfg)}`, async () => {
    const db = await openDb();
    const js = E.analyzeAll(JSON.parse(JSON.stringify(data)), cfg);
    const sql = S.analyzeAllSql(db, cfg);
    assert.equal(sql.results.length, js.results.length);
    assert.equal(sql.results.length, 500);
    assert.deepEqual(sql.summary, js.summary);
    const bad = [];
    js.results.forEach((r, i) => {
      if (JSON.stringify(normalize(r)) !== JSON.stringify(normalize(sql.results[i]))) bad.push(r.person_id);
    });
    assert.deepEqual(bad, []);
  });
}

test('화면용 DB에는 정답표 테이블이 없다', async () => {
  const db = await openDb();
  const names = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values.flat();
  assert.ok(!names.includes('scenario_label'));
  assert.ok(names.includes('med_claim'));
});
