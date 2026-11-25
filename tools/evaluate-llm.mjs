/* LLM 모델 비교(웹 코드 기준). 서버가 실제로 쓰는 explainPerson(상세 AI 설명)과 interpretOverview(분석 개요 AI 해석)를
 * 그대로 불러 모델만 바꿔 돌리고, 코드가 정한 근거를 정답으로 삼아 채점합니다.
 * 프롬프트, 스키마, 생각 끄기, 숫자 검증과 재생성까지 웹과 같은 경로를 탑니다.
 *
 * 실행 (Ollama가 켜져 있어야 합니다):
 *   node tools/evaluate-llm.mjs --models qwen3:14b qwen3.5:9b gemma4:12b --persons 30
 *   node tools/evaluate-llm.mjs --models qwen3:14b --persons 2 --no-overview      (빠른 시험)
 * 결과: eval_results/<시각>/ 에 runs.csv(사람별), overview.csv(개요), summary.csv(모델별 요약), raw.jsonl(원문)
 *
 * 채점은 모두 '첫 시도' 답변 기준입니다(재생성으로 고쳐지기 전의 모델 실력). 재생성과 대체는 따로 셉니다.
 * 이 숫자는 가상 데이터에서 코드가 정한 근거를 기준으로 한 것이며, 해석이 업무적으로 맞는지는 사람이 봐야 합니다. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { explainPerson } from '../person-llm.mjs';
import { interpretOverview } from '../indicator-llm.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const E = require(path.join(root, 'dist', 'person-engine.js'));
const IE = require(path.join(root, 'dist', 'indicator-engine.js'));
const C = require(path.join(root, 'dist', 'charts.js'));
const data = require(path.join(root, 'dist', 'data', 'mock.json'));

/* ---------------------------------------------------------------- 인자 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const vals = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) vals.push(process.argv[j]);
  return vals;
};
const models = arg('models', ['qwen3:14b']);
const nPersons = Number((arg('persons', ['30']))[0]);
const seed = Number((arg('seed', ['1']))[0]);
const skipOverview = process.argv.includes('--no-overview');
const nativeBase = (process.env.LLM_BASE_URL || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');

/* ---------------------------------------------------------------- 표본: 위험도와 신호 유무별로 고르게(시드 고정, 모든 모델이 같은 사람) */
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hitsOf = (r) => [...r.signals.med, ...r.signals.auto].filter((s) => s.hit);
const flaggedOf = (r) => r.cross.links.filter((l) => l.verdict !== '정상 분리 청구');
const analysis = E.analyzeAll(data);
const results = analysis.results;
function samplePersons() {
  const rnd = mulberry(seed);
  const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const groups = {
    '높음': [results.filter((r) => r.risk === '높음'), 0.4],
    '보통': [results.filter((r) => r.risk === '보통'), 0.2],
    '낮음 · 걸린 신호 없음': [results.filter((r) => r.risk === '낮음' && !hitsOf(r).length && !flaggedOf(r).length), 0.27],
    '낮음 · 신호 있음': [results.filter((r) => r.risk === '낮음' && (hitsOf(r).length || flaggedOf(r).length)), 0.07],
    '판단 불가': [results.filter((r) => r.risk === '판단 불가'), 0.06],
  };
  const out = [];
  for (const [name, [list, share]] of Object.entries(groups)) {
    for (const r of shuffle(list).slice(0, Math.max(1, Math.round(nPersons * share)))) out.push({ group: name, r });
  }
  return out.slice(0, Math.max(nPersons, 1));
}

