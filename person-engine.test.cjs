const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../dist/person-engine.js');

const kcd = [
  { disease_code: 'S33', disease_name: '요추 염좌', body_part: '허리', injury_flag: 1 },
  { disease_code: 'M54', disease_name: '요통', body_part: '허리', injury_flag: 0 },
];
const med = (claim_id, visit_date, extra = {}) => ({
  claim_id, person_id: 'P1', visit_date, claim_date: visit_date,
  disease_code: 'M54', treatment_type: '물리치료', hospital_id: 'H1',
  receipt_no: 'R' + claim_id, claim_amount: 100000, paid_amount: 100000,
  accident_flag: '질병', ...extra,
});
const accident = (accident_id, accident_date, extra = {}) => ({
  accident_id, person_id: 'P1', accident_date, report_date: accident_date,
  accident_type: '접촉', role: '피해', fault_ratio: 0,
  counterparty_id: 'C1', repair_shop_id: 'S1', ...extra,
});
const autoClaim = (auto_claim_id, accident_id, claim_type, claim_date, extra = {}) => ({
  auto_claim_id, accident_id, person_id: 'P1', claim_type, claim_date,
  amount: 100000, paid_amount: 100000, hospital_id: null, receipt_no: null,
  treat_start: null, treat_end: null, ...extra,
});
const build = (parts = {}) => ({
  kcd, person: [{ person_id: 'P1', age_group: '40대', gender: 'M' }],
  med_claim: parts.med_claim || [], auto_accident: parts.auto_accident || [],
  auto_claim: parts.auto_claim || [],
});
const run = (parts, settings) => E.analyzePerson('P1', build(parts), settings);
const signal = (result, area, id) => result.signals[area].find((s) => s.id === id);

test('없는 사람 번호는 오류', () => {
  assert.throws(() => E.analyzePerson('P9', build()), /등록되지 않은/);
});

test('기록이 없으면 위험도는 낮음', () => {
  const r = run({});
  assert.equal(r.risk, '낮음');
  assert.equal(r.scores.overall, 0);
  assert.equal(r.cross.links.length, 0);
});

test('진료 횟수는 30일 창 안에서만 센다', () => {
  const inside = Array.from({ length: 8 }, (_, i) => med('M' + i, `2026-03-${String(i * 3 + 1).padStart(2, '0')}`));
  assert.equal(signal(run({ med_claim: inside }), 'med', 'med_count').hit, true);
  const spread = Array.from({ length: 8 }, (_, i) => med('M' + i, `2026-0${1 + i % 9}-05`));
  assert.equal(signal(run({ med_claim: spread }), 'med', 'med_count').hit, false);
});

test('진료 간격은 최소 건수 미만이면 평가를 보류한다', () => {
  const two = [med('M1', '2026-03-01'), med('M2', '2026-03-02')];
  const s = signal(run({ med_claim: two }), 'med', 'med_gap');
  assert.equal(s.observed, null);
  assert.equal(s.hit, false);
  const three = [...two, med('M3', '2026-03-03')];
  assert.equal(signal(run({ med_claim: three }), 'med', 'med_gap').hit, true);
});

test('반복 청구는 같은 영수증 또는 같은 날 같은 금액을 잡는다', () => {
  const sameReceipt = [med('M1', '2026-03-01', { receipt_no: 'R9' }), med('M2', '2026-04-20', { receipt_no: 'R9' })];
  assert.equal(signal(run({ med_claim: sameReceipt }), 'med', 'med_repeat').hit, true);
  const sameDay = [med('M1', '2026-03-01', { receipt_no: null }), med('M2', '2026-03-01', { receipt_no: null })];
  assert.equal(signal(run({ med_claim: sameDay }), 'med', 'med_repeat').hit, true);
});

test('같은 영수증이 양쪽에서 지급되면 점수와 상관없이 높음', () => {
  const r = run({
    med_claim: [med('M1', '2026-03-02', { disease_code: 'S33', receipt_no: 'RC1', accident_flag: '상해' })],
    auto_accident: [accident('A1', '2026-03-01')],
    auto_claim: [autoClaim('AC1', 'A1', '대인치료비', '2026-03-05',
      { hospital_id: 'H1', receipt_no: 'RC1', treat_start: '2026-03-01', treat_end: '2026-03-10' })],
  });
  assert.equal(r.cross.certain.length, 1);
  assert.equal(r.risk, '높음');
  assert.equal(r.scores.overall, 0); // 걸린 지표가 없어도(점수 0) 중복 확실이면 높음
  assert.equal(r.cross.overlapAmount, 100000);
});

