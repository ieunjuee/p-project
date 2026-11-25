/* 약관 조각(terms_chunks.jsonl)을 읽기 좋은 Markdown 한 파일(terms_auto_silson.md)로 만듭니다.
 * 실행: node rag/make_terms_md.mjs
 * - 조각의 글은 chunk_terms.py가 PDF에서 정리한 결과 그대로 씁니다(글자를 새로 고치지 않음).
 * - 조각 ID와 원본 별표15 쪽 번호는 HTML 주석으로 남깁니다(화면에는 보이지 않음).
 * - 한 조항이 여러 조각으로 나뉘어 있으면(part_no/parts) 하나의 제목 아래에 이어 붙입니다. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(path.join(dir, 'terms_chunks.jsonl'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => JSON.parse(s));

// Markdown에서 <개정 2015.1.1.> 같은 꺾쇠가 HTML 태그로 사라지지 않게 바꾸고, 줄 끝 공백 2칸으로 원래 줄바꿈을 유지한다
const esc = (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lines = (t) => esc(t).split('\n').map((l) => l.replace(/\s+$/, '')).join('  \n');
// 본문 첫머리에 이미 '제37조(다수보험의 처리)'가 있으면 제목과 겹치므로 본문에서는 뺀다
const stripLabel = (text, article, title) => {
  const label = `${article}(${title})`;
  return text.startsWith(label) ? text.slice(label.length).trimStart() : text;
};
const pageText = (r) => (r.page_end && r.page_end !== r.page ? `${r.page}~${r.page_end}` : `${r.page}`);

const out = [];
out.push('# 표준약관 발췌 (자동차보험, 실손의료보험)', '');
out.push('> 출처: 「보험업감독업무시행세칙」 [별표15] 표준약관(국가법령정보센터). 492쪽 중 자동차보험(개인용, 원본 78~143쪽)과 실손의료보험 기본형, 특별약관1, 특별약관2(원본 204~313쪽)만 발췌했습니다.  ');
out.push('> 기준 버전: 자동차보험 2026.8.28. 개정, 실손의료보험 2026.5.6. 개정 반영본.  ');
out.push(`> 이 문서는 \`rag/terms_chunks.jsonl\`(${rows.length}조각)에서 \`node rag/make_terms_md.mjs\`로 자동 만들었습니다. 직접 고치지 말고 조각이나 스크립트를 고친 뒤 다시 만드세요.  `);
out.push('> 조각 ID와 원본 별표15 쪽 번호는 각 조항 아래 HTML 주석으로 남겼습니다. 이 글은 PDF 원문에서 끊긴 줄바꿈과 표 글자를 정리한 것이라, 법적 효력이 필요한 인용은 원문을 확인하세요.', '');

let doc = null, section = undefined, prevKey = null;
for (const r of rows) {
  if (r.doc !== doc) { doc = r.doc; section = undefined; prevKey = null; out.push(`## ${esc(doc)}`, ''); }
  if (r.section !== section) { section = r.section; if (section) out.push(`### ${esc(section)}`, ''); prevKey = null; }
  const key = `${r.doc}|${r.article}|${r.title}`;
  const continued = r.part_no > 1 && key === prevKey; // 앞 조각에서 이어지는 부분이면 제목을 새로 달지 않는다
  if (!continued) {
    const heading = r.kind === 'intro' ? '머리말' : `${r.article} ${r.title}`.trim();
    out.push(`#### ${esc(heading)}`, '');
  }
  out.push(`<!-- ${r.id} | 별표15 ${pageText(r)}쪽${r.parts > 1 ? ` | ${r.part_no}/${r.parts}` : ''} -->`);
  out.push(lines(r.kind === 'article' ? stripLabel(r.text, r.article, r.title) : r.text), '');
  prevKey = key;
}
const file = path.join(dir, 'terms_auto_silson.md');
writeFileSync(file, out.join('\n'), 'utf8');
console.log(`${path.relative(process.cwd(), file) || file}: ${rows.length}조각, ${out.length}줄`);