/* ---------------------------------------------------------------- 응답 기록과 읽기 */
/** fetch 를 감싸 매 호출의 응답 원문을 기록한다(첫 시도 채점용). 서버 코드는 그대로 쓴다. */
const spyFetch = (raw) => async (url, init) => {
  const resp = await fetch(url, init);
  let body = null; try { body = await resp.clone().json(); } catch { /* 연결 오류 등 */ }
  raw.push({ ok: resp.ok, body });
  return resp;
};
const contentOf = (entry) => entry?.body?.choices?.[0]?.message?.content ?? '';
function parseContent(text) {
  const body = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  try { return JSON.parse(body); } catch { /* 앞뒤에 설명이 붙은 경우 */ }
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
const strs = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const explainShapeOk = (o) => o && typeof o.summary === 'string' && strs(o.basis) && strs(o.causes) && strs(o.checks);
const overviewShapeOk = (o) => o && strs(o.facts) && typeof o.meaning === 'string' && strs(o.causes) && strs(o.actions) && typeof o.uncertainty === 'string';
const tokens = (raw) => raw.reduce((n, e) => n + (e.body?.usage?.completion_tokens || 0), 0);
const finishes = (raw) => raw.map((e) => e.body?.choices?.[0]?.finish_reason).filter(Boolean);

/* ---------------------------------------------------------------- 상세 설명 채점 */
const ASSERTIVE = ['사기입니다', '사기로 확정', '사기가 확실', '지급을 거절', '지급 거절', '거절해야', '지급하세요', '지급해야'];
const NEGATION = /않|없|아님|미달|해당하지|걸리지|정상/; // 이 말이 든 절은 '걸리지 않았다'는 서술로 보고 경보에서 뺀다
const clauses = (text) => text.split(/(?<=[.!?。])\s+|\n+/).flatMap((s) => s.split(/지만|반면|그러나/)).filter((s) => s.trim());

function scoreExplain(evidence, o) {
  const all = [...evidence.medical_signals, ...evidence.auto_signals];
  const hit = all.filter((s) => s.hit), nonhit = all.filter((s) => !s.hit);
  const flagged = evidence.cross_links.filter((l) => l.verdict !== '정상 분리 청구');
  const text = [o.summary, ...o.basis, ...o.causes, ...o.checks].join('\n');
  const head = [o.summary, ...o.basis].join('\n');
  const verify = E.verifyExplanation(evidence, o);
  const mentions = (names, source, skipNegated) => names.filter((n) => clauses(source).some((c) => c.includes(n) && !(skipNegated && NEGATION.test(c)))).length;
  const stated = [...text.matchAll(/위험도(?:는|가|은)?\s*(높음|보통|낮음|판단 불가)/g)].map((m) => m[1]);
  return {
    verifyOk: verify.ok, badNumbers: verify.badNumbers.length, badIds: verify.badIds.length, badTerms: verify.badTerms.length,
    hits: hit.length, hitRecalled: mentions(hit.map((s) => s.name), head, false),
    nonhitMentions: mentions(nonhit.map((s) => s.name), text, true),
    idLeak: /\b(?:med|auto)_[a-z]+\b/.test(text),
    assertive: ASSERTIVE.some((w) => text.includes(w)),
    riskContradiction: stated.some((x) => x !== evidence.risk),
    noEvidence: !hit.length && !flagged.length,
    causes: o.causes.length, causesFraud: o.causes.filter((c) => c.includes('사기')).length,
  };
}

async function runExplain(model, group, r) {
  const evidence = E.evidence(r), raw = [];
  const t0 = Date.now();
  let out = null, error = '';
  try { out = await explainPerson(evidence, { fetch: spyFetch(raw) }); } catch (e) { error = e.message; }
  const ms = Date.now() - t0;
  const first = parseContent(contentOf(raw[0]));
  const shapeOk = !!explainShapeOk(first);
  const row = {
    model, group, person: r.person_id, risk: r.risk, error, ms, llm_calls: raw.length, completion_tokens: tokens(raw), finish: finishes(raw).join('|'),
    shown: out?.provider === 'api', replaced: !!out?.replaced, attempts: out?.attempts ?? (out?.replaced ? 3 : 0),
    firstShapeOk: shapeOk,
    ...(shapeOk ? scoreExplain(evidence, first) : { verifyOk: false, badNumbers: 0, badIds: 0, badTerms: 0, hits: hitsOf(r).length, hitRecalled: 0, nonhitMentions: 0, idLeak: false, assertive: false, riskContradiction: false, noEvidence: !hitsOf(r).length && !flaggedOf(r).length, causes: 0, causesFraud: 0 }),
  };
  return { row, raw: { kind: 'explain', ...row, first, final: out } };
}

/* ---------------------------------------------------------------- 분석 개요 채점 */
const SPECULATIVE = /경제|자연재해|정책|날씨|코로나|계절|기후|경기/;
function overviewEvidenceOf(list) {
  const s = E.summarize(list).summary;
  const hit = (kind, i) => list.filter((r) => r.signals[kind][i].hit).length;
  const verdictPeople = (v) => list.filter((r) => r.cross.links.some((l) => l.verdict === v) || (v === '고지 확인' && r.cross.links.some((l) => l.prior.length))).length;
  const rows = [];
  for (const r of list) {
    for (const m of r.records.med) rows.push({ claim_date: m.visit_date, amount: m.claim_amount });
    for (const c of r.records.autoClaims) rows.push({ claim_date: c.claim_date, amount: c.amount });
  }
  return IE.overviewEvidence({
    people: s.count, risk: s,
    verdicts: ['중복 확실', '중복 의심', '고지 확인', '판정 불가'].map((name) => ({ name, people: verdictPeople(name) })),
    signals: [...list[0].signals.med.map((x, i) => ({ name: '의료 · ' + x.name, people: hit('med', i) })), ...list[0].signals.auto.map((x, i) => ({ name: '자동차 · ' + x.name, people: hit('auto', i) }))],
    months: C.monthlySeries(rows), dataThrough: rows.map((x) => x.claim_date).sort().at(-1) || '', medianAmount: C.quantile(rows.map((x) => x.amount), .5),
  });
}
const variants = { '전체 500명': results, '앞 250명': results.slice(0, 250), '뒤 250명': results.slice(250) };

async function runOverview(model, name, list) {
  const evidence = overviewEvidenceOf(list), raw = [];
  const t0 = Date.now();
  let out = null, error = '';
  try { out = await interpretOverview(evidence, { fetch: spyFetch(raw) }); } catch (e) { error = e.message; }
  const ms = Date.now() - t0;
  const first = parseContent(contentOf(raw[0]));
  const shapeOk = !!overviewShapeOk(first);
  const row = {
    model, variant: name, error, ms, llm_calls: raw.length, completion_tokens: tokens(raw), finish: finishes(raw).join('|'),
    shown: out?.provider === 'api', replaced: !!out?.replaced, attempts: out?.attempts ?? 0, firstShapeOk: shapeOk,
    firstBadNumbers: shapeOk ? IE.validateNumbers(first, evidence).length : 0,
    causes: shapeOk ? first.causes.length : 0, actions: shapeOk ? first.actions.length : 0,
    speculative: shapeOk ? [...first.causes, ...first.actions].filter((x) => SPECULATIVE.test(x)).length : 0,
  };
  return { row, raw: { kind: 'overview', ...row, first, final: out } };
}

/* ---------------------------------------------------------------- Ollama 모델 올리기와 내리기 */
async function unloadAll() {
  try {
    const ps = await (await fetch(nativeBase + '/api/ps')).json();
    for (const m of ps.models || []) await fetch(nativeBase + '/api/generate', { method: 'POST', body: JSON.stringify({ model: m.model || m.name, keep_alive: 0 }) });
  } catch { /* 정리 실패는 치명적이지 않다 */ }
}
async function warm(model) {
  const t0 = Date.now();
  const r = await fetch(nativeBase + '/api/generate', { method: 'POST', body: JSON.stringify({ model, prompt: '', keep_alive: '30m' }) });
  if (!r.ok) throw Error(`모델 로드 실패(${r.status}): ${(await r.text()).slice(0, 120)}`);
  await r.json();
  const ps = await (await fetch(nativeBase + '/api/ps')).json();
  const info = (ps.models || []).find((m) => (m.model || m.name) === model);
  return { sec: ((Date.now() - t0) / 1000).toFixed(1), ctx: info?.context_length, vramGB: info ? (info.size_vram / 1e9).toFixed(1) : '?', sizeGB: info ? (info.size / 1e9).toFixed(1) : '?' };
}

/* ---------------------------------------------------------------- 통계 */
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const ci = (k, n) => (n ? `${k}/${n} (${wilson(k, n).map((x) => Math.round(100 * x)).join('~')}%)` : '-');
const median = (a) => { const b = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const fix = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');

function summarize(model, ex, ov, loadInfo) {
  const withHits = ex.filter((r) => r.hits > 0), none = ex.filter((r) => r.noEvidence), withCauses = ex.filter((r) => !r.noEvidence);
  const lines = sum(ex.map((r) => r.causes));
  const tps = ex.filter((r) => r.ms > 0 && r.completion_tokens).map((r) => r.completion_tokens / (r.ms / 1000));
  return {
    '모델': model, '상세 설명 수': ex.length,
    '[실제 사용] LLM 설명이 화면에 표시됨': ci(ex.filter((r) => r.shown).length, ex.length),
    '[실제 사용] 데모로 대체(재생성 실패)': ci(ex.filter((r) => r.replaced).length, ex.length),
    '[실제 사용] 호출 오류(연결, 시간 초과)': ci(ex.filter((r) => r.error).length, ex.length),
    '첫 시도 JSON 형식 성공': ci(ex.filter((r) => r.firstShapeOk).length, ex.length),
    '첫 시도 수치와 용어 검증 통과': ci(ex.filter((r) => r.firstShapeOk && r.verifyOk).length, ex.length),
    '평균 시도 횟수': fix(mean(ex.filter((r) => r.attempts).map((r) => r.attempts)), 2),
    '토큰 한도 초과(finish=length) 호출': String(ex.filter((r) => r.finish.includes('length')).length),
    '걸린 지표 언급률(근거)': ci(sum(withHits.map((r) => r.hitRecalled)), sum(withHits.map((r) => r.hits))),
    '안 걸린 지표를 걸린 듯 언급(사람당)': fix(mean(ex.map((r) => r.nonhitMentions)), 2),
    '영문 지표 id 노출': ci(ex.filter((r) => r.idLeak).length, ex.length),
    '사기 확정, 지급 결정 단정 표현': ci(ex.filter((r) => r.assertive).length, ex.length),
    '위험도와 모순되는 말': ci(ex.filter((r) => r.riskContradiction).length, ex.length),
    '근거 없는 사람에게 원인 후보를 씀(과잉 해석)': ci(none.filter((r) => r.causes > 0).length, none.length),
    '근거 있는 사람의 평균 원인 후보 수': fix(mean(withCauses.map((r) => r.causes)), 2),
    "원인 후보 중 '사기' 언급 줄": lines ? `${sum(ex.map((r) => r.causesFraud))}/${lines}` : '-',
    '속도 중앙값 초/건': fix(median(ex.map((r) => r.ms)) / 1000),
    '초당 토큰 중앙값(프롬프트 읽기 포함)': fix(median(tps)),
    '개요 AI 해석 표시됨': ov.length ? ci(ov.filter((r) => r.shown).length, ov.length) : '-',
    '개요 첫 시도 형식 성공': ov.length ? ci(ov.filter((r) => r.firstShapeOk).length, ov.length) : '-',
    '개요 첫 시도 틀린 숫자 합': ov.length ? String(sum(ov.map((r) => r.firstBadNumbers))) : '-',
    '개요 추측성 외부 원인(경제, 정책 등) 줄': ov.length ? String(sum(ov.map((r) => r.speculative))) : '-',
    '개요 속도 중앙값 초': ov.length ? fix(median(ov.map((r) => r.ms)) / 1000) : '-',
    '모델 크기 GB / VRAM 올라간 GB / 컨텍스트': `${loadInfo.sizeGB} / ${loadInfo.vramGB} / ${loadInfo.ctx ?? '?'}`,
  };
}

const width = (s) => [...String(s)].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
function printTable(summaries) {
  const labels = Object.keys(summaries[0]);
  const lw = Math.max(...labels.map(width)), cw = summaries.map((s) => Math.max(...labels.map((k) => width(s[k]))));
  console.log();
  for (const k of labels) console.log(k + ' '.repeat(lw - width(k)) + ' | ' + summaries.map((s, j) => String(s[k]) + ' '.repeat(cw[j] - width(s[k]))).join(' | '));
}
const csv = (rows) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n');
};

/* ---------------------------------------------------------------- 실행 */
const outDir = path.join(root, 'eval_results', new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '_'));
fs.mkdirSync(outDir, { recursive: true });
const rawFile = path.join(outDir, 'raw.jsonl');
const people = samplePersons();
console.log(`모델 ${models.join(', ')} | 상세 설명 ${people.length}명 (${[...new Set(people.map((p) => p.group))].map((g) => `${g} ${people.filter((p) => p.group === g).length}`).join(', ')}) | 개요 ${skipOverview ? '생략' : Object.keys(variants).length + '종'}`);
const allEx = [], allOv = [], summaries = [];

