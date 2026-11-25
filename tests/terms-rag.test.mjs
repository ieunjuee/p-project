import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTermsRag, excerpt, TERM } from '../terms-rag.mjs';
import { assistPerson, explainPerson } from '../person-llm.mjs';
const E = createRequire(import.meta.url)('../dist/person-engine.js');

const rag = createTermsRag();
const data = {
  kcd: [{ disease_code: 'S33', disease_name: '요추 염좌', body_part: '허리', injury_flag: 1 }],
  person: [{ person_id: 'P1', age_group: '40대', gender: 'M' }],
  med_claim: [], auto_accident: [], auto_claim: [],
};
const base = E.evidence(E.analyzePerson('P1', data));
const link = (verdict, n = 1, prior = []) => ({ accident_id: `A000${n}`, claim_id: `M000${n}`, verdict, reason: '시험', med_paid: 100000, auto_paid: 100000, prior_claim_ids: prior });
const withLink = (verdict) => ({
  ...base,
  decision: verdict === '중복 확실' ? '지급 정지 권고' : '지급 보류',
  cross_links: [link(verdict)],
});
const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });

test('조항 파일은 별표15 자동차·실손 4개 약관을 조항 단위로 담고 있다', () => {
  assert.equal(new Set(rag.chunks.map((c) => c.doc)).size, 4);
  assert.ok(rag.chunks.every((c) => c.id && c.cite && c.text));
});

test('코드 판정에 따라 정해 둔 조항이 붙는다', () => {
  const cite = (kind, e) => rag.termsFor(kind, e).map((t) => t.cite).join(' ');
  assert.match(cite('explain', withLink('중복 확실')), /실손의료보험 표준약관\(기본형\) 제4조\(보상하지 않는 사항\)/);
  assert.match(cite('explain', withLink('고지 확인')), /붙임1/);
  assert.match(cite('gap', withLink('판정 불가')), /제7조\(보험금의 청구\).*제27조\(제출 서류\)/);
  assert.equal(rag.termsFor('explain', base).length, 0); // 걸린 판정이 없으면 조항도 없음
});

test('같은 입력이면 같은 조항, 최대 3개', () => {
  const e = withLink('판정 불가');
  assert.deepEqual(rag.termsFor('ask', e, '4주 넘게 치료하면 진단서가 필요한가요?'), rag.termsFor('ask', e, '4주 넘게 치료하면 진단서가 필요한가요?'));
  assert.ok(rag.termsFor('ask', e, '4주 넘게 치료하면 진단서가 필요한가요?').length <= 3);
});

test('질문 검색: 4주 진단서 질문은 자동차 별표1 지급기준을 찾고, 무관한 질문엔 조항을 붙이지 않는다', () => {
  assert.match(rag.search('4주 넘게 치료받으면 진단서가 필요한가요?')[0].chunk.cite, /자동차보험 표준약관 별표1/);
  assert.equal(rag.search('왜 보류인가요?').length, 0);
});

test('약관 조항 번호(제4조)를 인용해도 지어낸 숫자로 보지 않는다', async () => {
  const e = withLink('중복 확실');
  const [term] = rag.termsFor('explain', e);
  const out = await explainPerson(e, { fetch: reply({
    summary: '같은 영수증이 두 보험에서 지급되어 지급 정지 권고입니다.',
    basis: ['실손의료보험 표준약관(기본형) 제4조에 따라 자동차보험에서 보상받은 치료비는 실손 보상 대상이 아닙니다 (사고 A0001, 청구 M0001).'],
    checks: [], term_refs: [term.ref],
  }) });
  assert.equal(out.provider, 'api');
  assert.ok(out.terms.some((t) => t.ref === term.ref));
});

test('넣어 주지 않은 조항 ref를 인용하면 데모 설명으로 대체한다', async () => {
  const out = await assistPerson('ask', withLink('중복 확실'), '근거 약관은?', { fetch: reply({ answer: '근거 약관이 있습니다.', points: [], citations: [], term_refs: ['T9999'] }) });
  assert.equal(out.replaced, true);
  assert.deepEqual(out.verification.badRefs, ['T9999']);
});

