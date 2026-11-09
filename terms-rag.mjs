/* 약관 RAG: LLM 설명에 붙일 표준약관 조항을 찾습니다.
 * 약관은 근거 인용에만 쓰고, 점수·위험도·결과 제안은 바꾸지 않습니다.
 *
 * 조항 데이터: rag/terms_chunks.jsonl (rag/chunk_terms.py가 별표15 표준약관 PDF를 조항 단위로 자른 결과)
 * 찾는 방법 두 가지
 *   1. 고정 매핑: 코드 판정(중복 확실 등)과 걸린 지표에 정해 둔 조항을 붙입니다. 같은 입력이면 같은 조항이 나옵니다.
 *      LLM에는 원문 대신 사람이 쓴 한 줄 요약을 보냅니다.
 *   2. 키워드 검색: 담당자 질문(자유 문장)은 글자 2개 단위 BM25로 가장 비슷한 조항을 찾습니다. 외부 모델이 필요 없습니다.
 * 적용 문장(apply): 매핑 조항이 이 사람의 어느 건에 어떻게 걸리는지 코드가 근거 데이터(사고·청구 번호, 날짜, 지급액)로 씁니다.
 *   LLM은 이 문장을 풀어 설명만 하고, 숫자는 근거 데이터에서만 나옵니다. */
import { readFileSync } from 'node:fs';

const MAX_TERMS = 3;      // LLM에 넣는 조항 수
const EXCERPT = 400;      // 검색 조항을 LLM에 넣을 때의 글자 수. 질문과 겹치는 구간을 골라 보내 앞 600자보다 짧고(-33%) 질문 관련 글자는 더 남음(89%→90%, rag/README 발췌)
const MIN_SCORE = 15;     // 키워드 검색 점수 하한. rag/eval 개발용 질문에서 정답률을 유지하며 약관 밖 질문을 가장 잘 거르는 구간(14~16)의 가운데
const AUTO = '자동차보험 표준약관';
const MED = '실손의료보험 표준약관(기본형)';

export function loadTerms(file = new URL('./rag/terms_chunks.jsonl', import.meta.url)) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/* 고정 매핑. has는 긴 조항이 여러 조각으로 나뉜 경우 그 내용이 든 조각을 고르는 글자입니다.
 * summary는 사람이 원문을 읽고 쓴 한 줄 요약입니다. 매핑 조항은 LLM에 원문 대신 이 요약만 보내 입력을 줄입니다. */
/* summary는 사람이 원문과 대조해 쓴 요약, facts는 그 요약이 근거로 삼은 원문 문구입니다.
 * 약관이 개정돼 facts가 원문에서 사라지면 테스트가 실패하므로, 그때 요약을 다시 대조합니다. */
