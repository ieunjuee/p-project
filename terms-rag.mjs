/* 약관 RAG: LLM 설명에 붙일 표준약관 조항을 찾습니다.
 * 약관은 근거 인용에만 쓰고, 점수·위험도·결과 제안은 바꾸지 않습니다.
 *
 * 조항 데이터: rag/terms_chunks.jsonl (rag/chunk_terms.py가 별표15 표준약관 PDF를 조항 단위로 자른 결과)
 * 찾는 방법 두 가지
 *   1. 고정 매핑: 코드 판정(중복 확실 등)과 걸린 지표에 정해 둔 조항을 붙입니다. 같은 입력이면 같은 조항이 나옵니다.
 *      LLM에는 원문 대신 사람이 쓴 한 줄 요약을 보냅니다.
 *   2. 키워드 검색: 담당자 질문(자유 문장)은 글자 2개 단위 BM25로 가장 비슷한 조항을 찾습니다. 외부 모델이 필요 없습니다. */
import { readFileSync } from 'node:fs';

const MAX_TERMS = 3;      // LLM에 넣는 조항 수
const EXCERPT = 600;      // 검색 조항을 LLM에 넣을 때의 글자 수 (모델 입력 길이 관리)
const MIN_SCORE = 8;      // 키워드 검색 점수 하한
const AUTO = '자동차보험 표준약관';
const MED = '실손의료보험 표준약관(기본형)';

export function loadTerms(file = new URL('./rag/terms_chunks.jsonl', import.meta.url)) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/* 고정 매핑. has는 긴 조항이 여러 조각으로 나뉜 경우 그 내용이 든 조각을 고르는 글자입니다.
 * summary는 사람이 원문을 읽고 쓴 한 줄 요약입니다. 매핑 조항은 LLM에 원문 대신 이 요약만 보내 입력을 줄입니다. */
const TERM = {
  autoComp: { doc: MED, article: '제4조', has: '자동차보험(공제를 포함합니다)에서 보상받는',
    summary: '자동차보험(공제 포함)에서 보상받는 치료관계비는 실손에서 보상하지 않습니다. 다만 자동차보험 기준에 따라 실제 본인이 부담한 의료비는 실손에서 보상합니다.' },
  injury: { doc: MED, article: '붙임1', has: '급격하고 우연한',
    summary: '상해는 보험기간 중 발생한 급격하고 우연한 외래의 사고를 말합니다.' },
  medClaim: { doc: MED, article: '제7조', has: '보험금을',
    summary: '실손 보험금은 청구서, 사고증명서(진료비 계산서·영수증, 진료비 세부산정내역, 입원치료확인서 등), 신분증 등을 제출해 청구합니다.' },
  autoDocs: { doc: AUTO, article: '제27조', has: '제출',
    summary: '자동차보험 보험금은 청구서, 손해액을 증명하는 서류(진단서 등), 교통사고사실확인원 등을 갖춰 청구합니다.' },
};
const RULES = [
  // 같은 치료비를 자동차보험과 실손에서 받은 경우의 근거
  { when: (e) => verdicts(e).some((v) => v === '중복 확실' || v === '중복 의심'), use: ['autoComp'] },
  { when: (e) => verdicts(e).includes('고지 확인'), use: ['injury'] },
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

export function createTermsRag(chunks = loadTerms()) {
  const find = (key) => {
    const t = TERM[key];
    const found = chunks.find((c) => c.doc === t.doc && c.article === t.article && c.text.includes(t.has));
    if (!found) throw Error(`약관 매핑 오류: ${t.doc} ${t.article}`);
    return { chunk: found, has: t.has, summary: t.summary };
  };
  const mapped = Object.fromEntries(Object.keys(TERM).map((k) => [k, find(k)])); // 시작할 때 전부 확인

  // BM25 색인
  const docs = chunks.map((c) => grams(`${c.title} ${c.text}`));
  const df = new Map();
  docs.forEach((g) => new Set(g).forEach((x) => df.set(x, (df.get(x) || 0) + 1)));
  const avg = docs.reduce((n, g) => n + g.length, 0) / docs.length;
  const tf = docs.map((g) => g.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map()));

  function search(question, k = 2) {
    const q = [...new Set(grams(question))];
    if (!q.length) return [];
    const scored = chunks.map((c, i) => {
      let score = 0;
      for (const x of q) {
        const f = tf[i].get(x);
        if (!f) continue;
        const idf = Math.log(1 + (chunks.length - df.get(x) + 0.5) / (df.get(x) + 0.5));
        score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].length / avg));
      }
      return { chunk: c, score };
    });
    // MIN_SCORE: "왜 보류인가요?"처럼 약관과 무관한 질문에 엉뚱한 조항이 붙지 않게 하는 하한 (196조각 기준 실험값)
    return scored.filter((s) => s.score >= MIN_SCORE).sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)).slice(0, k);
  }

  /* 조항 원문을 EXCERPT 글자로 줄입니다. has가 있으면 그 글자 주변을 보여줍니다. */
  const excerpt = (chunk, has) => {
    const text = chunk.text.replace(/\n/g, ' ');
    const at = has ? Math.max(0, text.indexOf(has) - 150) : 0;
    return text.slice(at, at + EXCERPT);
  };
  /* llm: LLM에 보낼 내용(매핑 조항은 요약, 검색 조항은 발췌). full: 화면 '자세히'에 보여줄 조각 전문. */
  const view = ({ chunk, has, summary }) => ({
    ref: chunk.id, cite: chunk.cite, full: chunk.text,
    llm: summary ? { ref: chunk.id, cite: chunk.cite, summary } : { ref: chunk.id, cite: chunk.cite, text: excerpt(chunk, has) },
  });

  /** 작업 종류(explain, ask, request, gap)에 맞는 조항을 최대 3개 고릅니다. */
  function termsFor(kind, evidence, question = '') {
    const keys = RULES.filter((r) => r.when(evidence)).flatMap((r) => r.use);
    if (kind === 'request' || kind === 'gap') keys.push('medClaim', 'autoDocs'); // 서류 안내의 근거
    const picked = [...new Set(keys)].map((k) => mapped[k]);
    // 판정으로 정해진 조항이 이미 있으면 검색 조항은 1개만: 글자만 겹치는 엉뚱한 조항이 섞이는 것을 줄입니다.
    if (kind === 'ask' && question) picked.push(...search(question, picked.length ? 1 : 2).map((s) => ({ chunk: s.chunk })));
    const seen = new Set();
    return picked.filter((p) => !seen.has(p.chunk.id) && seen.add(p.chunk.id)).slice(0, MAX_TERMS).map(view);
  }

  return { termsFor, search, chunks };
}