test('LLM에 보내는 입력에 terms가 들어가고 출력 형식에 term_refs가 있다', async () => {
  let body;
  const fetchMock = async (_url, init) => { body = JSON.parse(init.body); return reply({ answer: '근거가 없습니다.', points: [], citations: [], term_refs: [] })(); };
  await assistPerson('ask', withLink('판정 불가'), '청구 서류는?', { fetch: fetchMock });
  assert.ok(JSON.parse(body.messages[1].content).terms.length > 0);
  assert.ok(body.response_format.json_schema.schema.required.includes('term_refs'));
  assert.match(body.messages[0].content, /terms 필드는 관련 표준약관 조항/);
  assert.equal(body.reasoning_effort, 'none'); // 생각 끄기(Ollama에서 /no_think만으로는 꺼지지 않음)
});

test('LLM 입력 줄이기: 매핑 조항은 요약만, 정상 분리 청구는 개수만 보낸다', async () => {
  let sent;
  const e = { ...withLink('중복 확실'), cross_links: [link('중복 확실', 1), link('정상 분리 청구', 2), link('정상 분리 청구', 3, ['M0099'])] };
  const fetchMock = async (_url, init) => { sent = JSON.parse(JSON.parse(init.body).messages[1].content); return reply({ summary: '요약', basis: [], checks: [], term_refs: [] })(); };
  const out = await explainPerson(e, { fetch: fetchMock });
  assert.ok(sent.terms.every((t) => t.summary && !t.text));            // 원문 대신 요약
  assert.deepEqual(sent.cross_links.map((l) => l.claim_id), ['M0001', 'M0003']); // 기왕증 기록이 있는 정상 연결은 남김
  assert.equal(sent.normal_link_count, 2);
  assert.ok(out.terms[0].text.length > out.terms[0].cite.length);      // 화면 '자세히'용 전문은 응답에 포함
});

test('질문에 번호가 나온 정상 연결은 상세를 보내고, 검색 조항은 본문 발췌를 보낸다', async () => {
  let sent;
  const e = { ...withLink('중복 확실'), cross_links: [link('중복 확실', 1), link('정상 분리 청구', 2)] };
  const fetchMock = async (_url, init) => { sent = JSON.parse(JSON.parse(init.body).messages[1].content); return reply({ answer: '근거가 없습니다.', points: [], citations: [], term_refs: [] })(); };
  await assistPerson('ask', e, 'M0002는 4주 넘게 치료하면 진단서가 필요한가요?', { fetch: fetchMock });
  assert.ok(sent.evidence.cross_links.some((l) => l.claim_id === 'M0002'));
  assert.ok(sent.terms.some((t) => t.text && /별표1/.test(t.cite)));
});

test('엔진이 쓰는 판정 이름·연결 필드가 약관 매핑이 기대하는 것과 같다 (이름이 바뀌면 여기서 알림)', () => {
  const mock = createRequire(import.meta.url)('../dist/data/mock.json');
  const all = E.analyzeAll(mock).results.map((r) => E.evidence(r));
  const known = ['정상 분리 청구', '중복 확실', '중복 의심', '고지 확인', '판정 불가'];
  const seen = new Set(all.flatMap((e) => e.cross_links.map((l) => l.verdict)));
  assert.deepEqual([...seen].filter((v) => !known.includes(v)), []);
  const l = all.flatMap((e) => e.cross_links)[0];
  assert.ok('claim_id' in l && 'accident_id' in l && Array.isArray(l.prior_claim_ids));
});

test('모델이 문장에 약관 이름을 빠뜨리면 코드가 "관련 약관" 줄을 붙이고, 이미 썼으면 붙이지 않는다', async () => {
  const e = withLink('중복 확실');
  const [term] = rag.termsFor('explain', e);
  const run = (basis) => explainPerson(e, { fetch: reply({ summary: '요약', basis, checks: [], term_refs: [term.ref] }) });
  const added = await run(['사고 A0001, 청구 M0001이 양쪽에서 지급되었습니다.']);
  assert.equal(added.basis.at(-1), '관련 약관: 실손의료보험 표준약관(기본형) 제4조(보상하지 않는 사항)');
  assert.equal(added.provider, 'api');
  const kept = await run(['실손 제4조에 따라 확인이 필요합니다 (사고 A0001, 청구 M0001).']);
  assert.equal(kept.basis.length, 1);
});