const TERM = {
  autoComp: { doc: MED, article: '제4조', has: '자동차보험(공제를 포함합니다)에서 보상받는',
    summary: '실손 상해급여는 자동차보험(공제 포함)에서 보상받는 치료관계비(과실상계 후 금액 기준)를 보상하지 않습니다. 다만 자동차보험 진료수가 기준에 따라 실제로 본인이 부담한 의료비는 보상합니다.',
    facts: ['자동차보험(공제를 포함합니다)에서 보상받는 치료관계비', '과실상계 후 금액을 기준', '자동차보험 진료수가', '실제 본인 부담의료비'] },
  injury: { doc: MED, article: '붙임1', has: '급격하고 우연한',
    summary: '상해는 보험기간 중 발생한 급격하고 우연한 외래의 사고를 말합니다.',
    facts: ['보험기간 중 발생한 급격하고 우연한 외래의 사고'] },
  medClaim: { doc: MED, article: '제7조', has: '보험금을',
    summary: '실손 보험금은 청구서, 사고증명서(진료비 계산서·영수증, 진료비 세부산정내역, 입원치료확인서 등), 신분증 등을 제출해 청구하며, 사고증명서는 국내 의료기관에서 발급한 것이어야 합니다.',
    facts: ['청구서', '사고증명서', '진료비 계산서', '영수증', '진료비 세부산정내역', '입원치료확인서', '신분증', '국내의 의료기관에서 발급한 것이어야'] },
  priorCond: { doc: AUTO, article: '별표3', has: '기왕증(*1)으로 인한 손해는',
    summary: '기왕증(자동차사고 전에 이미 있던 증상으로 특이체질·병적 소인 포함)으로 인한 손해는 보상하지 않습니다. 다만 사고로 기왕증이 악화된 경우에는 기왕증 관여도를 반영해 보상하며, 관여도는 해당 과목 전문의가 판정한 비율에 따라 공제합니다.',
    facts: ['기왕증', '으로 인한 손해는 보상하지 아니함', '악화된 경우', '기왕증 관여도', '전문의', '특이체질', '병적 소인'] },
  autoDocs: { doc: AUTO, article: '제27조', has: '제출',
    summary: '피보험자는 보장종목별로 보험금 청구서, 손해액을 증명하는 서류(진단서 등) 등을 갖춰 청구하며, 보장종목에 따라 교통사고사실확인원 등이 추가로 필요합니다.',
    facts: ['보험금 청구서', '손해액을 증명하는 서류', '진단서', '교통사고사실확인원'] },
};
/* 적용 문장. 판정 문장은 확정이 아니라 '확인할 내용'으로 씁니다(최종 판단은 담당자). */
const MAX_APPLY = 3; // 조항 하나에 보여줄 건수. 나머지는 '외 n건'
const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const caseOf = (l) => `사고 ${l.accident_id}${l.accident_date ? `(${l.accident_date})` : ''} 관련 청구 ${l.claim_id}`;
const paid = (l) => (l.auto_paid != null ? `자동차보험 ${won(l.auto_paid)}, 실손 ${won(l.med_paid)}` : `실손 ${won(l.med_paid)}`);
const perLink = (e, names, line) => {
  const links = (e.cross_links || []).filter(typeof names === 'function' ? names : (l) => names.includes(l.verdict));
  const out = links.slice(0, MAX_APPLY).map(line);
  if (links.length > MAX_APPLY) out.push(`외 ${links.length - MAX_APPLY}건도 같은 판정입니다.`);
  return out;
};
const APPLY = {
  autoComp: (e) => perLink(e, ['중복 확실', '중복 의심'], (l) => (l.verdict === '중복 확실'
    ? `${caseOf(l)}: 같은 영수증의 치료비가 두 보험에서 모두 지급되었습니다(${paid(l)}). 자동차보험에서 보상받은 치료비는 실손에서 보상하지 않으므로, 실손 지급분이 이 조항의 보상 제외에 해당하는지 확인합니다.`
    : `${caseOf(l)}: 같은 병원·같은 치료 기간에 두 보험에서 비슷한 금액이 지급되었습니다(${paid(l)}). 같은 치료비라면 이 조항의 보상 제외에 해당하므로, 서로 다른 비용 항목인지 확인합니다.`)),
  injury: (e) => perLink(e, ['고지 확인'], (l) => `${caseOf(l)}: 사고로 생긴 손상 진료인데 실손에는 질병으로 청구되었습니다. 이 조항의 상해(급격하고 우연한 외래의 사고)에 해당하면 상해로 다뤄야 하므로, 사고 경위와 청구 구분을 확인합니다.`),
  priorCond: (e) => perLink(e, (l) => l.prior_claim_ids?.length, (l) => `${caseOf(l)}: 사고 전 같은 부위 진료 기록(청구 ${l.prior_claim_ids.slice(0, 3).join(', ')})이 있습니다. 사고 전부터 있던 증상으로 인한 손해는 이 조항에 따라 보상하지 않고 사고로 악화된 부분만 기왕증 관여도를 빼고 보상하므로, 전문의 판정으로 관여도를 확인합니다.`),
  medClaim: (e) => {
    const out = perLink(e, ['판정 불가'], (l) => `${caseOf(l)}: 자동차·실손 양쪽 영수증 번호가 비어 있어 같은 치료비인지 판정할 수 없습니다. 이 조항의 청구 서류인 진료비 계산서·영수증과 진료비 세부산정내역으로 확인합니다.`);
    return out.length ? out : ['요청할 실손 서류는 이 조항이 정한 청구 서류(진료비 계산서·영수증, 진료비 세부산정내역 등) 안에서 고릅니다.'];
  },
  autoDocs: (e) => ((e.cross_links || []).some((l) => l.verdict === '판정 불가')
    ? ['같은 치료비의 자동차보험 쪽 지급 근거는 이 조항의 손해액 증명 서류(진단서 등)로 대조합니다.']
    : ['요청할 자동차보험 서류는 이 조항이 정한 제출 서류(보험금 청구서, 손해액 증명 서류 등) 안에서 고릅니다.']),
};
const SEARCHED = ['담당자 질문으로 찾은 조항입니다. 코드 판정과 직접 연결된 조항은 아니니 원문을 함께 확인하세요.'];

