/**
 * 약관 질문 검색 평가. rag/eval/questions.jsonl의 질문마다 검색 결과를 정답 조항과 비교합니다.
 *   약관 안 질문(gold 있음): Hit@1, Hit@2(앱이 붙이는 개수), MRR@5 — 같은 조의 여러 조각은 한 조로 셉니다.
 *   약관 밖 질문(gold 없음): 아무 조항도 붙이지 않으면 정답(거름 비율).
 * 비교 방식(Baseline):
 *   제목 매칭   — 질문 단어가 조항 제목에 몇 개 들어 있는지
 *   단어 BM25   — 띄어쓰기 단위 BM25 (한국어 조사가 붙어 있어 같은 말도 다른 단어가 됨)
 *   글자 2개 BM25 — 현재 앱 방식(terms-rag.mjs search)
 * 실행: node rag/eval/eval-search.mjs   (점수 하한별 표: --sweep)
 */
import { readFileSync } from 'node:fs';
import { createTermsRag } from '../../terms-rag.mjs';

const DOCS = { 실손: '실손의료보험 표준약관(기본형)', 특약1: '실손의료보험 특별약관1(중증 비급여)', 특약2: '실손의료보험 특별약관2(비중증 비급여)', 자동차: '자동차보험 표준약관' };
const key = (c) => `${c.doc}|${c.article}`;
const goldKey = (g) => { const [d, a] = g.split(' '); return `${DOCS[d]}|${a}`; };

// 개발용(questions.jsonl, 개선할 때 봄)과 검증용(questions_test.jsonl, 개선이 끝난 뒤 채점만)을 나눕니다. --test로 검증용 채점
const SET = process.argv.includes('--test') ? './questions_test.jsonl' : './questions.jsonl';
export const questions = readFileSync(new URL(SET, import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rag = createTermsRag();
const { chunks } = rag;

/* 조 단위 순위: 같은 조의 조각은 가장 높은 점수 하나만 */
const byArticle = (scored) => {
  const seen = new Set();
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).filter((s) => !seen.has(key(s.chunk)) && seen.add(key(s.chunk)));
};

/* Baseline 1: 제목 매칭 */
const titleSearch = (q) => {
  const words = q.replace(/[^가-힣A-Za-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
  return byArticle(chunks.map((c) => ({ chunk: c, score: words.filter((w) => c.title.includes(w) || w.includes(c.title)).length })));
};

/* Baseline 2: 띄어쓰기 단어 BM25 (앱과 같은 식, 단위만 단어) */
const tok = (t) => String(t).replace(/[^가-힣A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const wdocs = chunks.map((c) => tok(`${c.title} ${c.text}`));
const wtf = wdocs.map((d) => d.reduce((m, w) => m.set(w, (m.get(w) || 0) + 1), new Map()));
const wdf = new Map(); wdocs.forEach((d) => new Set(d).forEach((w) => wdf.set(w, (wdf.get(w) || 0) + 1)));
const wavg = wdocs.reduce((s, d) => s + d.length, 0) / wdocs.length;
const wordSearch = (q) => byArticle(chunks.map((c, i) => {
  let score = 0;
  for (const w of new Set(tok(q))) {
    const f = wtf[i].get(w); if (!f) continue;
    const idf = Math.log(1 + (chunks.length - wdf.get(w) + 0.5) / (wdf.get(w) + 0.5));
    score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * wdocs[i].length / wavg));
  }
  return { chunk: c, score };
}));

/* 현재 방식: 하한 없이 전체 순위를 받아 하한은 채점 때 적용 */
const gramSearch = (q) => byArticle(rag.search(q, chunks.length, 0));

export function score(search, minScore) {
  const ans = questions.filter((x) => x.gold.length), none = questions.filter((x) => !x.gold.length);
  let hit1 = 0, hit2 = 0, rr = 0;
  const misses = [];
  for (const x of ans) {
    const ranked = search(x.q).filter((s) => s.score >= minScore);
    const gold = new Set(x.gold.map(goldKey));
    const rank = ranked.slice(0, 5).findIndex((s) => gold.has(key(s.chunk)));
    if (rank === 0) hit1++;
    if (rank >= 0 && rank < 2) hit2++; else misses.push(`${x.id} ${x.q} → ${ranked.slice(0, 2).map((s) => `${s.chunk.doc.slice(0, 6)} ${s.chunk.article}`).join(', ') || '없음'}`);
    if (rank >= 0) rr += 1 / (rank + 1);
  }
  const rejected = none.filter((x) => !search(x.q).some((s) => s.score >= minScore)).length;
  return { n: ans.length, hit1: hit1 / ans.length, hit2: hit2 / ans.length, mrr: rr / ans.length, reject: rejected / none.length, nNone: none.length, misses };
}

export const METHODS = { '제목 매칭': [titleSearch, 1], '단어 BM25': [wordSearch, 0.01], '글자 2개 BM25(현재)': [gramSearch, 15] };

if (import.meta.url === `file://${process.argv[1]}`) {
  const pct = (v) => `${(v * 100).toFixed(0)}%`;
  console.log(`질문 ${questions.length}개 (약관 안 ${questions.filter((x) => x.gold.length).length}, 약관 밖 ${questions.filter((x) => !x.gold.length).length})\n`);
  console.log('| 방식 | Hit@1 | Hit@2 | MRR@5 | 약관 밖 질문 거름 |\n|---|---|---|---|---|');
  for (const [name, [fn, min]] of Object.entries(METHODS)) {
    const r = score(fn, min);
    console.log(`| ${name} | ${pct(r.hit1)} | ${pct(r.hit2)} | ${r.mrr.toFixed(2)} | ${pct(r.reject)} |`);
  }
  if (process.argv.includes('--sweep')) {
    console.log('\n글자 2개 BM25 점수 하한별\n| 하한 | Hit@2 | 약관 밖 거름 |\n|---|---|---|');
    for (const m of [0, 8, 10, 12, 13, 14, 15, 16, 17, 18, 20]) { const r = score(gramSearch, m); console.log(`| ${m} | ${pct(r.hit2)} | ${pct(r.reject)} |`); }
  }
  console.log('\n현재 방식에서 상위 2개에 정답이 없는 질문');
  for (const m of score(gramSearch, 15).misses) console.log(' -', m);
}
