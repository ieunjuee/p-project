import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assistPerson } from '../person-llm.mjs';
const E = createRequire(import.meta.url)('../dist/person-engine.js');

const data = {
  kcd: [{ disease_code: 'S33', disease_name: '요추 염좌', body_part: '허리', injury_flag: 1 }],
  person: [{ person_id: 'P1', age_group: '40대', gender: 'M' }],
  med_claim: [], auto_accident: [], auto_claim: [],
};
const evidence = E.evidence(E.analyzePerson('P1', data));
const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });

test('LLM_MODE=demo 이면 LLM을 부르지 않고 데모 응답을 돌려준다', async () => {
  process.env.LLM_MODE = 'demo';
  try {
    const a = await assistPerson('ask', evidence, '왜 보류인가요?', { fetch: async () => { throw Error('호출되면 안 됩니다'); } });
    assert.equal(a.provider, 'demo');
  } finally { delete process.env.LLM_MODE; }
});

test('로컬 모델 주소와 모델 이름으로 요청하고 <think> 구간은 무시한다', async () => {
  let seen;
  const fetchMock = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), headers: init.headers };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '<think>생각 중</think>' + JSON.stringify({ answer: '종합 점수는 0점입니다.', citations: [] }) } }] }) };
  };
  const out = await assistPerson('ask', evidence, '점수는?', { fetch: fetchMock });
  assert.equal(seen.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(seen.body.model, 'qwen3:14b');
  assert.equal(seen.body.temperature, 0);
  assert.ok(!seen.headers.Authorization);
  assert.match(seen.body.messages[0].content, /no_think/);
  assert.equal(out.provider, 'api');
});

test('연결이 안 되면 오류를 던진다(서버가 데모 응답으로 전환)', async () => {
  await assert.rejects(() => assistPerson('ask', evidence, 'q', { fetch: async () => { throw Error('ECONNREFUSED'); } }), /ECONNREFUSED/);
});

test('API 응답의 수치가 근거와 같으면 그대로 쓴다', async () => {
  const out = await assistPerson('ask', evidence, '점수는?', { fetch: reply({ answer: '종합 점수는 0점입니다.', citations: [] }) });
  assert.equal(out.provider, 'api');
});

test('API 응답에 지어낸 수치가 있으면 데모 응답으로 대체한다', async () => {
  const out = await assistPerson('ask', evidence, '점수는?', { fetch: reply({ answer: '지급액은 987,654원입니다.', citations: [] }) });
  assert.equal(out.provider, 'demo');
  assert.equal(out.replaced, true);
});

test('형식이 틀리거나 모르는 종류는 오류', async () => {
  await assert.rejects(() => assistPerson('ask', evidence, 'q', { fetch: reply({ answer: 1 }) }), /형식/);
  await assert.rejects(() => assistPerson('nope', evidence), /종류/);
});

test('증빙 요청서 응답은 코드가 이메일 본문으로 조립한다', async () => {
  const out = await assistPerson('request', evidence, '', { fetch: reply({
    subject: '추가 서류 안내', intro: '청구 건을 확인하던 중 연락드립니다.',
    documents: ['진료비 세부내역서'], reasons: ['진료비 항목을 확인하기 위해 필요합니다.'], closing: '확인 후 안내드리겠습니다.',
  }) });
  assert.equal(out.provider, 'api');
  assert.match(out.message, /^안녕하세요\.\n\n청구 건을 확인하던 중 연락드립니다\.\n\n\[ 요청 서류 \]\n① 진료비 세부내역서\n   - 진료비 항목을 확인하기 위해 필요합니다\./);
  assert.match(out.message, /감사합니다\.$/);
});