test('판정으로 정해진 조항이 있으면 질문 검색 조항은 1개만 붙인다', () => {
  const q = '같은 치료비를 자동차보험이랑 실손에서 받으면 어떻게 되나요';
  assert.equal(rag.termsFor('ask', withLink('중복 확실'), q).length, 2); // 매핑 1 + 검색 1
  assert.equal(rag.termsFor('ask', base, q).length, 2);                 // 매핑 없음 → 검색 2
});

test('답변이나 요약이 빈 칸이면 형식 오류로 처리한다(서버가 데모로 전환)', async () => {
  await assert.rejects(() => assistPerson('ask', base, '질문', { fetch: reply({ answer: ' ', points: [], citations: [], term_refs: [] }) }), /형식/);
  await assert.rejects(() => explainPerson(base, { fetch: reply({ summary: '', basis: [], checks: [], term_refs: [] }) }), /형식/);
});

test('적용 문장: 매핑 조항마다 이 사람의 사고·청구 번호와 지급액으로 어떻게 걸리는지 코드가 쓴다', () => {
  const e = { ...withLink('중복 확실'), cross_links: [{ ...link('중복 확실'), accident_date: '2025-03-02', auto_paid: 120000, med_paid: 120000 }] };
  const [term] = rag.termsFor('explain', e);
  assert.match(term.apply[0], /^사고 A0001\(2025-03-02\) 관련 청구 M0001: .*자동차보험 120,000원, 실손 120,000원/);
  assert.match(rag.termsFor('explain', withLink('고지 확인'))[0].apply[0], /청구 M0001: .*질병으로 청구/);
  assert.match(rag.termsFor('gap', withLink('판정 불가'))[0].apply[0], /청구 M0001: .*영수증 번호가 비어/);
  assert.match(rag.termsFor('request', base)[0].apply[0], /청구 서류/);                        // 판정 없는 요청서: 서류 범위 안내
  assert.match(rag.termsFor('ask', base, '같은 치료비를 자동차보험이랑 실손에서 받으면')[0].apply[0], /질문으로 찾은 조항/);
});

test('적용 문장은 건수가 많으면 3건까지만 쓰고 나머지는 개수로 줄인다', () => {
  const e = { ...withLink('중복 의심'), cross_links: [1, 2, 3, 4, 5].map((n) => link('중복 의심', n)) };
  const { apply } = rag.termsFor('explain', e)[0];
  assert.equal(apply.length, 4);
  assert.equal(apply[3], '외 2건도 같은 판정입니다.');
});

test('적용 문장은 LLM 입력과 화면 응답에 함께 가고, LLM이 그 숫자를 옮겨 써도 지어낸 숫자로 보지 않는다', async () => {
  let sent;
  const e = withLink('중복 확실');
  const [term] = rag.termsFor('explain', e);
  const fetchMock = async (_url, init) => {
    sent = JSON.parse(JSON.parse(init.body).messages[1].content);
    return reply({ summary: '같은 영수증이 두 보험에서 지급되었습니다.', checks: [], term_refs: [term.ref],
      basis: ['관련 약관: 실손의료보험 표준약관(기본형) 제4조 — 청구 M0001은 자동차보험 100,000원이 이미 지급되어 실손 보상 제외에 해당하는지 확인할 건입니다 (사고 A0001).'] })();
  };
  const out = await explainPerson(e, { fetch: fetchMock });
  assert.deepEqual(sent.terms[0].apply, term.apply);
  assert.equal(out.provider, 'api');
  assert.deepEqual(out.terms[0].apply, term.apply);
});

