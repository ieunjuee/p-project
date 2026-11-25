/* 분석 개요 'AI 지표 해석'(기존 Python 방식을 웹 서버로 옮긴 것).
 *
 *   코드가 지표를 계산하고 판정한다                      (화면의 IndicatorLens.overviewEvidence, person-engine)
 *   LLM이 표를 읽고 해석, 원인 후보, 권장 조치를 쓴다    (이 파일의 callLlm)
 *   코드가 답 속 숫자만 evidence 와 대조한다             (validateNumbers)
 *   숫자가 틀리면 틀린 숫자를 알려 주고 최대 3번까지 다시 쓰게 한다
 *   3번 모두 틀리면 LLM 답을 버리고 provider:'demo' 로 돌려준다(화면이 기존 고정 브리핑을 보여 준다)
 *
 * person-llm.mjs 와 같은 로컬 모델 설정을 씁니다(환경변수 LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, LLM_TIMEOUT_MS, LLM_MODE=demo).
 * LLM이 꺼져 있거나 연결이 안 되면 오류를 던지고, server.mjs 가 provider:'demo' 로 바꿔 응답합니다. */
import engine from './dist/indicator-engine.js';

const settings = () => ({
  baseUrl: (process.env.LLM_BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, ''),
  // [기존 보존] model: process.env.LLM_MODEL || 'qwen3:14b',
  // [변경 이력] 2026-11-25 qwen3.5:9b로 정했다가 gemma4:12b로 바꿨다: model: process.env.LLM_MODEL || 'qwen3.5:9b',
  model: process.env.LLM_MODEL || 'gemma4:12b',
  key: process.env.LLM_API_KEY || '',
  timeout: Number(process.env.LLM_TIMEOUT_MS) || 120000,
  demo: process.env.LLM_MODE === 'demo',
});

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    facts: { type: 'array', items: { type: 'string' } },
    meaning: { type: 'string' },
    causes: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'string' } },
    uncertainty: { type: 'string' },
  },
  required: ['facts', 'meaning', 'causes', 'actions', 'uncertainty'],
};

/** Qwen3는 <think> 구간을 먼저 쓰는 경우가 있어 지운 뒤 JSON만 읽습니다. 못 읽으면 formatError 표시를 붙여 던집니다. */
function readJson(text) {
  const body = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fail = () => Object.assign(Error('LLM 응답을 JSON으로 읽지 못했습니다.'), { formatError: true });
  try { return JSON.parse(body); } catch { /* 앞뒤에 설명이 붙은 경우 */ }
  const match = body.match(/\{[\s\S]*\}/);
  if (!match) throw fail();
  try { return JSON.parse(match[0]); } catch { throw fail(); }
}

async function callLlm(prompt, options) {
  const cfg = settings();
  const response = await (options.fetch || fetch)(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      // /no_think: Qwen3의 생각 단계를 끄는 스위치. 같은 입력에 같은 결과가 나오도록 temperature는 0.
      messages: [{ role: 'system', content: '지정한 JSON 형식으로만 답하세요.\n/no_think' }, { role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'overview_interpretation', strict: true, schema: SCHEMA } },
      reasoning_effort: 'none', // 생각 단계를 끈다(/no_think 만으로는 생각에 토큰을 다 써서 답이 비는 경우가 있었다)
      max_tokens: 1600, temperature: 0, stream: false,
    }),
    signal: AbortSignal.timeout(cfg.timeout),
  });
  if (!response.ok) throw Error('LLM 연결 오류');
  const data = await response.json();
  return readJson(data.choices?.[0]?.message?.content);
}

const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const validShape = (c) => c && typeof c === 'object' && strings(c.facts) && typeof c.meaning === 'string'
  && strings(c.causes) && strings(c.actions) && typeof c.uncertainty === 'string';

/** 화면이 보낸 evidence 가 형식에 맞는지 확인한다(틀리면 '지표 형식 오류'로 던져 서버가 400으로 응답). */
export function checkEvidence(e) {
  const bad = (msg) => { throw Error('지표 형식 오류: ' + msg); };
  if (!e || typeof e !== 'object') bad('근거가 없습니다.');
  if (!Number.isFinite(e.people) || e.people <= 0) bad('사람 수가 올바르지 않습니다.');
  for (const key of ['risk', 'verdicts', 'signals', 'monthly']) if (!Array.isArray(e[key])) bad(`${key} 목록이 없습니다.`);
  if (e.risk.length !== 4) bad('위험도는 4단계여야 합니다.');
  if (JSON.stringify(e).length > 20000) bad('근거 크기를 넘었습니다.');
  return e;
}

export async function interpretOverview(evidence, options = {}) {
  checkEvidence(evidence);
  if (settings().demo) return { provider: 'demo', reason: 'LLM_MODE=demo' };

  let feedback = null, bad = [];
  for (let attempt = 1; attempt <= engine.MAX_ATTEMPTS; attempt++) {
    let out;
    try { out = await callLlm(engine.buildPrompt(evidence, feedback), options); }
    catch (error) {
      if (!error.formatError) throw error; // 연결 오류는 그대로 던진다(서버가 데모로 전환)
      feedback = `JSON 형식 오류: ${error.message} 지정한 JSON만 출력할 것.`; bad = ['JSON 형식 오류'];
      continue;
    }
    if (!validShape(out)) { feedback = 'JSON 형식 오류: facts, meaning, causes, actions, uncertainty를 모두 지정한 형태로 쓸 것.'; bad = ['JSON 형식 오류']; continue; }
    bad = engine.validateNumbers(out, evidence);
    if (!bad.length) return { ...out, provider: 'api', attempts: attempt, verification: { ok: true, bad: [] } };
    feedback = `표에 없는 숫자를 사용했습니다: ${bad.join(', ')}. 표의 수치만 쓰세요.`;
  }
  // 3번 모두 실패: LLM 답을 버린다. 화면이 기존 고정 브리핑을 보여 준다.
  return { provider: 'demo', replaced: true, attempts: engine.MAX_ATTEMPTS, verification: { ok: false, bad } };
}