for (const model of models) {
  console.log(`\n== ${model} ==`);
  process.env.LLM_MODEL = model; // person-llm.mjs, indicator-llm.mjs 가 호출 때마다 이 값을 읽는다
  await unloadAll();
  let loadInfo;
  try { loadInfo = await warm(model); } catch (e) { console.log('  ' + e.message + ' -> 이 모델은 건너뜁니다'); continue; }
  console.log(`  로드 ${loadInfo.sec}초 (모델 ${loadInfo.sizeGB}GB, VRAM ${loadInfo.vramGB}GB, 컨텍스트 ${loadInfo.ctx})`);
  const ex = [], ov = [];
  for (const { group, r } of people) {
    const { row, raw } = await runExplain(model, group, r);
    ex.push(row); fs.appendFileSync(rawFile, JSON.stringify(raw) + '\n');
    console.log(`  [상세] ${r.person_id} ${group} -> ${row.error ? '오류 ' + row.error : row.shown ? 'LLM 표시' : '데모 대체'} | 시도 ${row.attempts} | 첫 시도 검증 ${row.firstShapeOk && row.verifyOk ? '통과' : '실패'} | ${(row.ms / 1000).toFixed(1)}초`);
  }
  if (!skipOverview) for (const [name, list] of Object.entries(variants)) {
    const { row, raw } = await runOverview(model, name, list);
    ov.push(row); fs.appendFileSync(rawFile, JSON.stringify(raw) + '\n');
    console.log(`  [개요] ${name} -> ${row.error ? '오류 ' + row.error : row.shown ? 'LLM 표시' : '데모 대체'} | 시도 ${row.attempts} | 첫 시도 틀린 숫자 ${row.firstBadNumbers} | ${(row.ms / 1000).toFixed(1)}초`);
  }
  allEx.push(...ex); allOv.push(...ov);
  summaries.push(summarize(model, ex, ov, loadInfo));
}

if (!summaries.length) { console.log('채점할 결과가 없습니다.'); process.exit(1); }
fs.writeFileSync(path.join(outDir, 'runs.csv'), csv(allEx));
fs.writeFileSync(path.join(outDir, 'overview.csv'), csv(allOv));
fs.writeFileSync(path.join(outDir, 'summary.csv'), csv(summaries));
printTable(summaries);
console.log(`\n저장: ${outDir}\n괄호 안은 95% 신뢰구간입니다. 구간이 겹치면 우열을 단정하지 마세요. 가상 데이터와 코드가 정한 근거 기준의 결과입니다.`);
await unloadAll();