const RULES = [
  // 같은 치료비를 자동차보험과 실손에서 받은 경우의 근거
  { when: (e) => verdicts(e).some((v) => v === '중복 확실' || v === '중복 의심'), use: ['autoComp'] },
  { when: (e) => verdicts(e).includes('고지 확인'), use: ['injury'] },
  // 사고 전 같은 부위 진료(기왕증): 판정 이름이 아니라 연결마다 붙는 표시. 서류 안내보다 이 건에 직접 걸리므로 먼저
  { when: (e) => (e.cross_links || []).some((l) => l.prior_claim_ids?.length), use: ['priorCond'] },
  { when: (e) => verdicts(e).includes('판정 불가'), use: ['medClaim', 'autoDocs'] },
  // 치료 기간 지표는 팀 기준(같은 집단 상위 5%)이라 약관 4주 기준을 자동으로 붙이지 않습니다. 질문 검색으로는 찾을 수 있습니다.
];
const verdicts = (e) => (e.cross_links || []).map((l) => l.verdict);

/* 글자 2개 단위 토큰. 띄어쓰기가 불규칙한 약관 원문에도 맞도록 공백과 기호를 지우고 자릅니다. */
const grams = (text) => {
  const s = String(text).replace(/[^가-힣A-Za-z0-9]/g, '');
  const out = [];
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
  return out;
};

/* 질문 표현 → 약관 용어. 담당자 말투와 약관 용어가 달라 글자 비교로 못 찾는 경우를 넓혀 줍니다.
 * 보험 실무에서 흔한 대응만 넣습니다(평가 질문 하나에 맞춘 항목 금지). 검색어에 덧붙일 뿐 원래 질문은 그대로 씁니다. */
const SYNONYMS = [
  [/렌트|렌터카/, '대차료 대여자동차'], [/팔(면|았|고)|매도|넘기/, '양도'], [/새 ?차로 바꾸|차를 바꾸/, '교체'],
  [/취소|철회/, '청약의 철회'], [/태워|동승/, '동승자'], [/두 군데|여러 군데|다른 (회사|보험).*(가입|들어)|중복 가입/, '다수보험'],
  [/여러 개|여러 대|분담/, '보험금의 분담'], [/몇 년|기간이 지나|소멸/, '소멸시효'], [/알려야|알리|통보/, '통지 알릴 의무'],
  [/숨기|숨겼|속이|속였/, '계약 전 알릴 의무'], [/먼저 받|미리 받|미리 달|미리 줄/, '가지급금'], [/술|음주/, '음주운전'],
  [/전부터 아프|원래.*(안 좋|아프)|기존 (질환|병)|기왕증/, '기왕증'], [/서류/, '청구 서류 제출'],
  [/보험 안 든|무보험|뺑소니/, '무보험자동차'], [/(운전자|본인|내가) ?(본인이 )?다쳤|자기신체/, '자기신체사고'],
  [/내 차.*(부서|파손|수리)|자기차량/, '자기차량손해'], [/최대 얼마|한도/, '보험가입금액 한도'], [/보험료가 오르|할증|할인/, '요율 상대도 할증'],
  [/해지하면|돌려받|돌려주|환급/, '해약환급금 환급'], [/위조|변조|고친|조작/, '중대사유 해지 보험사기'], [/이자/, '적립이율 지연'],
  [/장례/, '장례비'], [/위자료/, '위자료'], [/못 번|휴업/, '휴업손해'],
];
const expand = (q) => [q, ...SYNONYMS.filter(([re]) => re.test(q)).map(([, w]) => w)].join(' ');
/* 질문에 약관 구분이 드러나면 그 약관 조항을 우대(곱함) */
const DOC_HINT = [[/실손|의료비|병원비|비급여|입원|통원|외래|치과|한방|도수|MRI/, (doc) => doc.startsWith('실손')],
  [/자동차|운전|교통사고|대인|대물|차량|렌트|동승|무보험/, (doc) => doc.startsWith('자동차')]];
const TITLE_WEIGHT = 2;  // 조항 제목에 든 글자 점수 배수(제목이 곧 주제인 경우가 많음)
const DOC_BOOST = 1.5;