test('조항 원문: PDF 줄바꿈과 표 칸이 정리되어 있다', () => {
  const text = (doc, article) => rag.chunks.filter((c) => c.doc.startsWith(doc) && c.article === article).map((c) => c.text).join('\n');
  const lines = (t) => t.split('\n');
  // 실손 제4조 ③3호: 한 줄로 이어지고, 표 왼쪽 칸(보장종목)은 머리 줄로 들어간다
  assert.ok(lines(text('실손의료보험 표준약관(기본형)', '제4조')).some((l) => l.startsWith('3. 자동차보험(공제를 포함합니다)에서 보상받는 치료관계비(과실상계 후 금액을 기준으로 합니다)')));
  assert.match(text('실손의료보험 표준약관(기본형)', '제4조'), /\[보장종목: \(1\) ?상해급여\]\n① 회사는/);
  // 붙임1: 용어 | 정의 표가 '용어: 정의' 한 줄
  assert.ok(lines(text('실손의료보험 표준약관(기본형)', '붙임1')).includes('상해: 보험기간 중 발생한 급격하고 우연한 외래의 사고'));
  // 자동차 제27조: ◦ 표가 '서류 (보장종목)' 한 줄
  assert.ok(lines(text('자동차보험 표준약관', '제27조')).includes('3. 손해배상의 이행사실을 증명하는 서류 (대인배상, 대물배상)'));
  // 자동차 제27조 7번(같은 높이 조각 순서)과 8번(하위 서류마다 ○)
  assert.ok(lines(text('자동차보험 표준약관', '제27조')).some((l) => l.startsWith('7. 피보험자가 입은 손해를 보상할 ｢대인배상Ⅱ｣ 또는 공제계약, 배상의무자 또는 제3자로부터')));
  assert.ok(lines(text('자동차보험 표준약관', '제27조')).includes('- 전손사고 후 이전매각시 이전서류 (대물배상, 자기차량손해)'));
  // 줄을 이을 때 띄어쓰기: 단어 사이는 띄우고(보험금을 청구하여야), 단어 조각은 붙임(과실상계, 보상하지 않습니다)
  const all = rag.chunks.map((c) => c.text).join('\n');
  for (const bad of ['보험금을청구하여야', '발급한것이어야합니다', '따르지않거나', '보장종목별로다음과', '과실 상계', '않 습니다', '지급 합니다']) assert.ok(!all.includes(bad), bad);
  // 표가 없는 쪽의 짧은 줄(x 71에서 시작)을 표 칸으로 보고 지우지 않는다
  for (const keep of ['규정한 국내의 의료기관에서 발급한 것이어야', '1. 소송제기', '해석합니다.']) assert.ok(all.includes(keep), keep);
  assert.ok(!all.includes('[보장종목: 같습니다'));
  // 매핑 조항 검수(예외 사전)와 날짜 뒤 줄바꿈
  for (const ok of ['전액본인부담)인 의료비', 'O99)와 관련한', '할 목적으로', '「의료급여법」에 따른 본인부담금 보상제 및 본인부담금 상한제', '무보험자동차에 의한 상해', '’26.5.6. 이후']) assert.ok(all.includes(ok), ok);
  // 숫자 표는 마크다운 표로(붙임2 적립이율)
  assert.match(text('실손의료보험 표준약관(기본형)', '붙임2'), /\| 구분 \| 기간 \| 지급이자 \|\n\|---\|---\|---\|\n\| 보장관련 보험금\(제3조\) \| 지급기일의 다음날부터 30일 이내 기간 \| 보험계약대출이율 \|/);
  // 표가 조각 사이에서 나뉘면 다음 조각에도 머리글이 있다
  for (const c of rag.chunks.filter((x) => /^\[[^\]]+계속\]\n\|/.test(x.text))) assert.match(c.text.split('\n')[2], /^\|(---\|)+$/);
  // 전체: 3글자 이하로 끊긴 줄이 거의 없다(정리 전 775줄)
  assert.ok(rag.chunks.flatMap((c) => lines(c.text)).filter((l) => l.length <= 3).length < 30);
});

