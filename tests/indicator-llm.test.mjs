import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { interpretOverview, checkEvidence } from '../indicator-llm.mjs';
const IE = createRequire(import.meta.url)('../dist/indicator-engine.js');

const evidence = IE.overviewEvidence({
  people: 500, risk: { 높음: 96, 보통: 56, 낮음: 340, '판단 불가': 8 },
  verdicts: [{ name: '중복 확실', people: 42 }, { name: '중복 의심', people: 30 }, { name: '고지 확인', people: 25 }, { name: '판정 불가', people: 8 }],
  signals: [{ name: '의료 · 진료 횟수', people: 60 }, { name: '자동차 · 사고 횟수', people: 120 }],
  months: [{ month: '2026-08', count: 200, total: 240000000 }, { month: '2026-09', count: 100, total: 150000000 }],
  dataThrough: '2026-09-30', medianAmount: 1010000,
});

const answer = (facts) => ({ facts, meaning: '위험도 높음 비율이 19.2%입니다.', causes: ['자동차 사고 신호가 많이 걸린 것은 반복 사고 때문일 수 있습니다.'], actions: ['신호가 많이 걸린 사람부터 근거를 확인하세요.'], uncertainty: '원인은 확정할 수 없습니다.' });
const GOOD = answer(['높음은 96명(19.2%)이고 9월 건수는 전월 대비 -50%입니다.']);
const WRONG = answer(['높음은 96명이고 의뢰 건수는 777건입니다.']);
/** 정해진 순서대로 답하는 가짜 LLM. 요청 내용은 seen 에 쌓는다. */
const fake = (...contents) => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = contents[Math.min(seen.length - 1, contents.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }] }) };
  };
  return { fetch, seen };
};

test('첫 시도에 숫자가 맞으면 그대로 쓰고, 로컬 모델 주소로 스키마와 /no_think를 보낸다', async () => {
  const { fetch, seen } = fake(GOOD);
  const out = await interpretOverview(evidence, { fetch });
  assert.equal(out.provider, 'api');
  assert.equal(out.attempts, 1);
  assert.deepEqual(out.verification, { ok: true, bad: [] });
  assert.equal(seen[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(seen[0].body.temperature, 0);
  assert.equal(seen[0].body.reasoning_effort, 'none'); // 생각 단계를 끈다(생각에 토큰을 다 써서 답이 비는 것을 막음)
  assert.equal(seen[0].body.response_format.json_schema.strict, true);
  assert.match(seen[0].body.messages[0].content, /no_think/);
  assert.match(seen[0].body.messages[1].content, /전체 500명, 위험도별 인원: 높음 96명\(19\.2%\)/);
  assert.ok(!seen[0].headers.Authorization);
});

test('숫자가 틀리면 틀린 숫자를 알려 주고 다시 쓰게 해서 통과하면 그 답을 쓴다', async () => {
  const { fetch, seen } = fake(WRONG, GOOD);
  const out = await interpretOverview(evidence, { fetch });
  assert.equal(out.provider, 'api');
  assert.equal(out.attempts, 2);
  assert.match(seen[1].body.messages[1].content, /이전 답변의 오류[\s\S]*표에 없는 숫자를 사용했습니다: 777/);
});

test('3번 모두 숫자가 틀리면 LLM 답을 버리고 provider:demo 로 돌려준다(화면이 기존 브리핑을 보여 줌)', async () => {
  const { fetch, seen } = fake(WRONG);
  const out = await interpretOverview(evidence, { fetch });
  assert.equal(seen.length, 3);
  assert.deepEqual(out, { provider: 'demo', replaced: true, attempts: 3, verification: { ok: false, bad: ['777'] } });
});

test('JSON이 아닌 답이나 <think> 구간이 섞인 답, 필수 항목이 빠진 답도 처리한다', async () => {
  assert.equal((await interpretOverview(evidence, { fetch: fake('표를 해석하겠습니다.', GOOD).fetch })).attempts, 2);
  assert.equal((await interpretOverview(evidence, { fetch: fake('<think>생각 중</think>' + JSON.stringify(GOOD)).fetch })).provider, 'api');
  assert.equal((await interpretOverview(evidence, { fetch: fake({ facts: ['x'] }, GOOD).fetch })).attempts, 2);
});

test('연결이 안 되면 오류를 던진다(서버가 provider:demo 로 전환)', async () => {
  await assert.rejects(() => interpretOverview(evidence, { fetch: async () => { throw Error('ECONNREFUSED'); } }), /ECONNREFUSED/);
  await assert.rejects(() => interpretOverview(evidence, { fetch: async () => ({ ok: false }) }), /LLM 연결 오류/);
});

test('LLM_MODE=demo 이면 LLM을 부르지 않는다', async () => {
  process.env.LLM_MODE = 'demo';
  try {
    const out = await interpretOverview(evidence, { fetch: async () => { throw Error('호출되면 안 됩니다'); } });
    assert.equal(out.provider, 'demo');
  } finally { delete process.env.LLM_MODE; }
});

test('근거 형식이 틀리면 LLM을 부르기 전에 형식 오류로 막는다', async () => {
  const never = async () => { throw Error('호출되면 안 됩니다'); };
  await assert.rejects(() => interpretOverview(null, { fetch: never }), /지표 형식 오류/);
  await assert.rejects(() => interpretOverview({ ...evidence, people: 0 }, { fetch: never }), /사람 수/);
  await assert.rejects(() => interpretOverview({ ...evidence, risk: [] }, { fetch: never }), /위험도는 4단계/);
  assert.throws(() => checkEvidence({ ...evidence, monthly: 'x' }), /monthly 목록이 없습니다/);
  assert.throws(() => checkEvidence({ ...evidence, monthly: Array(2000).fill({ month: '2026-01', claims: 1 }) }), /크기/);
});