test('영수증이 양쪽 모두 비면 판단 불가', () => {
  const r = run({
    med_claim: [med('M1', '2026-03-02', { disease_code: 'S33', receipt_no: null, accident_flag: '상해' })],
    auto_accident: [accident('A1', '2026-03-01')],
    auto_claim: [autoClaim('AC1', 'A1', '대인치료비', '2026-03-05',
      { hospital_id: 'H1', receipt_no: null, treat_start: '2026-03-01', treat_end: '2026-03-10' })],
  });
  assert.equal(r.risk, '판단 불가');
});

test('사고 진료를 질병으로 청구하면 고지 확인으로 보통', () => {
  const r = run({
    med_claim: [med('M1', '2026-03-02', { disease_code: 'S33', accident_flag: '질병' })],
    auto_accident: [accident('A1', '2026-03-01', { accident_type: '추돌' })],
    auto_claim: [autoClaim('AC1', 'A1', '대물수리비', '2026-03-04')],
  });
  assert.equal(r.cross.disclosure.length, 1);
  assert.equal(r.risk, '보통');
});

test('사고 전 90일 안 같은 부위 진료는 기왕증으로 표시', () => {
  const r = run({
    med_claim: [med('M0', '2026-01-20'), med('M1', '2026-03-02', { disease_code: 'S33', accident_flag: '상해' })],
    auto_accident: [accident('A1', '2026-03-01', { accident_type: '추돌' })],
    auto_claim: [autoClaim('AC1', 'A1', '대물수리비', '2026-03-04')],
  });
  assert.equal(r.cross.prior.length, 1);
  assert.deepEqual(r.cross.prior[0].prior, ['M0']);
});

test('사고가 연결되지 않으면 교차 확인 대상이 아니다', () => {
  const r = run({
    med_claim: [med('M1', '2026-05-10', { disease_code: 'S33', accident_flag: '상해' })],
    auto_accident: [accident('A1', '2026-03-01')],
    auto_claim: [autoClaim('AC1', 'A1', '대물수리비', '2026-03-04')],
  });
  assert.equal(r.cross.links.length, 0);
});

test('점수는 걸린 지표 수에 비례하고 두 영역 중 큰 값을 쓴다', () => {
  const r = run({
    auto_accident: [accident('A1', '2026-03-01', { counterparty_id: 'C7' }),
      accident('A2', '2026-03-20', { counterparty_id: 'C7' }),
      accident('A3', '2026-04-05', { counterparty_id: 'C7' })],
    auto_claim: [],
  });
  assert.equal(r.hits.auto.length, 3); // 횟수, 간격, 반복 청구
  assert.equal(r.scores.auto, 60);
  assert.equal(r.scores.med, 0);
  assert.equal(r.scores.overall, 60);
  assert.equal(r.risk, '높음');
});

test('설명 검증기는 지어낸 수치와 번호를 잡는다', () => {
  const r = run({ med_claim: [med('M1', '2026-03-01')] });
  const e = E.evidence(r);
  assert.equal(E.verifyExplanation(e, E.demoExplain(e)).ok, true);
  const fake = { summary: '점수는 77점입니다.', basis: ['청구 M99999에서 확인했습니다.'], checks: [] };
  const bad = E.verifyExplanation(e, fake);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.badIds, ['M99999']);
  assert.ok(bad.badNumbers.includes('77'));
  // 코드가 정한 결정과 다른 결과 제안 이름을 쓰면 무효 처리합니다.
  const wrongTerm = E.verifyExplanation(e, { summary: e.decision === '지급 보류' ? '지급 정지 사유입니다.' : '지급 보류 사유입니다.', basis: [], checks: [] });
  assert.equal(wrongTerm.ok, false);
  assert.equal(wrongTerm.badTerms.length, 1);
});