test('기왕증: 사고 전 같은 부위 진료 기록이 있으면 자동차 별표3(기왕증)과 적용 문장을 붙인다', () => {
  const e = { ...base, cross_links: [link('정상 분리 청구', 1, ['M0009', 'M0010'])] };
  const [term] = rag.termsFor('explain', e);
  assert.match(term.cite, /^자동차보험 표준약관 별표3/);
  assert.match(term.llm.summary, /기왕증 관여도/);
  assert.match(term.apply[0], /^사고 A0001 관련 청구 M0001: 사고 전 같은 부위 진료 기록\(청구 M0009, M0010\)/);
  assert.equal(rag.termsFor('explain', withLink('정상 분리 청구')).length, 0);   // 기록 없으면 안 붙음
  // 다른 판정과 같이 있으면 서류 안내 조항보다 앞에 온다(최대 3개)
  const many = { ...base, cross_links: [link('중복 확실', 1), link('고지 확인', 2), link('판정 불가', 3, ['M0009'])] };
  assert.deepEqual(rag.termsFor('explain', many).map((t) => t.cite.split(' ').slice(0, 3).join(' ')),
    ['실손의료보험 표준약관(기본형) 제4조(보상하지', '실손의료보험 표준약관(기본형) 붙임1(용어의', '자동차보험 표준약관 별표3(과실상계']);
});

test('질문 검색 성능: 개발용 평가 질문에서 상위 2개 정답률과 약관 밖 질문 거름이 기준 이상 (rag/eval)', async () => {
  const { score, METHODS } = await import('../rag/eval/eval-search.mjs');
  const [current, min] = METHODS['글자 2개 BM25(현재)'];
  const r = score(current, min);
  assert.ok(r.hit2 >= 0.75, `Hit@2 ${r.hit2}`);
  assert.ok(r.reject >= 0.75, `약관 밖 거름 ${r.reject}`);
  for (const [name, [fn, m]] of Object.entries(METHODS)) if (fn !== current) assert.ok(score(fn, m).hit2 < r.hit2, name); // 비교 방식보다 나음
});

test('검색 조항 발췌: 앞부분이 아니라 질문과 겹치는 구간을 EXCERPT 글자로 보낸다', () => {
  const body = '가'.repeat(900) + ' 보험금 청구권은 3년간 행사하지 아니하면 소멸시효가 완성됩니다. ' + '나'.repeat(900);
  const chunk = { id: 'X', cite: 'X', text: body };
  const out = excerpt(chunk, undefined, '보험금 청구권은 언제 소멸돼요?');
  assert.ok(out.length <= 400);
  assert.match(out, /소멸시효/);
  assert.equal(excerpt(chunk, '청구권은'), body.slice(body.indexOf('청구권은') - 150, body.indexOf('청구권은') + 250)); // has가 있으면 그 주변
});

test('약관 개정 대비: 매핑 조항 요약의 근거 문구(facts)가 모두 원문에 있다', () => {
  const flat = (t) => t.replace(/\s/g, '');
  for (const [key, t] of Object.entries(TERM)) {
    const text = flat(rag.chunks.filter((c) => c.doc === t.doc && c.article === t.article).map((c) => c.text).join(''));
    assert.ok(t.facts?.length, `${key}: facts 없음`);
    for (const f of t.facts) assert.ok(text.includes(flat(f)), `${key}: '${f}'가 ${t.doc} ${t.article} 원문에 없음 — 요약을 원문과 다시 대조하세요`);
  }
});

test('term_refs 스키마: 넣어 준 조항 번호만 고를 수 있다(작은 모델이 문장을 넣는 실수 방지)', async () => {
  const schemas = [];
  const fetchMock = async (_url, init) => {
    schemas.push(JSON.parse(init.body).response_format.json_schema.schema.properties.term_refs);
    return reply({ summary: '설명', basis: [], checks: [], term_refs: [], answer: '답', points: [], citations: [] })();
  };
  const e = withLink('중복 확실');
  await explainPerson(e, { fetch: fetchMock });
  assert.deepEqual(schemas[0].items.enum, rag.termsFor('explain', e).map((t) => t.ref));
  await assistPerson('ask', withLink('정상 분리 청구'), '날씨 어때요?', { fetch: fetchMock }).catch(() => {});
  assert.equal(schemas[1].maxItems, 0);   // 조항이 없으면 빈 배열만
});

test('관련 약관 줄을 코드가 붙일 때 같은 조항은 한 번만 쓴다', async () => {
  const e = withLink('고지 확인');
  const [term] = rag.termsFor('explain', e);
  const out = await explainPerson(e, { fetch: reply({ summary: '설명', basis: ['근거'], checks: [], term_refs: [term.ref, term.ref] }) });
  const line = out.basis.at(-1);
  assert.equal(line.split('붙임1').length - 1, 1, line);
});
