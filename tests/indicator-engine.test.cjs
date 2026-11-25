const { test } = require('node:test');
const assert = require('node:assert/strict');
const IE = require('../dist/indicator-engine.js');

// 분석 개요 화면이 모으는 입력과 같은 모양의 작은 예시
const input = {
  people: 500,
  risk: { 높음: 96, 보통: 56, 낮음: 340, '판단 불가': 8 },
  verdicts: [{ name: '중복 확실', people: 42 }, { name: '중복 의심', people: 30 }, { name: '고지 확인', people: 25 }, { name: '판정 불가', people: 8 }],
  signals: [{ name: '의료 · 진료 횟수', people: 60 }, { name: '자동차 · 사고 횟수', people: 120 }],
  months: [{ month: '2026-08', count: 200, total: 200 * 1200000 }, { month: '2026-09', count: 100, total: 100 * 1500000 }, { month: '2026-10', count: 22, total: 22 * 1500000 }],
  dataThrough: '2026-10-09',
  medianAmount: 1010000,
};
const evidence = IE.overviewEvidence(input);

test('코드가 비율, 월별 증감, 평균 금액(만원)을 계산한다', () => {
  assert.deepEqual(evidence.risk.map((r) => [r.level, r.people, r.pct]), [['높음', 96, 19.2], ['보통', 56, 11.2], ['낮음', 340, 68], ['판단 불가', 8, 1.6]]);
  assert.equal(evidence.verdicts[0].pct, 8.4);
  assert.deepEqual(evidence.signals.map((s) => s.name), ['자동차 · 사고 횟수', '의료 · 진료 횟수']); // 많은 순
  const [aug, sep] = evidence.monthly;
  assert.equal(aug.avg_amount_man, 120);
  assert.equal(aug.claims_change_pct, null);                 // 첫 달은 전월이 없다
  assert.equal(sep.claims_change_pct, -50);                  // 200 -> 100
  assert.equal(sep.avg_amount_change_pct, 25);               // 120만원 -> 150만원
  assert.equal(evidence.median_claim_amount_man, 101);
});

test('데이터가 달 중간에서 끝나면 그 달만 진행 중(partial)으로 표시한다', () => {
  assert.deepEqual(evidence.monthly.map((m) => m.partial), [false, false, true]);
  const full = IE.overviewEvidence({ ...input, dataThrough: '2026-10-31' });
  assert.equal(full.monthly[2].partial, false);
});

test('프롬프트에는 코드가 계산한 수치와 과잉 해석 방지 문장이 들어가고, 오류 피드백은 있을 때만 붙는다', () => {
  const p = IE.buildPrompt(evidence, null);
  assert.match(p, /전체 500명, 위험도별 인원: 높음 96명\(19\.2%\)/);
  assert.match(p, /중복 확실 42명\(8\.4%\)/);
  assert.match(p, /2026-09: 100건, 150만원, -50%, \+25%/);
  assert.match(p, /2026-10: .*\(이 달은 진행 중이라 건수가 적습니다\)/);
  assert.match(p, /특이하지 않은 항목에는 원인과 조치를 쓰지 마세요/);
  assert.match(p, /원인은 확정하지 말고 '원인 후보'로/);
  assert.ok(!p.includes('이전 답변의 오류'));
  assert.match(IE.buildPrompt(evidence, '표에 없는 숫자를 사용했습니다: 777'), /이전 답변의 오류[\s\S]*777/);
});

const answer = (facts) => ({ facts, meaning: '', causes: [], actions: [], uncertainty: '' });

test('숫자 검사: 근거에 있는 숫자와 반올림은 통과, 지어낸 숫자는 걸러 낸다', () => {
  assert.deepEqual(IE.validateNumbers(answer(['높음은 96명(19.2%)이고 약 19%입니다.', '9월 건수는 전월 대비 -50% 줄었습니다.']), evidence), []);
  assert.deepEqual(IE.validateNumbers(answer(['높음은 96명이고 의뢰 건수는 777건입니다.']), evidence), ['777']);
  assert.deepEqual(IE.validateNumbers(answer(['중복 확실은 99명입니다.']), evidence), ['99']); // '명'이 붙은 숫자도 검사
});

test('숫자 검사: 날짜, 월, 개월, 개수 표현, 천 단위 쉼표는 오탐으로 보지 않는다', () => {
  const ok = answer(['2026-09-30 기준 9월에는 3개 신호가 많았고, 3개월 추이를 봅니다.', '청구는 1,200건이 아니라 100건입니다.']);
  assert.deepEqual(IE.validateNumbers(ok, evidence), ['1200']); // 1,200은 근거에 없으므로 하나의 숫자로 읽혀 걸린다
  assert.deepEqual(IE.validateNumbers(answer(['2026-09 기준 9월의 3개 신호, 2가지 조치']), evidence), []);
});

test('숫자 검사: provider 같은 문자열이 아닌 항목은 보지 않는다', () => {
  assert.deepEqual(IE.validateNumbers({ provider: 'api', attempts: 3, facts: [], meaning: '', causes: [], actions: [], uncertainty: '' }, evidence), []);
});