test('접촉 사고 치료기간이 비교 집단 상위 5%면 치료 기간 지표가 걸린다', () => {
  const accidents = [], claims = [];
  for (let i = 0; i < 20; i++) {
    const id = 'A' + i;
    accidents.push({ ...accident(id, '2026-03-01'), person_id: 'P' + i });
    claims.push({ ...autoClaim('AC' + i, id, '대인치료비', '2026-03-05', { treat_start: '2026-03-01', treat_end: i === 0 ? '2026-04-10' : '2026-03-10' }), person_id: 'P' + i });
  }
  const results = E.analyzeAll({
    person: accidents.map((a) => ({ person_id: a.person_id, age_group: '20대', gender: 'M' })),
    kcd: [], med_claim: [], auto_accident: accidents, auto_claim: claims,
  }).results;
  const hit = (pid) => results.find((r) => r.person_id === pid).signals.auto.find((x) => x.id === 'auto_treat').hit;
  assert.equal(hit('P0'), true);   // 41일
  assert.equal(hit('P1'), false);  // 10일
});

test('지급 판단 3결과: 낮음은 지급, 중복 확실은 정지 권고, 나머지는 보류', () => {
  assert.equal(E.decision(run({})), '지급');
  const certain = run({
    med_claim: [med('M1', '2026-03-02', { disease_code: 'S33', receipt_no: 'RC1', accident_flag: '상해' })],
    auto_accident: [accident('A1', '2026-03-01')],
    auto_claim: [autoClaim('AC1', 'A1', '대인치료비', '2026-03-05', { hospital_id: 'H1', receipt_no: 'RC1', treat_start: '2026-03-01', treat_end: '2026-03-10' })],
  });
  assert.equal(E.decision(certain), '지급 정지 권고');
  const disclosure = run({
    med_claim: [med('M1', '2026-03-02', { disease_code: 'S33', accident_flag: '질병' })],
    auto_accident: [accident('A1', '2026-03-01', { accident_type: '추돌' })],
    auto_claim: [autoClaim('AC1', 'A1', '대물수리비', '2026-03-04')],
  });
  assert.equal(E.decision(disclosure), '지급 보류');
});

test('질문 답변, 증빙 요청서, 판단 불가 보완은 근거에 없는 수치를 만들지 않는다', () => {
  const unknown = run({
    med_claim: [med('M1', '2026-03-02', { disease_code: 'S33', receipt_no: null, accident_flag: '상해' })],
    auto_accident: [accident('A1', '2026-03-01')],
    auto_claim: [autoClaim('AC1', 'A1', '대인치료비', '2026-03-05', { hospital_id: 'H1', receipt_no: null, treat_start: '2026-03-01', treat_end: '2026-03-10' })],
  });
  const e = E.evidence(unknown);
  for (const q of ['왜 보류인가요?', '정상일 수 있는 이유는?', '무엇을 확인해야 하나요?', '점수는 어떻게 계산했나요?']) {
    const a = E.demoAsk(e, q);
    assert.ok(a.answer.length > 0);
    assert.equal(E.verifyExplanation(e, a).ok, true, q);
  }
  const req = E.demoRequest(e);
  assert.ok(req.documents.includes('빠진 영수증 사본'));
  assert.equal(E.verifyExplanation(e, req).ok, true);
  const gap = E.demoGap(e);
  assert.equal(gap.missing.length, 1);
  assert.equal(E.verifyExplanation(e, gap).ok, true);
  // 지어낸 수치는 걸러진다
  assert.equal(E.verifyExplanation(e, { answer: '청구액은 987,654원입니다.' }).ok, false);
});

test('지급 건에는 증빙 요청서를 만들지 않고, 판단 불가가 아니면 보완할 내용이 없다', () => {
  const e = E.evidence(run({}));
  assert.deepEqual(E.demoRequest(e).documents, []);
  assert.deepEqual(E.demoGap(e).missing, []);
});


test('증빙 요청서는 제목, 인사, 서류별 사유, 끝인사가 있는 이메일 형식이다', () => {
  const e = E.evidence(run({
    med_claim: [med('M1', '2026-03-02', { disease_code: 'S33', receipt_no: null, accident_flag: '상해' })],
    auto_accident: [accident('A1', '2026-03-01')],
    auto_claim: [autoClaim('AC1', 'A1', '대인치료비', '2026-03-05', { hospital_id: 'H1', receipt_no: null, treat_start: '2026-03-01', treat_end: '2026-03-10' })],
  }));
  const req = E.demoRequest(e);
  assert.ok(req.subject.length > 0);
  assert.equal(req.reasons.length, req.documents.length);
  assert.match(req.message, /^안녕하세요\./);
  assert.match(req.message, /\[ 요청 서류 \]\n① /);
  assert.match(req.message, /감사합니다\.$/);
  assert.ok(!/의심|사기|위험도|점수/.test(req.message));
});