/** 조항 원문을 len 글자로 줄입니다. has가 있으면 그 글자 주변, 없으면 질문(표현 사전 포함)과 겹치는 글자 2개가 가장 많은 구간. */
export function excerpt(chunk, has, question = '', len = EXCERPT) {
  const text = chunk.text.replace(/\n/g, ' ');
  if (text.length <= len) return text;
  if (has) { const at = Math.max(0, text.indexOf(has) - 150); return text.slice(at, at + len); }
  const q = new Set(grams(expand(question)));
  const sum = [0];
  for (let i = 0; i < text.length; i += 1) sum.push(sum[i] + (q.has(text.slice(i, i + 2)) ? 1 : 0));
  let best = 0;
  for (let i = 1; i + len <= text.length; i += 1) if (sum[i + len] - sum[i] > sum[best + len] - sum[best]) best = i;
  // 겹치는 글자들이 창 가운데 오게 옮겨 앞뒤 문맥을 함께 담음
  let first = -1, last = -1;
  for (let i = best; i < best + len; i += 1) if (sum[i + 1] > sum[i]) { if (first < 0) first = i; last = i + 1; }
  let at = first < 0 ? 0 : Math.min(Math.max(0, Math.round((first + last) / 2 - len / 2)), text.length - len);
  const cut = text.lastIndexOf(' ', at);
  if (cut >= 0 && at - cut < 20) at = cut + 1;  // 단어 중간에서 시작하지 않게
  return text.slice(at, at + len);
}
export { expand, TERM };

export function createTermsRag(chunks = loadTerms()) {
  const find = (key) => {
    const t = TERM[key];
    const found = chunks.find((c) => c.doc === t.doc && c.article === t.article && c.text.includes(t.has));
    if (!found) throw Error(`약관 매핑 오류: ${t.doc} ${t.article}`);
    return { key, chunk: found, has: t.has, summary: t.summary };
  };
  const mapped = Object.fromEntries(Object.keys(TERM).map((k) => [k, find(k)])); // 시작할 때 전부 확인

  // BM25 색인
  const docs = chunks.map((c) => grams(`${c.title} ${c.text}`));
  const df = new Map();
  docs.forEach((g) => new Set(g).forEach((x) => df.set(x, (df.get(x) || 0) + 1)));
  const avg = docs.reduce((n, g) => n + g.length, 0) / docs.length;
  const tf = docs.map((g) => g.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map()));
  const titles = chunks.map((c) => new Set(grams(c.title)));

  function search(question, k = 2, minScore = MIN_SCORE) {
    const q = [...new Set(grams(expand(question)))];
    if (!q.length) return [];
    const hints = DOC_HINT.filter(([re]) => re.test(question)).map(([, ok]) => ok);
    const scored = chunks.map((c, i) => {
      let score = 0;
      for (const x of q) {
        const f = tf[i].get(x);
        if (!f) continue;
        const idf = Math.log(1 + (chunks.length - df.get(x) + 0.5) / (df.get(x) + 0.5));
        score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].length / avg));
        if (titles[i].has(x)) score += idf * TITLE_WEIGHT;
      }
      if (hints.length && hints.some((ok) => ok(c.doc))) score *= DOC_BOOST;
      return { chunk: c, score };
    });
    // MIN_SCORE: "왜 보류인가요?"처럼 약관과 무관한 질문에 엉뚱한 조항이 붙지 않게 하는 하한 (조각 정리 후 195조각에서도 확인)
    return scored.filter((s) => s.score >= minScore).sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)).slice(0, k);
  }

  /* llm: LLM에 보낼 내용(매핑 조항은 요약+적용 문장, 검색 조항은 발췌). full: 화면 '원문 보기'의 조각 전문.
   * apply: 이 사람에게 어떻게 적용되는지(코드가 쓴 문장). */
  const view = ({ key, chunk, has, summary }, evidence, question) => {
    const apply = key ? APPLY[key](evidence) : SEARCHED;
    return {
      ref: chunk.id, cite: chunk.cite, full: chunk.text, apply,
      llm: summary ? { ref: chunk.id, cite: chunk.cite, summary, apply } : { ref: chunk.id, cite: chunk.cite, text: excerpt(chunk, has, question) },
    };
  };

  /** 작업 종류(explain, ask, request, gap)에 맞는 조항을 최대 3개 고릅니다. */
  function termsFor(kind, evidence, question = '') {
    const keys = RULES.filter((r) => r.when(evidence)).flatMap((r) => r.use);
    if (kind === 'request' || kind === 'gap') keys.push('medClaim', 'autoDocs'); // 서류 안내의 근거
    const picked = [...new Set(keys)].map((k) => mapped[k]);
    // 판정으로 정해진 조항이 이미 있으면 검색 조항은 1개만: 글자만 겹치는 엉뚱한 조항이 섞이는 것을 줄입니다.
    if (kind === 'ask' && question) picked.push(...search(question, picked.length ? 1 : 2).map((s) => ({ chunk: s.chunk })));
    const seen = new Set();
    return picked.filter((p) => !seen.has(p.chunk.id) && seen.add(p.chunk.id)).slice(0, MAX_TERMS).map((p) => view(p, evidence, question));
  }

  return { termsFor, search, chunks };
}
