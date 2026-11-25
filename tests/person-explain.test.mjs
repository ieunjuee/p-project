import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { explainPerson } from '../person-llm.mjs';
const require = createRequire(import.meta.url);
const E = require('../dist/person-engine.js');
const data = require('../dist/data/mock.json');

// 가상 데이터에서 위험도 '높음'인 사람 한 명의 근거
const target = E.analyzeAll(data).results.find((r) => r.risk === '높음');
const evidence = E.evidence(target);

const good = (extra = {}) => ({
  summary: `위험도는 ${evidence.risk}이고 종합 점수는 ${evidence.scores.overall}점입니다.`,
  basis: [], causes: ['반복 진료가 치료 계획에 따른 것일 수 있습니다.'], checks: ['진료기록으로 치료 계획을 확인하세요.'], ...extra,
});
const wrong = good({ summary: '지급액은 987,654원입니다.' });
const fake = (...contents) => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(JSON.parse(init.body));
    const next = contents[Math.min(seen.length - 1, contents.length - 1)];
    // 문자열은 모델이 JSON이 아닌 글을 돌려준 경우를 흉내 내므로 그대로 보낸다
    return { ok: true, json: async () => ({ choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }] }) };
  };
  return { fetch, seen };
};

test('기본값은 실험에서 시험한 프롬프트와 스키마다(원인 후보 없음)', async () => {
  const { causes, ...tested } = good();
  const { fetch, seen } = fake(tested);
  const out = await explainPerson(evidence, { fetch });
  assert.equal(out.provider, 'api');
  assert.equal(out.attempts, 1);
  assert.equal(out.causes, undefined);
  const schema = seen[0].response_format.json_schema.schema;
  assert.deepEqual(schema.required, ['summary', 'basis', 'checks']);
  assert.ok(!('causes' in schema.properties));
  assert.match(seen[0].messages[0].content, /위험도와 함께 코드가 걸렸다고 판정한 지표의 이름을 모두/);
  assert.match(seen[0].messages[0].content, /나쁜 예: "진료 횟수 11회, 기준값 8회"/);
  assert.ok(!seen[0].messages[0].content.includes('원인 후보(causes)'));
  assert.match(seen[0].messages[0].content, /no_think/); // 시스템 메시지 끝의 /no_think도 그대로
  assert.equal(seen[0].reasoning_effort, 'none');
});

test('LLM_EXPLAIN_CAUSES=1 이면 원인 후보를 요청하고 스키마에서도 필수다', async () => {
  process.env.LLM_EXPLAIN_CAUSES = '1';
  try {
    const { fetch, seen } = fake(good());
    const out = await explainPerson(evidence, { fetch });
    assert.equal(out.provider, 'api');
    assert.deepEqual(out.causes, ['반복 진료가 치료 계획에 따른 것일 수 있습니다.']);
    const schema = seen[0].response_format.json_schema.schema;
    assert.deepEqual(schema.required, ['summary', 'basis', 'causes', 'checks']);
    assert.match(seen[0].messages[0].content, /원인 후보\(causes\)/);
    assert.match(seen[0].messages[0].content, /위험도와 함께 코드가 걸렸다고 판정한 지표의 이름을 모두/); // 시험한 문구도 함께 들어 있다
  } finally { delete process.env.LLM_EXPLAIN_CAUSES; }
});

test('숫자가 틀리면 틀린 값을 알려 주고 다시 쓰게 해서 통과하면 그 답을 쓴다', async () => {
  const { fetch, seen } = fake(wrong, good());
  const out = await explainPerson(evidence, { fetch });
  assert.equal(out.provider, 'api');
  assert.equal(out.attempts, 2);
  assert.match(seen[1].messages[1].content, /이전 답변의 오류[\s\S]*987,654/);
});

test('3번 모두 틀리면 LLM 답을 버리고 데모 설명으로 대체한다', async () => {
  const { fetch, seen } = fake(wrong);
  const out = await explainPerson(evidence, { fetch });
  assert.equal(seen.length, 3);
  assert.equal(out.provider, 'demo');
  assert.equal(out.replaced, true);
  assert.equal(out.verification.ok, false);
});

test('생각을 끄는 옵션을 보내고, JSON을 읽지 못하면 다시 쓰게 한다', async () => {
  const { fetch, seen } = fake('죄송합니다, 설명하겠습니다.', good());
  const out = await explainPerson(evidence, { fetch });
  assert.equal(seen[0].reasoning_effort, 'none');
  assert.equal(out.provider, 'api');
  assert.equal(out.attempts, 2);
  assert.match(seen[1].messages[1].content, /JSON 형식으로 읽을 수 없었습니다/);
});

test('3번 모두 JSON을 읽지 못하면 데모 설명으로 대체한다(오류로 끝나지 않는다)', async () => {
  const out = await explainPerson(evidence, { fetch: fake('').fetch }); // 빈 답(생각에 토큰을 다 쓴 경우)
  assert.equal(out.provider, 'demo');
  assert.equal(out.replaced, true);
  assert.equal(out.verification.ok, false);
});

test('원인 후보가 문자열 목록이 아니면 형식 오류', async () => {
  await assert.rejects(() => explainPerson(evidence, { fetch: fake(good({ causes: [1, 2] })).fetch }), /형식/);
});
