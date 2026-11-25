'use strict';
/* 보험 이력 확인 화면(탭 5개). 계산은 person-engine.js가 하고 이 파일은 표시만 합니다. */
const E = window.PersonLens;
const $ = (q) => document.querySelector(q);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f = (n) => Number(n).toLocaleString('ko-KR');
const money = (n) => f(Math.round(n)) + '원';

/* 분석 기준(탐지 기준 조정)은 브라우저에 저장합니다. 알 수 없는 항목과 숫자가 아닌 값은 버립니다. */
const SETTINGS_KEY = 'insurelens-person-settings';
const loadSettings = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in E.defaults && Number.isFinite(v)));
  } catch { return {}; }
};
const state = { tab: 'home', config: { ...E.defaults, ...loadSettings() }, data: null, labels: null, analysis: null, selected: null, query: '', explanation: null, verification: null, assist: {}, lastChange: null, changeOpen: false,
  priority: 'all', type: 'all', search: '', scoreRange: null, page: 1, reviews: new Map(), source: '가상 데이터', sample: true, counts: null };
const resetPerson = () => { state.explanation = null; state.verification = null; state.assist = {}; };
const tabs = [['home', '검증 홈'], ['overview', '분석 개요'], ['list', '검토 대상'], ['person', '상세 조회 · AI 설명'], ['report', '분석 보고서'], ['check', '검증 결과']];
const tabIcons = { home: 'shield', overview: 'grid', list: 'search', person: 'spark', report: 'file', check: 'check' };
const go = (tab) => { if (state.tab === tab) render(); else location.hash = tab; };

const riskClass = { '높음': 'red', '보통': 'amber', '낮음': 'green', '판단 불가': 'gray' };
const badge = (risk) => `<span class="badge ${riskClass[risk]}">${risk === '높음' ? '● ' : ''}${esc(risk)}</span>`;
const decisionClass = { '지급': 'green', '지급 보류': 'amber', '지급 정지 권고': 'red' };
const verdictClass = { '중복 확실': 'red', '중복 의심': 'amber', '고지 확인': 'amber', '판정 불가': 'gray', '정상 분리 청구': 'green' };

function toast(message) {
  const el = $('#toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 3000);
}

function pageHead(eyebrow, title, desc, actions = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${desc}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
}
const actions = () => `<button class="button" data-action="settings">${icon('sliders')}분석 기준</button><button class="button primary" data-action="data">${icon('upload')}데이터 불러오기</button>`;

function sourceStrip() {
  const s = state.analysis.summary;
  return `<div class="source-strip"><div class="source-left"><strong>${esc(state.source)} ${f(s.count)}명</strong>
  <span class="badge gray">${state.sample ? 'MOCK' : 'DB'}</span>
  <span class="badge ${state.engine === 'SQL' ? 'green' : 'gray'}" title="${state.engine === 'SQL' ? '지표와 교차 판정을 SQLite 쿼리로 계산했습니다' : 'SQLite를 불러오지 못해 JavaScript로 계산했습니다'}">${state.engine === 'SQL' ? '계산: SQLite 쿼리' : '계산: JS 대체'}</span><span class="source-divider"></span>
  <span class="muted">의료 청구 ${f(state.counts.med)}건 · 사고 ${f(state.counts.accidents)}건 · 자동차 청구 ${f(state.counts.autoClaims)}건</span>
  ${state.sample ? `<span class="source-status">· 생성 ${esc(state.data.generated)} · seed ${esc(state.data.seed)}</span>` : ''}</div></div>` + changePanel();
}


function scoreBlock(r) {
  return `<section class="panel detail-summary"><div class="claim-heading"><strong>${esc(r.person_id)}</strong>${badge(r.risk)}
    <span class="badge ${decisionClass[E.decision(r)]}">결과 제안: ${esc(E.decision(r))}</span>
    <span class="muted">${esc(r.person.age_group)} · ${r.person.gender === 'M' ? '남' : '여'}</span></div>
    <div class="key-values">
      <div><span>의료 청구</span><strong>${f(r.counts.med)}건 / ${money(r.paid.med)}</strong></div>
      <div><span>자동차 사고 / 청구</span><strong>${f(r.counts.accidents)}건 / ${f(r.counts.autoClaims)}건</strong></div>
      <div><span>자동차 지급액</span><strong>${money(r.paid.auto)}</strong></div>
      <div><span>겹친 금액</span><strong>${money(r.cross.overlapAmount)}</strong></div>
    </div>
    <div class="score-block"><div class="score-circle">${Math.round(r.scores.overall)}</div>
    <div><h3>종합 위험도 점수</h3><p>${esc(r.reason)}</p>
    <div class="small-scores"><div>의료 점수<strong>${Math.round(r.scores.med)}</strong></div><div>자동차 점수<strong>${Math.round(r.scores.auto)}</strong></div></div></div></div>
    <div class="info-note">종합 점수는 의료 점수와 자동차 점수 중 큰 값입니다. 중복 확실은 점수와 상관없이 높음으로 올립니다. 결과 제안(지급, 지급 보류, 지급 정지 권고)은 참고용이며 최종 결정은 담당자가 합니다.</div></section>`;
}

function signalList(title, signals, hint, cfg) {
  return `<section class="panel section-gap"><div class="panel-head"><h2>${title}</h2>
    <span class="badge gray">의심 신호 ${signals.filter((s) => s.hit).length}개 / ${signals.length}개</span></div>
    <div class="rule-list">${signals.map((s) => `<div class="rule-item ${s.hit ? 'hit' : ''}">
      <span class="rule-state">${s.hit ? '!' : '✓'}</span>
      <div><h4>${esc(s.name)}</h4><p>${esc(E.signalSentence(s, cfg))}</p>
      ${s.evidence.length ? `<p class="muted">근거: ${s.evidence.slice(0, 4).map(esc).join(', ')}${s.evidence.length > 4 ? ` 외 ${s.evidence.length - 4}건` : ''}</p>` : ''}</div>
      <span class="badge ${s.hit ? 'amber' : 'gray'}">${s.observed === null ? '자료 부족' : s.hit ? '의심 신호' : '정상'}</span></div>`).join('')}</div>
    <div class="table-foot"><span>${hint}</span></div></section>`;
}

function crossTable(r) {
  const links = r.cross.links;
  return `<section class="panel section-gap"><div class="panel-head"><div><h2>사고와 진료 교차 확인</h2>
    <p>사고일부터 ${r.config.crossWindowDays}일 안의 손상 진료를 연결해 같은 비용을 두 번 받았는지 봅니다.</p></div>
    <span class="badge ${r.cross.certain.length ? 'red' : 'gray'}">연결 ${links.length}건</span></div>
    ${links.length ? `<div class="table-wrap"><table><thead><tr><th>판정</th><th>사고</th><th>의료 청구</th><th>병명 / 부위</th><th>지급액 (자동차 / 의료)</th><th>근거</th></tr></thead><tbody>
    ${links.map((l) => `<tr><td><span class="badge ${verdictClass[l.verdict]}">${esc(l.verdict)}</span></td>
      <td>${esc(l.accident_id)}<br><span class="muted">${esc(l.accident_date)} · ${esc(l.accident_type)}</span></td>
      <td>${esc(l.claim_id)}<br><span class="muted">${esc(l.visit_date)}</span></td>
      <td>${esc(l.disease_code)} · ${esc(l.body_part)}</td>
      <td>${l.auto_paid === null ? '—' : money(l.auto_paid)} / ${money(l.med_paid)}</td>
      <td>${esc(l.reason)}${l.prior.length ? `<br><span class="badge amber">기왕증 확인</span> 사고 전 ${r.config.priorDays}일 내 같은 부위 진료 ${l.prior.length}건 (${l.prior.slice(0, 3).map(esc).join(', ')})` : ''}</td></tr>`).join('')}
    </tbody></table></div><div class="table-foot"><span>겹친 금액 ${money(r.cross.overlapAmount)} · 연결된 의료 지급액 대비 ${(r.cross.overlapRatio * 100).toFixed(1)}%</span></div>`
    : '<div class="panel-body"><div class="info-note">사고와 연결되는 손상 진료가 없습니다. 교차 확인 대상이 아닙니다.</div></div>'}</section>`;
}

function claimTables(r) {
  const flagged = new Set();
  for (const s of [...r.signals.med, ...r.signals.auto]) for (const id of s.evidence) flagged.add(id);
  for (const l of r.cross.links) if (l.verdict !== '정상 분리 청구') { flagged.add(l.claim_id); if (l.auto_claim_id) flagged.add(l.auto_claim_id); }
  const mark = (id) => flagged.has(id) ? '<span class="tag">근거</span>' : '';
  const med = r.records.med, auto = r.records.autoClaims, acc = r.records.accidents;
  return `<section class="panel section-gap"><div class="panel-head"><div><h2>이 사람의 청구 기록</h2>
    <p>지표나 교차 확인의 근거가 된 청구에 표시했습니다.</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>의료 청구</th><th>진료일</th><th>병명</th><th>치료</th><th>병원</th><th>영수증</th><th>청구 / 지급</th><th>구분</th><th></th></tr></thead><tbody>
    ${med.map((m) => `<tr><td>${esc(m.claim_id)}</td><td>${esc(m.visit_date)}</td><td>${esc(m.disease_code)}</td><td>${esc(m.treatment_type)}</td>
      <td>${esc(m.hospital_id)}</td><td>${m.receipt_no ? esc(m.receipt_no) : '<span class="muted">없음</span>'}</td>
      <td>${money(m.claim_amount)} / ${money(m.paid_amount)}</td><td>${esc(m.accident_flag)}</td><td>${mark(m.claim_id)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">의료 청구가 없습니다.</td></tr>'}
    </tbody></table></div>
    <div class="table-wrap section-gap"><table><thead><tr><th>자동차 청구</th><th>사고</th><th>사고일 / 유형</th><th>종류</th><th>병원</th><th>영수증</th><th>치료 기간</th><th>청구 / 지급</th><th></th></tr></thead><tbody>
    ${auto.map((c) => { const a = acc.find((x) => x.accident_id === c.accident_id) || {}; return `<tr><td>${esc(c.auto_claim_id)}</td><td>${esc(c.accident_id)}</td>
      <td>${esc(a.accident_date || '')} · ${esc(a.accident_type || '')}</td><td>${esc(c.claim_type)}</td>
      <td>${c.hospital_id ? esc(c.hospital_id) : '<span class="muted">—</span>'}</td><td>${c.receipt_no ? esc(c.receipt_no) : '<span class="muted">없음</span>'}</td>
      <td>${c.treat_start ? esc(c.treat_start) + ' ~ ' + esc(c.treat_end) : '<span class="muted">—</span>'}</td>
      <td>${money(c.amount)} / ${money(c.paid_amount)}</td><td>${mark(c.auto_claim_id)}</td></tr>`; }).join('') || '<tr><td colspan="9" class="empty">자동차 청구가 없습니다.</td></tr>'}
    </tbody></table></div></section>`;
}

function explanationPanel(r) {
  const x = state.explanation;
  return `<section class="panel ai-panel"><div class="ai-status"><h2>${icon('spark')}AI 검토 어시스턴트</h2>
    <span class="badge ${x && x.provider === 'api' ? 'green' : 'gray'}">${x && x.provider === 'api' ? 'LLM 연결' : '데모 설명'}</span></div>
    ${x ? `<div class="ai-result"><h3>01 · 요약</h3><p>${esc(x.summary)}</p>
      <h3>02 · 근거</h3><ul>${x.basis.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
      ${Array.isArray(x.causes) && x.causes.length ? `<h3>03 · 원인 후보 <span class="muted">(확정이 아닌 가능한 설명)</span></h3><ul>${x.causes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
      <h3>${Array.isArray(x.causes) && x.causes.length ? '04' : '03'} · 확인할 항목 (권장 조치)</h3><ul>${x.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>${termsBlock(x.terms)}
      <p class="provider">${x.provider === 'api' ? 'LLM이 코드가 만든 근거 JSON을 바탕으로 작성했습니다.' : 'LLM 미연결 · 코드가 계산한 수치로 만든 데모 설명입니다.'}</p></div>
      ${state.verification ? `<div class="info-note ${state.verification.ok ? '' : 'warning'}">수치 검증: ${state.verification.ok
        ? '설명에 나온 모든 숫자와 근거 번호가 코드 계산 결과와 일치합니다.'
        : `코드 계산 결과에 없는 값 ${esc([...state.verification.badNumbers, ...state.verification.badIds, ...(state.verification.badTerms || [])].slice(0, 5).join(', '))} 을 발견해 이 설명을 무효 처리했습니다.`}</div>` : ''}
      <button class="button link section-gap" data-action="explain">설명 다시 생성</button>`
    : `<div class="ai-placeholder"><h3>숫자를 업무의 언어로</h3><p>이 사람의 위험도 근거를 정리하고,<br>확인할 항목을 제시합니다.</p>
      <button class="button primary" data-action="explain">설명 생성</button></div>`}
    <p class="muted" style="font-size:9px;margin-top:14px;line-height:1.8">LLM은 점수와 위험도를 바꾸지 않습니다. 코드가 정한 결과를 설명만 합니다.</p></section>`;
}

/* 관련 약관: 조항 이름을 누르면 원문 조각을 펼칩니다(LLM을 거치지 않은 원문). */
/* 조항 원문: 마크다운 표 줄(| 로 시작)은 표로, 나머지는 줄바꿈을 살린 문단으로 보여 줍니다. */
const termText = (text) => {
  const out = [];
  let para = [], table = [];
  const td = (tag, c) => `<${tag} style="border:1px solid #dfe6e2;padding:3px 6px;text-align:left;vertical-align:top">${esc(c)}</${tag}>`;
  const flush = () => {
    if (para.length) out.push(`<p style="white-space:pre-wrap;margin:0">${esc(para.join('\n'))}</p>`);
    const rows = table.filter((r) => !/^\|(-+\|)+$/.test(r)).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    if (rows.length) out.push(`<table style="border-collapse:collapse;margin:6px 0;font-size:10px;width:100%;white-space:normal"><tr>${rows[0].map((c) => td('th', c)).join('')}</tr>${rows.slice(1).map((r) => `<tr>${r.map((c) => td('td', c)).join('')}</tr>`).join('')}</table>`);
    para = []; table = [];
  };
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('|') !== (table.length > 0)) flush();
    (line.startsWith('|') ? table : para).push(line);
  }
  flush();
  return out.join('');
};
/* 관련 약관: 조항 이름, 이 건에 어떻게 적용되는지(코드가 근거 데이터로 쓴 문장), 펼치면 조항 원문 */
const termsBlock = (terms) => ((terms || []).length ? `<div class="section-gap"><h3>관련 약관</h3>${terms.map((t) => `<div style="margin-top:10px;font-size:11px"><strong style="color:#3d5a50">${esc(t.cite)}</strong>
  ${(t.apply || []).length ? `<ul style="margin:4px 0 0;padding-left:17px">${t.apply.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
  <details style="margin-top:4px"><summary style="cursor:pointer;color:#7d9183">조항 원문 보기</summary>
  <div style="line-height:1.8;color:#4b5d52;margin:6px 0 0;max-height:260px;overflow:auto">${termText(t.text)}</div></details></div>`).join('')}
  <p class="muted" style="font-size:9px;margin-top:6px">원문은 표준약관(보험업감독업무시행세칙 별표15)이고, 적용 내용은 코드가 이 사람의 판정과 근거로 쓴 문장입니다. 약관은 근거 확인용이며 점수와 결과 제안을 바꾸지 않습니다.</p></div>` : '');
/** 서버가 함께 보낸 약관 조항까지 넣어 검증합니다. 조항 번호(제4조 등)를 지어낸 숫자로 보지 않게 합니다. */
/* 브라우저는 서버(LLM_TIMEOUT_MS 기본 120초)보다 오래 기다립니다. 30초면 서버가 아직 LLM을 기다리는 중에 화면이 먼저 데모로 바뀝니다. */
const LLM_WAIT_MS = 130000;
const verifyWithTerms = (payload, result) => E.verifyExplanation({ ...payload, terms: result.terms || [] }, result);

const assistBadge = (x) => `<span class="badge ${x.result.provider === 'api' ? 'green' : 'gray'}">${x.result.provider === 'api' ? 'LLM 연결' : '데모 답변'}</span>`;
const assistCheck = (x) => (x.check && !x.check.ok ? `<div class="info-note warning">수치 검증에서 코드 계산에 없는 값을 발견해 데모 답변으로 대체했습니다.</div>` : '');

function askPanel(r) {
  const x = state.assist.ask;
  const chips = [`왜 ${E.decision(r)}인가요?`, '정상일 수 있는 이유는?', '무엇을 확인해야 하나요?'];
  return `<section class="panel ai-panel section-gap"><div class="ai-status"><h2>담당자 질문</h2>${x ? assistBadge(x) : ''}</div>
    <form class="question-form" data-form="ask"><input id="ask-input" placeholder="예: ${esc(chips[0])}" value="${esc(x ? x.question : '')}" aria-label="질문 입력" maxlength="300">
      <button class="button primary" type="submit">질문</button></form>
    <div class="suggestions">${chips.map((c) => `<button class="suggestion" type="button" data-ask="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    ${x ? `<div class="chat-answer"><strong>${esc(x.question)}</strong>
      <p style="font-size:12px;font-weight:650;color:#3f6650;line-height:1.8">${esc(x.result.answer)}</p>
      ${(x.result.points || []).length ? `<ul style="margin:8px 0 0;padding-left:17px">${x.result.points.map((p) => `<li style="margin-bottom:4px">${esc(p)}</li>`).join('')}</ul>` : ''}
      ${x.result.citations.length ? `<div style="margin-top:10px">${x.result.citations.map((id) => `<span class="tag">${esc(id)}</span>`).join('')}</div>` : ''}${termsBlock(x.result.terms)}</div>${assistCheck(x)}` : ''}
    <p class="muted" style="font-size:9px;margin-top:12px;line-height:1.8">답은 코드가 계산한 근거 안에서만 만들고, 숫자와 번호는 코드가 다시 확인합니다.</p></section>`;
}

function requestPanel(r) {
  if (E.decision(r) === '지급') return '';
  const x = state.assist.request;
  return `<section class="panel ai-panel section-gap"><div class="ai-status"><h2>증빙 요청서 초안</h2>${x ? assistBadge(x) : ''}</div>
    ${x ? `<div class="ai-result"><div style="border:1px solid #e2eae4;border-radius:9px;overflow:hidden;margin-top:16px">
        <div style="background:#f4f8f5;padding:11px 14px;font-size:11px;color:#6d8275;border-bottom:1px solid #e2eae4;line-height:2">
          <div><span style="display:inline-block;width:52px;color:#9aa89e">받는 분</span>고객</div>
          <div><span style="display:inline-block;width:52px;color:#9aa89e">제목</span><input id="request-subject" value="${esc(x.result.subject || '')}" style="width:calc(100% - 60px);padding:3px 7px;font-size:11px;font-weight:650" aria-label="메일 제목"></div></div>
        <textarea id="request-text" rows="${Math.min(26, String(x.result.message).split('\n').length + 3)}" style="width:100%;border:0;border-radius:0;padding:14px;font-size:12px;line-height:1.9;resize:vertical" aria-label="메일 본문">${esc(x.result.message)}</textarea></div>
      ${(x.result.guarded || []).length ? `<div class="info-note warning">내부 기준이 드러나거나 압박하는 문구가 있어 코드가 기본 문구로 바꿨습니다: ${esc(x.result.guarded.join(', '))}</div>` : ''}
      <div style="margin-top:12px"><button class="button" data-action="copy-request">메일 전체 복사</button></div>${termsBlock(x.result.terms)}</div>${assistCheck(x)}
      <button class="button link section-gap" data-action="request">초안 다시 생성</button>`
    : `<div class="ai-placeholder"><p>보류 건에 고객에게 보낼 증빙 요청 이메일을 초안으로 만듭니다.</p>
      <button class="button primary" data-action="request">초안 생성</button></div>`}
    <p class="muted" style="font-size:9px;margin-top:12px;line-height:1.8">초안입니다. 담당자가 확인하고 직접 보냅니다. 시스템은 고객에게 아무것도 보내지 않습니다.</p></section>`;
}

function gapPanel(r) {
  if (r.risk !== '판단 불가') return '';
  const x = state.assist.gap;
  return `<section class="panel ai-panel section-gap"><div class="ai-status"><h2>판단 불가 보완</h2>${x ? assistBadge(x) : ''}</div>
    ${x ? `<div class="ai-result"><p>${esc(x.result.summary)}</p>
      <h3>비어 있는 값</h3><ul>${x.result.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
      <h3>이렇게 확인하면 판단됩니다</h3><ol style="margin:0;padding-left:20px">${x.result.how.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>${termsBlock(x.result.terms)}</div>${assistCheck(x)}
      <button class="button link section-gap" data-action="gap">다시 생성</button>`
    : `<div class="ai-placeholder"><p>영수증 번호가 비어 판단할 수 없는 이유와, 무엇을 확인하면 판단되는지 정리합니다.</p>
      <button class="button primary" data-action="gap">확인할 것 제안</button></div>`}</section>`;
}

/* ---- main 의 상세 화면 구성 요소: 단계 표시, 비교 가능한 지표, 담당자 검토 기록 ---- */
function pipeline() {
  return `<div class="pipeline">${[['데이터 검증', '1'], ['이력 연결', '2'], ['의료·자동차 신호 계산', '3'], ['근거·설명 생성', '4'], ['담당자 검토', '5']].map(([s, n], i) => `${i ? '<span class="pipeline-arrow">›</span>' : ''}<div class="pipeline-item"><span class="step-number">${n}</span>${s}</div>`).join('')}</div>`;
}

function compareMetrics(r) {
  const values = [['의료 지급액', r.paid.med, '#538e71'], ['자동차 지급액', r.paid.auto, '#7fb0c9'], ['겹친 금액', r.cross.overlapAmount, '#d98c7a']];
  const max = Math.max(...values.map((v) => v[1] || 0), 1);
  return `<section class="panel section-gap"><div class="panel-head"><h2>비교 가능한 지표</h2></div><div class="panel-body">
    ${values.map(([name, v, color]) => `<div class="comparison-row"><p><span>${name}</span><strong>${money(v || 0)}</strong></p><div class="bar-track"><div class="bar-fill" style="width:${(v || 0) / max * 100}%;background:${color}"></div></div></div>`).join('')}
    <div class="key-values section-gap"><div><span>사고 / 사고 관련 청구</span><strong>${f(r.counts.accidents)}건 / ${f(r.counts.autoClaims)}건</strong></div>
      <div><span>연결된 의료 지급액 대비 겹침</span><strong>${(r.cross.overlapRatio * 100).toFixed(1)}%</strong></div></div>
    <div class="info-note">${icon('info')}겹친 금액은 같은 비용일 수 있는 부분이며, 그것만으로 사기라고 단정하지 않습니다.</div></div></section>`;
}

function reviewRecord(r) {
  const saved = state.reviews.get(r.person_id) || {};
  return `<section class="panel section-gap"><div class="panel-head"><h2>담당자 검토 기록</h2></div><div class="panel-body">
    <p class="muted" style="font-size:11px">근거 확인 후 검토 상태와 메모를 남기세요.</p>
    <form class="review-form" id="review-form"><label for="review-note">검토 메모</label>
      <textarea id="review-note" maxlength="2000" placeholder="확인한 서류, 추가 확인 사유 등">${esc(saved.note || '')}</textarea>
      <div class="row"><select id="review-status" aria-label="검토 상태">${['미검토', '추가 확인 필요', '검토 완료'].map((s) => `<option ${saved.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><button type="submit" class="button primary">저장</button></div></form>
    <p class="muted" style="font-size:9px;margin-top:10px">메모는 현재 브라우저 탭에서만 유지됩니다.</p></div></section>`;
}

function detail(r) {
  return `<div class="detail-grid"><div>${scoreBlock(r)}
    ${signalList('규칙별 탐지 근거 · 의료', r.signals.med, `같은 병명 기준 ${r.config.medWindowDays}일 관찰 · 기준값은 초안입니다.`, r.config)}
    ${signalList('규칙별 탐지 근거 · 자동차', r.signals.auto, `${r.config.autoWindowDays}일 관찰 · 기준값은 초안입니다.`, r.config)}
    ${compareMetrics(r)}</div>
    <div>${explanationPanel(r)}${askPanel(r)}${requestPanel(r)}${gapPanel(r)}${reviewRecord(r)}
    <section class="panel section-gap"><div class="panel-head"><h2>위험도 구간</h2></div><div class="panel-body">
      <div class="rule-list">
        <div class="rule-item ${r.risk === '낮음' ? 'hit' : ''}"><span class="rule-state">1</span><div><h4>낮음 (${r.config.medium}점 미만)</h4><p>간단히 확인 후 지급 검토</p></div></div>
        <div class="rule-item ${r.risk === '보통' ? 'hit' : ''}"><span class="rule-state">2</span><div><h4>보통 (${r.config.medium}~${r.config.high}점, 또는 확인 항목 있음)</h4><p>확인 항목을 보고 판단</p></div></div>
        <div class="rule-item ${r.risk === '높음' ? 'hit' : ''}"><span class="rule-state">3</span><div><h4>높음 (${r.config.high}점 이상, 또는 중복 확실)</h4><p>증빙 요청과 상세 조사</p></div></div>
        <div class="rule-item ${r.risk === '판단 불가' ? 'hit' : ''}"><span class="rule-state">?</span><div><h4>판단 불가</h4><p>영수증 번호 등 핵심 값이 비어 중복 여부를 확인할 수 없음</p></div></div>
      </div></div></section></div></div>${crossTable(r)}${claimTables(r)}`;
}

const current = () => state.analysis.results.find((x) => x.person_id === state.selected) || state.analysis.results[0];
const riskOrder = { '높음': 0, '판단 불가': 1, '보통': 2, '낮음': 3 };

function metric(label, value, unit, foot, extra = '') {
  return `<div class="metric ${extra}"><div class="metric-label">${label}</div><div class="metric-number">${value}<small>${unit}</small></div><div class="metric-foot">${foot}</div></div>`;
}

function barRow(label, count, total, color) {
  const pct = total ? count / total * 100 : 0;
  return `<div class="bar-row" style="grid-template-columns:78px 1fr 90px"><span>${esc(label)}</span>
    <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
    <span>${f(count)}명 (${pct.toFixed(1)}%)</span></div>`;
}

/* ---- 분석 개요: main 의 분석 개요와 같은 그래프를 사람 단위 결과로 그립니다 ----
   월별 추이, 보험 유형, 금액 히스토그램은 청구 한 건을 한 줄로 보고, 우선순위 도넛은 사람 수로 셉니다. */
const C = window.LensCharts;
const chartColors = { ...C.colors, '판단 불가': '#c5cdd1' };
state.chartViews = { types: 'bar', trend: 'count' };

function claimRows() {
  const rows = [];
  for (const r of state.analysis.results) {
    for (const m of r.records.med) rows.push({ claim_id: m.claim_id, customer_id: r.person_id, insurance_type: '실손(의료)', amount: m.claim_amount, claim_date: m.visit_date, priority: r.risk });
    for (const c of r.records.autoClaims) rows.push({ claim_id: c.auto_claim_id, customer_id: r.person_id, insurance_type: '자동차', amount: c.amount, claim_date: c.claim_date, priority: r.risk });
  }
  return rows;
}
const chartSwitch = (name, options, label) => `<div class="segmented" role="group" aria-label="${label}">${options.map(([value, text]) => `<button data-chart-view="${name}" data-chart-mode="${value}" aria-pressed="${state.chartViews[name] === value}">${text}</button>`).join('')}</div>`;
const noHelp = (html, text = '') => html.replace(/<div class="plot-help">.*?<\/div>/g, text ? `<div class="plot-help">${text}</div>` : '');

function overview() {
  const a = state.analysis, s = a.summary, res = a.results, rows = claimRows();
  const colored = rows.filter((x) => x.priority in C.colors); // 판단 불가인 사람의 청구는 색을 정할 수 없어 히스토그램에서 뺍니다
  const amounts = rows.map((x) => x.amount), months = C.monthlySeries(rows);
  const series = ['높음', '보통', '낮음', '판단 불가'].map((label) => ({ label, value: s[label], color: chartColors[label] }));
  const hitCount = (kind, i) => res.filter((r) => r.signals[kind][i].hit).length;
  const verdicts = ['중복 확실', '중복 의심', '고지 확인', '판정 불가'];
  const verdictCount = (v) => res.filter((r) => r.cross.links.some((l) => l.verdict === v) || (v === '고지 확인' && r.cross.links.some((l) => l.prior.length))).length;
  const top = sortedPersons(res).slice(0, 5);
  const chips = `<div class="stat-chips"><div class="stat-chip">가운데 값<strong>${money(C.quantile(amounts, .5))}</strong><span class="stat-hint">금액 순으로 줄 세웠을 때 한가운데 청구</span></div><div class="stat-chip">상위 10% 시작<strong>${money(C.quantile(amounts, .9))}</strong><span class="stat-hint">전체 청구의 90%가 이 금액 이하</span></div><div class="stat-chip">최대 청구 금액<strong>${money(Math.max(...amounts))}</strong><span class="stat-hint">잘라내지 않은 실제 최대값</span></div></div>`;
  const skipped = rows.length - colored.length;
  return pageHead('OVERVIEW', '전체 사람들의 위험 현황을 한눈에 봅니다.',
    '가상 데이터에 있는 사람을 모두 계산해, 위험도별 인원과 청구 분포를 보여줍니다.', actions()) + sourceStrip() +
    `<div class="metric-grid">${metric('전체 사람', f(s.count), '명', '자동차와 의료 이력을 합쳐서 계산')}
      ${metric('위험도 높음', f(s['높음']), '명', `전체의 ${(s['높음'] / s.count * 100).toFixed(1)}% · 증빙 요청과 상세 조사 대상`, 'high')}
      ${metric('위험도 보통', f(s['보통']), '명', '확인 항목을 보고 판단')}
      ${metric('판단 불가', f(s['판단 불가']), '명', '영수증 번호가 비어 중복 여부를 알 수 없음')}</div>
    <div class="dashboard-grid"><div class="left-column">
      <section class="panel"><div class="panel-head chart-panel-head"><div><h2>월별 청구 추이</h2><p>청구 발생일 기준 · 의료와 자동차 청구 합계</p></div>${chartSwitch('trend', [['count', '건수'], ['total', '금액']], '월별 추이 지표')}</div>${noHelp(C.monthlyHTML(rows, state.chartViews.trend))}<div class="chart-bottom"><span>${months[0].month} — ${months.at(-1).month}</span><span>월별 집계 · 단위: ${state.chartViews.trend === 'count' ? '건' : '원'}</span></div></section>
    </div><div class="right-column">${aiBriefing()}
      <section class="panel section-gap"><div class="panel-head"><h2>분석 기준 안내</h2>${icon('shield')}</div><div class="panel-body"><p class="muted" style="font-size:11px;line-height:1.95">점수는 의심 신호가 걸린 개수 × 20점이고, 종합 점수는 의료 점수와 자동차 점수 중 큰 값입니다. 같은 비용을 둘 다 받은 것이 확실하면(중복 확실) 점수와 상관없이 <strong>높음</strong>입니다.</p><button class="button link section-gap" data-action="settings">탐지 기준 조정 ${icon('arrow')}</button></div></section>
      <section class="panel section-gap"><div class="panel-head"><div><h2>사고와 진료 교차 확인 결과</h2><p>해당 판정이 한 건이라도 있는 사람 수</p></div></div>
      <div class="horizontal-bars">${verdicts.map((v) => barRow(v, verdictCount(v), s.count, v === '중복 확실' ? '#d98c7a' : '#e6bd7a')).join('')}</div></section></div></div>
    <div class="subgrid wide-pair"><section class="panel"><div class="panel-head chart-panel-head"><div><h2>검토 우선순위 분포</h2><p>사람 수 기준 · 범례를 누르면 해당 사람 목록으로 이동합니다</p></div></div>${noHelp(C.pieHTML(series, { mode: 'donut', filter: 'priority', label: '검토 우선순위 분포', unit: '명', totalLabel: '전체 사람' }))}</section>
      <section class="panel"><div class="panel-head chart-panel-head"><div><h2>보험 유형별 청구</h2><p>건수와 전체 청구 대비 비중</p></div>${chartSwitch('types', [['bar', '막대'], ['pie', '원형']], '보험 유형 차트 형태')}</div>${noHelp(C.categoriesHTML(rows, state.chartViews.types))}</section></div>
    <div class="exploration-heading"><div><h2>분포에서 패턴을 읽어보세요.</h2><p>금액이 모이는 구간과 많이 걸린 신호를 함께 비교하세요.</p></div></div>
    <div class="exploration-grid"><section class="panel"><div class="panel-head chart-panel-head"><div><h2>청구 금액 히스토그램</h2><p>금액이 커질수록 구간 폭을 넓혀(로그 간격) 소액부터 고액 청구까지 한눈에 봅니다. 색은 청구한 사람의 위험도입니다.${skipped ? ` 판단 불가인 사람의 청구 ${f(skipped)}건은 색을 정할 수 없어 뺐습니다.` : ''}</p></div></div>${noHelp(C.histogramHTML(colored, { scale: 'log' }))}${chips}</section>
      <section class="panel"><div class="panel-head"><div><h2>어떤 신호가 많이 걸렸나</h2><p>해당 신호가 걸린 사람 수</p></div></div>
      <div class="horizontal-bars">${res[0].signals.med.map((x, i) => barRow('의료 · ' + x.name, hitCount('med', i), s.count, '#a4c6b5')).join('')}
      ${res[0].signals.auto.map((x, i) => barRow('자동차 · ' + x.name, hitCount('auto', i), s.count, '#7fb0c9')).join('')}</div></section></div>
    <section class="panel table-panel"><div class="panel-head"><div><h2>먼저 살펴볼 사람</h2><p>위험도가 높고 점수가 큰 순서로 5명</p></div><button class="button link" data-tab="list">전체 보기 ${icon('arrow')}</button></div>${reviewTable(top)}
      <div class="table-foot"><span>근거를 확인하고, 담당자의 판단으로 검토를 진행하세요.</span><span>총 ${f(s.count)}명</span></div></section>`;
}


/* ---- 검토 대상: main 의 검토 대상 화면과 같은 구성(빠른 선택, 검색, 필터, CSV, 표, 쪽 나누기, 차트) ---- */
const hasMed = (r) => r.counts.med > 0;
const hasAuto = (r) => r.counts.accidents > 0 || r.counts.autoClaims > 0;
const typeLabels = { med: '실손(의료)만', auto: '자동차만', both: '실손과 자동차 모두' };
const sortedPersons = (rows = state.analysis.results) => rows.slice().sort((x, y) => riskOrder[x.risk] - riskOrder[y.risk] || y.scores.overall - x.scores.overall || x.person_id.localeCompare(y.person_id));
const claimedTotal = (r) => r.records.med.reduce((n, m) => n + m.claim_amount, 0) + r.records.autoClaims.reduce((n, c) => n + c.amount, 0);
const reasonsOf = (r) => [
  ...(r.cross.certain.length ? ['중복 확실'] : r.cross.links.some((l) => l.verdict === '중복 의심') ? ['중복 의심'] : []),
  ...[...r.signals.med, ...r.signals.auto].filter((x) => x.hit).map((x) => x.name)];
function filteredPersons() {
  const q = state.search.toLowerCase();
  return sortedPersons().filter((r) => (state.priority === 'all' || r.risk === state.priority)
    && (state.type === 'all' || (state.type === 'med' && hasMed(r) && !hasAuto(r)) || (state.type === 'auto' && hasAuto(r) && !hasMed(r)) || (state.type === 'both' && hasMed(r) && hasAuto(r)))
    && (!q || r.person_id.toLowerCase().includes(q))
    && C.inRange(r.scores.overall, state.scoreRange));
}
function resetFilters() { state.search = ''; state.type = 'all'; state.priority = 'all'; state.scoreRange = null; state.page = 1; }

function reviewTable(rows, full = false) {
  return `<div class="table-wrap"><table><thead><tr><th>사람 ID</th><th>보험 이력</th><th>청구 금액</th><th>검토 점수</th><th>위험도</th>${full ? '<th>의료 / 자동차</th>' : ''}<th>주요 의심 신호</th><th></th></tr></thead><tbody>
    ${rows.map((r) => { const reasons = reasonsOf(r); return `<tr><td><button class="table-button claim-id" data-select="${esc(r.person_id)}">${esc(r.person_id)}</button></td>
      <td>${hasMed(r) ? `<span class="tag">실손 ${f(r.counts.med)}건</span>` : ''}${hasAuto(r) ? `<span class="tag">자동차 ${f(r.counts.autoClaims)}건</span>` : ''}</td>
      <td>${money(claimedTotal(r))}</td><td class="score-cell ${r.risk === '높음' ? 'high' : ''}">${r.scores.overall.toFixed(1)}</td><td>${badge(r.risk)}</td>
      ${full ? `<td>${Math.round(r.scores.med)} / ${Math.round(r.scores.auto)}</td>` : ''}
      <td>${reasons.slice(0, 2).map((x) => `<span class="tag">${esc(x)}</span>`).join('') || '<span class="muted">특이사항 없음</span>'}${reasons.length > 2 ? `<span class="muted">+${reasons.length - 2}</span>` : ''}</td>
      <td><button class="table-button" data-select="${esc(r.person_id)}" aria-label="${esc(r.person_id)} 상세 보기">${icon('arrow')}</button></td></tr>`; }).join('') || '<tr><td colspan="8" class="empty">조건에 맞는 사람이 없습니다.</td></tr>'}
    </tbody></table></div>`;
}

function filterChips() {
  const labels = { type: state.type === 'all' ? null : '보험: ' + typeLabels[state.type], priority: state.priority === 'all' ? null : '위험도: ' + state.priority,
    search: state.search ? '검색: ' + state.search : null, scoreRange: state.scoreRange ? '점수: ' + state.scoreRange.label : null };
  const entries = Object.entries(labels).filter(([, label]) => label);
  if (!entries.length) return '';
  return `<div class="active-filters" aria-label="적용된 필터">${entries.map(([key, label]) => `<button class="filter-chip" data-clear-filter="${key}" title="${esc(label)} 해제" aria-label="${esc(label)} 필터 해제"><span>${esc(label)}</span><b aria-hidden="true">×</b></button>`).join('')}<button class="filter-reset" data-reset-filters>모든 필터 초기화</button></div>`;
}

function listTab() {
  const all = filteredPersons(), pages = Math.max(1, Math.ceil(all.length / 12));
  state.page = Math.min(state.page, pages);
  const shown = all.slice((state.page - 1) * 12, state.page * 12);
  return pageHead('REVIEW LIST', '검토가 필요한 사람을 찾아보세요.', '조건을 골라 대상을 찾고, 탐지 근거를 확인하세요.', actions()) + sourceStrip() +
    `<section class="panel"><div class="quick-filters"><span>빠른 선택</span>${[['all', '전체 위험도'], ['높음', '우선 검토'], ['보통', '추가 확인'], ['낮음', '낮은 우선순위'], ['판단 불가', '판단 불가']].map(([value, label]) => `<button class="quick-filter" data-quick-priority="${value}" aria-pressed="${state.priority === value}">${label}</button>`).join('')}</div>
    <div class="filters"><label class="search">${icon('search')}<input id="review-search" placeholder="사람 번호 검색" aria-label="사람 번호 검색" value="${esc(state.search)}"></label>
      <select id="type-filter" aria-label="보험 유형"><option value="all">전체 보험 유형</option>${Object.entries(typeLabels).map(([k, v]) => `<option value="${k}" ${state.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select id="priority-filter" aria-label="위험도"><option value="all">전체 위험도</option>${['높음', '보통', '낮음', '판단 불가'].map((x) => `<option ${state.priority === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <button class="button" data-action="export">${icon('download')}필터 결과 CSV</button></div>${filterChips()}
    <div id="review-table">${reviewTable(shown, true)}</div>
    <div class="table-foot"><span role="status" aria-live="polite">${f(all.length)}명 중 ${all.length ? (state.page - 1) * 12 + 1 : 0}–${Math.min(state.page * 12, all.length)}명 · 위험도와 점수 높은 순</span>
      <div class="pagination"><button data-page="${Math.max(1, state.page - 1)}" ${state.page === 1 ? 'disabled' : ''} aria-label="이전 페이지">‹</button><span class="page-position">${state.page} / ${pages}</span><button data-page="${Math.min(pages, state.page + 1)}" ${state.page === pages ? 'disabled' : ''} aria-label="다음 페이지">›</button></div></div></section>
`;
}

/* ---- 분석 개요 AI 해석: 기존 '오늘의 검토 브리핑'(briefing, 코드가 만든 고정 문장)을 AI 해석으로 바꾼다 ----
 * 흐름: 코드가 지표를 계산(IndicatorLens.overviewEvidence) -> 서버가 LLM에게 해석, 원인 후보, 권장 조치를 쓰게 함
 *       -> 코드가 숫자만 검사 -> 통과하면 AI 해석을 보여 주고, 실패하거나 서버가 없으면 기존 고정 브리핑(briefing)을 그대로 보여 준다.
 * 비용이 크므로(수 초~1분) 버튼을 눌렀을 때만 만든다. */
const IE = window.IndicatorLens;

function overviewInput() {
  // overview() 와 같은 계산(신호별 걸린 사람 수, 교차 판정 사람 수)을 AI 근거용으로 다시 모은 것
  const res = state.analysis.results, s = state.analysis.summary, rows = claimRows();
  const hit = (kind, i) => res.filter((r) => r.signals[kind][i].hit).length;
  const verdictPeople = (v) => res.filter((r) => r.cross.links.some((l) => l.verdict === v) || (v === '고지 확인' && r.cross.links.some((l) => l.prior.length))).length;
  return {
    people: s.count, risk: s,
    verdicts: ['중복 확실', '중복 의심', '고지 확인', '판정 불가'].map((name) => ({ name, people: verdictPeople(name) })),
    signals: [...res[0].signals.med.map((x, i) => ({ name: '의료 · ' + x.name, people: hit('med', i) })),
      ...res[0].signals.auto.map((x, i) => ({ name: '자동차 · ' + x.name, people: hit('auto', i) }))],
    months: C.monthlySeries(rows),
    dataThrough: rows.map((x) => x.claim_date).sort().at(-1) || '',
    medianAmount: C.quantile(rows.map((x) => x.amount), .5),
  };
}

/** 데이터를 바꾸면(state.analysis 가 바뀌면) 이전 AI 해석은 버린다. */
const aiState = () => (state.briefingAI && state.briefingAI.analysis === state.analysis ? state.briefingAI : null);

function aiBriefing() {
  const b = aiState();
  const list = (items) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="muted">해당 없음</p>');
  if (b && b.status === 'done' && b.result.provider === 'api') {
    const x = b.result;
    return `<section class="panel briefing"><div class="briefing-head">${icon('spark')}<h2>AI 지표 해석</h2><span class="badge green">LLM 연결</span></div>
      <h3>01 · 확인된 사실</h3>${list(x.facts)}
      <h3>02 · 업무적 의미</h3><p>${esc(x.meaning)}</p>
      <h3>03 · 원인 후보 <span class="muted">(확정이 아닌 가능한 설명)</span></h3>${list(x.causes)}
      <h3>04 · 권장 조치</h3>${list(x.actions)}
      <h3>05 · 모르는 점과 한계</h3><p>${esc(x.uncertainty)}</p>
      <div class="info-note">수치 검증: 답에 나온 숫자가 모두 코드 계산 값과 일치합니다(${x.attempts}번째 시도에 통과). 검증은 <strong>숫자만</strong> 확인합니다. 해석과 원인 후보가 타당한지는 담당자가 판단해야 합니다.</div>
      <button class="button link section-gap" data-action="briefing">다시 생성</button></section>`;
  }
  const busy = b && b.status === 'busy';
  return briefing() + `<div class="info-note section-gap">AI가 이 지표를 읽고 해석, 원인 후보, 권장 조치를 쓰게 할 수 있습니다. 숫자는 코드가 검사합니다.
    <button class="button primary" data-action="briefing" ${busy ? 'disabled' : ''}>${busy ? 'AI 해석 중... (최대 1~2분)' : 'AI 해석 생성'}</button>
    ${b && b.notice ? `<br>${esc(b.notice)}` : ''}</div>`;
}

async function runBriefing() {
  const analysis = state.analysis;
  state.briefingAI = { analysis, status: 'busy' }; render();
  const evidence = IE.overviewEvidence(overviewInput());
  let result, notice = '';
  try {
    if (!window.INSURELENS_SERVER) throw Error('서버 미연결');
    // 서버가 LLM을 최대 3번까지 부를 수 있어 사람 설명(30초)보다 길게 기다린다
    const response = await fetch('/api/interpret-overview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidence }), signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw Error('API 요청 실패');
    result = await response.json();
    if (result.provider === 'api' && (!Array.isArray(result.facts) || typeof result.meaning !== 'string')) throw Error('잘못된 응답');
  } catch {
    result = { provider: 'demo' };
    notice = window.INSURELENS_SERVER ? 'LLM 연결에 실패해 기존 고정 브리핑을 표시합니다.' : 'LLM 서버에 연결되어 있지 않아 AI 해석을 만들 수 없습니다. 기존 고정 브리핑을 표시합니다.';
  }
  if (result.provider === 'api') { // 화면에서도 한 번 더 검사한다(서버 응답을 그대로 믿지 않는다)
    const bad = IE.validateNumbers(result, evidence);
    if (bad.length) { result = { provider: 'demo' }; notice = `AI 답 속 숫자(${bad.slice(0, 5).join(', ')})가 코드 계산과 달라 기존 고정 브리핑을 표시합니다.`; }
  } else if (!notice) {
    notice = result.replaced ? 'AI 답에 코드 계산에 없는 숫자가 반복되어 기존 고정 브리핑을 표시합니다.' : 'AI 해석을 만들지 못해 기존 고정 브리핑을 표시합니다.';
  }
  if (analysis !== state.analysis) return; // 도중에 데이터를 바꿨으면 결과를 버린다
  state.briefingAI = { analysis, status: 'done', result, notice };
  render();
}

function briefing() {
  const s = state.analysis.summary, top = sortedPersons()[0], counts = {};
  for (const r of state.analysis.results) {
    for (const [kind, list] of [['의료', r.signals.med], ['자동차', r.signals.auto]]) for (const x of list) if (x.hit) counts[kind + ' · ' + x.name] = (counts[kind + ' · ' + x.name] || 0) + 1;
  }
  const common = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return `<section class="panel briefing"><div class="briefing-head">${icon('spark')}<h2>오늘의 검토 브리핑</h2><span class="badge">분석 요약</span></div>
    <p>전체 <strong>${f(s.count)}명</strong> 중 <strong>${f(s['높음'])}명</strong>이 우선 검토 대상으로 분류되었습니다.${common ? ` 가장 자주 걸린 신호는 <strong>${esc(common[0])}</strong>입니다.` : ' 현재 설정에서 반복적으로 걸린 신호는 없습니다.'}</p>
    <div class="briefing-separator"></div>
    <ul><li>점수순으로 근거를 확인해 검토를 시작하세요.</li><li>자동차와 의료 청구를 한 사람 기준으로 함께 비교합니다.</li><li>정상적인 고액·반복 진료 가능성도 확인하세요.</li></ul>
    <button class="button" data-select="${esc(top.person_id)}">첫 번째 사람 검토하기 ${icon('arrow')}</button></section>`;
}

function personTab() {
  const r = current();
  const hits = state.query ? state.analysis.results.filter((x) => x.person_id.toLowerCase().includes(state.query.toLowerCase())).slice(0, 8) : [];
  return pageHead('PERSON DETAIL', '한 사람의 이력, 근거를 연결해서.', '분석된 수치와 비교 기준을 확인하고, 담당자의 다음 검토를 준비하세요.',
    `<button class="button" data-tab="list">${icon('list')}검토 목록</button><button class="button" data-action="evidence">${icon('code')}분석 JSON</button>`) +
    `<div style="display:flex;gap:12px;align-items:center;margin-bottom:22px;flex-wrap:wrap"><label for="person-select" class="muted" style="font-size:11px">사람 선택</label>
      <input id="person-search" placeholder="사람 번호 검색 (예: P0001)" aria-label="사람 번호 검색" value="${esc(state.query)}" style="width:190px">
      <select id="person-select" style="min-width:250px;max-width:100%">${state.analysis.results.map((x) => `<option value="${esc(x.person_id)}" ${x.person_id === r.person_id ? 'selected' : ''}>${esc(x.person_id)} · ${x.risk} · ${Math.round(x.scores.overall)}점</option>`).join('')}</select>
      <span class="badge ${decisionClass[E.decision(r)]}">결과 제안: ${esc(E.decision(r))}</span></div>
    ${hits.length ? `<div class="active-filters" style="margin:-8px 0 18px">${hits.map((x) => `<button class="filter-chip" data-select="${esc(x.person_id)}"><span>${esc(x.person_id)} · ${x.risk}</span></button>`).join('')}</div>` : ''}
    ${pipeline()}${detail(r)}`;
}

function reportTab() {
  const r = current(), s = state.analysis.summary;
  const evidence = E.evidence(r);
  const x = state.explanation || E.demoExplain(evidence);
  const hit = [...r.signals.med.map((v) => ['의료', v]), ...r.signals.auto.map((v) => ['자동차', v])].filter(([, v]) => v.hit);
  return pageHead('REPORT', '이 사람의 확인 결과를 보고서로 정리합니다.', '선택한 사람의 위험도와 근거를 한 장으로 모았습니다. 인쇄하거나 PDF로 저장할 수 있습니다.') +
    `<div class="report-layout"><article class="report-paper" id="report-paper">
      <div class="report-brand">InsureLens <span class="muted" style="font-size:10px;font-weight:400">/ 보험 이력 확인 보고서</span></div>
      <h2>${esc(r.person_id)} 보험 이력 확인 보고서</h2>
      <div class="report-meta">${esc(r.person.age_group)} · ${r.person.gender === 'M' ? '남' : '여'} · 가상 데이터 ${f(s.count)}명 중 1명<br>위험도: ${esc(r.risk)} · ${esc(r.reason)}</div>
      <div class="report-stats"><div class="report-stat"><span>종합 점수</span><strong>${Math.round(r.scores.overall)}점</strong></div>
        <div class="report-stat"><span>의료 / 자동차 점수</span><strong>${Math.round(r.scores.med)} / ${Math.round(r.scores.auto)}</strong></div>
        <div class="report-stat"><span>겹친 금액</span><strong>${money(r.cross.overlapAmount)}</strong></div></div>
      <section class="report-section"><h3>01 · 의심 신호 ${hit.length}개</h3>
        ${hit.length ? `<ul>${hit.map(([k, v]) => `<li>${k} ${esc(v.name)}: ${esc(E.signalSentence(v, r.config))} (근거 ${v.evidence.slice(0, 3).map(esc).join(', ')})</li>`).join('')}</ul>` : '<p>걸린 의심 신호가 없습니다.</p>'}</section>
      <section class="report-section"><h3>02 · 사고와 진료 교차 확인</h3>
        ${r.cross.links.length ? `<ul>${r.cross.links.map((l) => `<li>${esc(l.verdict)}: 사고 ${esc(l.accident_id)}와 의료 청구 ${esc(l.claim_id)} (${esc(l.reason)})</li>`).join('')}</ul>` : '<p>사고와 연결되는 손상 진료가 없습니다.</p>'}</section>
      <section class="report-section"><h3>03 · 설명 및 확인할 항목 <span class="badge gray">${x.provider === 'api' ? 'LLM 설명' : '데모 설명'}</span></h3>
        <p>${esc(x.summary)}</p><ul>${x.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></section>
      <section class="report-section"><h3>해석 범위</h3><p>이 위험도는 확인 순서를 정하는 참고 지표이며, 사기 여부나 지급 여부를 정하지 않습니다. 기준값은 초안이고 데이터는 가상입니다. 최종 판단은 담당자가 합니다.</p></section>
      <div class="report-sign"><span>InsureLens · 보험 청구 심사 지원</span><span>최종 확인: 담당 심사자</span></div></article>
      <aside class="report-aside"><section class="panel"><div class="panel-body"><h3>보고서에 담을 사람</h3>
        <select id="report-person" style="width:100%;margin-top:13px">${state.analysis.results.map((p) => `<option value="${esc(p.person_id)}" ${p.person_id === r.person_id ? 'selected' : ''}>${esc(p.person_id)} · ${p.risk} · ${Math.round(p.scores.overall)}점</option>`).join('')}</select>
        <button class="button" data-tab="person">상세 조회에서 자세히 보기</button></div></section>
        <section class="panel"><div class="panel-body"><h3>PDF로 저장하기</h3><p>아래 버튼을 누른 뒤 인쇄 창의 대상을 ‘PDF로 저장’으로 고르세요.</p>
        <button class="button primary" data-action="print">인쇄 / PDF 저장</button></div></section></aside></div>`;
}

function checkTab() {
  const header = pageHead('CHECK', '계산이 정답표와 얼마나 맞는지 확인합니다.', '가상 데이터를 만들 때 심어 둔 정답표와 비교한 결과입니다. 정답표는 위험도 계산에는 쓰지 않았습니다.');
  if (!state.sample) return header + '<section class="panel"><div class="panel-body"><div class="info-note warning">올린 데이터에는 정답표가 없어 이 화면을 쓸 수 없습니다. 가상 데이터에서만 확인할 수 있습니다.</div></div></section>';
  if (!state.labels) return header + '<section class="panel"><div class="panel-body"><div class="info-note warning">정답표(data/labels.json)를 불러오지 못했습니다. python3 data/build_db.py 를 실행한 뒤 다시 열어 주세요.</div></div></section>';
  const m = E.evaluate(state.analysis.results, state.labels);
  const order = Object.keys(m.byScenario);
  return header + `<div class="metric-grid">${metric('정밀도', m.precision.toFixed(3), '', `높음으로 분류한 ${m.tp + m.fp}명 중 실제 의심 ${m.tp}명`)}
    ${metric('재현율', m.recall.toFixed(3), '', `실제 의심 ${m.tp + m.fn}명 중 높음으로 잡은 ${m.tp}명`)}
    ${metric('F1', m.f1.toFixed(3), '', '정밀도와 재현율의 균형')}
    ${metric('의심인데 낮음', f(m.fastTrackMiss), '명', '가장 위험한 실수: 0이어야 안전', m.fastTrackMiss ? 'high' : '')}</div>
    <section class="panel"><div class="panel-head"><div><h2>시나리오별 위험도 분포</h2><p>가상 데이터에 심어 둔 유형별로, 계산이 어떤 위험도를 줬는지</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>심어 둔 유형</th><th>인원</th><th>높음</th><th>보통</th><th>낮음</th><th>판단 불가</th></tr></thead><tbody>
    ${order.map((k) => { const v = m.byScenario[k]; return `<tr><td>${esc(k)}</td><td>${f(v.n)}</td><td>${v['높음']}</td><td>${v['보통']}</td><td>${v['낮음']}</td><td>${v['판단 불가']}</td></tr>`; }).join('')}
    </tbody></table></div></section>
    <div class="info-note warning">주의: 정답표와 계산 규칙을 같은 사람이 만들었으므로 이 수치는 실제 성능이 아닙니다. 계산이 의도대로 동작하는지 확인하는 용도입니다. 실제 성능은 실제 데이터나 사람이 채점한 표본으로 따로 확인해야 합니다.</div>`;
}

/* ---- 검증 홈: main 의 청구 검증 홈 모양에 사람 단위 위험도를 연결합니다 ---- */
const paths = {grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',file:'M14 2H5v20h14V7z M14 2v6h5 M8 12h8 M8 16h6',spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',upload:'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',download:'M12 3v13 M7 11l5 5 5-5 M4 16v5h16v-5',sliders:'M4 4v16 M12 4v16 M20 4v16 M1 8h6 M9 15h6 M17 10h6',arrow:'M5 12h14 M14 7l5 5-5 5',shield:'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z M8 12l3 3 5-6',check:'M5 12l4 4L19 6',info:'M12 11v6 M12 7v1 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',code:'m8 5-6 7 6 7 M16 5l6 7-6 7 M14 3l-4 18',send:'m3 3 18 9-18 9 3-9z M6 12h15',list:'M8 6h13 M8 12h13 M8 18h13 M3 6h1 M3 12h1 M3 18h1'};
const icon = (name) => `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] || paths.file}"/></svg></span>`;

function home() {
  const s = state.analysis.summary;
  const groups = [
    { risk: '높음', name: '우선 검토', style: 'high', count: s['높음'] },
    { risk: '보통', name: '추가 확인', style: 'medium', count: s['보통'] },
    { risk: '낮음', name: '낮은 우선순위', style: 'low', count: s['낮음'] },
    { risk: '판단 불가', name: '판단 불가', style: 'unknown', count: s['판단 불가'] },
  ];
  return `<div class="intake">
    <div class="intake-title"><h1>보험 이력 검증</h1><div class="heading-actions"><button class="button" type="button" data-action="settings">${icon('sliders')}분석 기준</button><button class="button" type="button" data-action="data">${icon('upload')}데이터 변경</button></div></div>
    <section class="verification" aria-label="검증 요약">
      <div class="verify-symbol">${icon('shield')}</div>
      <div>
        <p><strong>${esc(state.source)}</strong> · 사람 ${f(s.count)}명 · 의료 청구 ${f(state.counts.med)}건 · 자동차 청구 ${f(state.counts.autoClaims)}건</p>
        <p>의료 5개, 자동차 5개 지표와 사고·진료 교차 판정으로 검토 우선순위를 분류했습니다. 최종 판단은 담당자가 합니다.</p></div>
    </section>
    ${changePanel()}
    <section class="triage" aria-labelledby="triage-heading">
      <div class="triage-head"><div><h2 id="triage-heading">담당자 선택 검토</h2><p>확인할 분류를 선택하세요.</p></div><button class="button" type="button" data-tab="overview">전체 보기</button></div>
      <div class="triage-groups four">${groups.map((g) => `<button type="button" class="triage-group ${g.style}" data-list="${g.risk}">
        <span class="group-name"><i aria-hidden="true"></i>${g.name}</span>
        <span class="group-total"><strong>${f(g.count)}</strong>명</span></button>`).join('')}</div>
    </section></div>`;
}

/* ---- 탐지 기준 조정: person-engine 의 기준값 17개를 화면에서 바꿔 사람 전체를 다시 계산합니다 ----
   항목은 [키, 라벨, 최솟값, 최댓값, 간격] 입니다. main 의 청구 단위 설정 창과 틀은 같지만 항목은 사람 단위 엔진 기준입니다. */
const settingGroups = [
  ['의료', [
    ['medWindowDays', '의료 살펴볼 기간 (일)', 1, 365, 1, '같은 병명 진료를 이 기간 안에서 셉니다.'],
    ['medVisitCount', '진료 횟수 기준 (회 이상)', 2, 60, 1, '같은 병명으로 이 횟수 이상이면 의심 신호입니다.'],
    ['medGapDays', '진료 간격 기준 (일 미만)', 0.5, 30, 0.5, '평균 간격이 이보다 짧으면 의심 신호입니다.'],
    ['medGapMinClaims', '간격 계산 최소 진료 (건 이상)', 2, 20, 1, '같은 병명 청구가 이보다 적으면 비교하지 않습니다.'],
    ['medHospitalCount', '병원 수 기준 (곳 이상)', 2, 20, 1, '같은 병명으로 이 곳 수 이상이면 의심 신호입니다.']]],
  ['자동차', [
    ['autoWindowDays', '사고 살펴볼 기간 (일)', 1, 730, 1, '사고 횟수를 이 기간 안에서 셉니다.'],
    ['autoAccidentCount', '사고 횟수 기준 (회 이상)', 2, 20, 1, '이 횟수 이상이면 의심 신호입니다.'],
    ['autoGapDays', '사고 간격 기준 (일 미만)', 1, 365, 1, '가장 가까운 두 사고가 이보다 가까우면 의심 신호입니다.']]],
  ['의료와 자동차 공통', [
    ['repeatCount', '반복 청구 기준 (번 이상)', 2, 20, 1, '같은 청구가 이 횟수 이상이면 의심 신호입니다.'],
    ['costPercentile', '비싼 청구 기준 (0.9면 상위 10%)', 0.5, 0.99, 0.01, '같은 종류 청구 중 이 순위 안의 금액을 비싸다고 봅니다.'],
    ['costHitCount', '비싼 청구 건수 기준 (건 이상)', 1, 20, 1, '의료 청구 중 비싼 청구가 이 건수 이상이면 의심 신호입니다.'],
    ['minPeers', '금액 비교 최소 건수 (건 이상)', 1, 200, 1, '같은 종류 청구가 이보다 적으면 비교하지 않습니다.']]],
  ['사고와 진료 연결', [
    ['crossWindowDays', '사고 뒤 진료 연결 기간 (일)', 1, 365, 1, '사고일부터 이 기간 안의 진료를 사고와 연결합니다.'],
    ['priorDays', '사고 전 확인 기간 (일)', 1, 730, 1, '사고 전 이 기간에 같은 부위 진료가 있으면 표시합니다.'],
    ['amountTolerance', '중복 의심 금액 차이 (0.05면 5%)', 0.01, 0.5, 0.01, '두 청구 금액 차이가 이 비율 이내이면 의심합니다.']]],
  ['위험도를 나누는 점수', [
    ['high', '높음으로 보는 점수 (점 이상)', 1, 100, 1, '종합 점수가 이 값 이상이면 높음입니다.'],
    ['medium', '보통으로 보는 점수 (점 이상)', 0, 99, 1, '이 값 이상이고 높음 미만이면 보통입니다.']]],
];
const settingFields = settingGroups.flatMap(([, list]) => list);

/* ---- 기준 변경 결과: 한 줄 띠로 보여 주고, 닫아도 '다시 보기'가 남습니다 ---- */
function changePanel() {
  const c = state.lastChange;
  if (!c) return '';
  const a = state.analysis.summary, b = c.before;
  const body = state.changeOpen
    ? `기준 변경 결과 · 높음 ${b['높음']} → ${a['높음']}명 · 보통 ${b['보통']} → ${a['보통']}명 · 낮음 ${b['낮음']} → ${a['낮음']}명 <button class="button link" data-action="close-change">비교 닫기</button>`
    : '<button class="button link" data-action="open-change">기준 변경 결과 다시 보기</button>';
  return `<div class="comparison-strip">${body}</div>`;
}

function showSettings() {
  const input = ([id, label, min, max, step, hint]) => `<div class="setting-field"><label for="setting-${id}">${label}</label>
    <input id="setting-${id}" name="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${state.config[id]}" required><small class="setting-hint">${hint}</small></div>`;
  $('#settings-form').innerHTML = settingGroups.map(([group, list]) => `<h3 class="setting-group">${group}</h3><div class="setting-grid">${list.map(input).join('')}</div>`).join('') +
    `<div id="settings-error" class="error" hidden></div>
    <div class="dialog-actions"><button type="button" class="button" id="reset-settings">기본값 복원</button><button type="submit" class="button primary">변경하고 다시 분석</button></div>`;
  $('#reset-settings').addEventListener('click', () => {
    for (const [key, value] of Object.entries(E.defaults)) { const el = $('#setting-' + key); if (el) el.value = value; }
    $('#settings-error').hidden = true;
  });
  $('#settings-dialog').showModal();
}

async function reanalyze(cfg) {
  const before = state.analysis.summary;
  $('#loading').hidden = false;
  await new Promise((r) => setTimeout(r, 40)); // 로딩 표시가 먼저 그려질 시간
  try {
    state.analysis = state.db ? PersonSql.analyzeAllSql(state.db, cfg) : E.analyzeAll(state.data, cfg);
    state.lastChange = { before, beforeConfig: state.config, afterConfig: state.analysis.config }; state.changeOpen = true;
    state.config = state.analysis.config;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.config)); } catch { /* 저장하지 못해도 동작합니다 */ }
    resetPerson();
    render();
    toast('기준을 적용했습니다.');
    return true;
  } catch (error) {
    toast('기준을 적용하지 못했습니다: ' + error.message);
    return false;
  } finally { $('#loading').hidden = true; }
}

// 값을 다시 고치기 시작하면 이전 오류 문구를 지웁니다(범위를 벗어난 값은 브라우저가 먼저 막아서 제출 처리까지 오지 않습니다).
$('#settings-form').addEventListener('input', () => { const el = $('#settings-error'); if (el) el.hidden = true; });
$('#settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target), cfg = { ...state.config }, error = $('#settings-error');
  error.hidden = true;
  for (const [id, label, min, max] of settingFields) {
    const value = Number(form.get(id));
    if (!Number.isFinite(value) || value < min - 1e-9 || value > max + 1e-9) {
      error.textContent = `${label} 값은 ${min}에서 ${max} 사이여야 합니다.`; error.hidden = false; return;
    }
    cfg[id] = value;
  }
  if (cfg.medium >= cfg.high) { error.textContent = '“보통” 점수는 “높음” 점수보다 작아야 합니다.'; error.hidden = false; return; }
  if (await reanalyze(cfg)) $('#settings-dialog').close();
});

function render() {
  if (!state.analysis) return;
  document.body.classList.toggle('intake-mode', state.tab === 'home'); // 홈에서는 사이드바 없이 간단한 화면
  const r = current();
  state.selected = r.person_id;
  const known = tabs.find(([id]) => id === state.tab) || tabs[0];
  $('#navigation').innerHTML = tabs.map(([id, label]) => `<a href="#${id}" class="${state.tab === id ? 'active' : ''}" ${state.tab === id ? 'aria-current="page"' : ''} title="${label}">${icon(tabIcons[id])}<span class="nav-text">${label}</span>${id === 'list' ? `<span class="nav-count">${state.analysis.summary['높음']}</span>` : ''}</a>`).join('');
  $('#page-label').textContent = known[1];
  document.title = 'InsureLens · ' + known[1];
  $('#main').innerHTML = ({ home, overview, list: listTab, person: personTab, report: reportTab, check: checkTab }[state.tab] || home)();
  const input = $('#person-search');
  if (input) input.addEventListener('input', () => {
    state.query = input.value; const pos = input.selectionStart;
    render(); const next = $('#person-search'); next.focus(); next.setSelectionRange(pos, pos);
  });
  $('#person-select')?.addEventListener('change', (ev) => { state.selected = ev.target.value; resetPerson(); render(); });
  $('#report-person')?.addEventListener('change', (ev) => { state.selected = ev.target.value; resetPerson(); render(); });
  const rs = $('#review-search');
  if (rs) rs.addEventListener('input', () => {
    state.search = rs.value; state.page = 1; const pos = rs.selectionStart;
    render(); const next = $('#review-search'); next.focus(); next.setSelectionRange(pos, pos);
  });
  $('#type-filter')?.addEventListener('change', (ev) => { state.type = ev.target.value; state.page = 1; render(); });
  $('#priority-filter')?.addEventListener('change', (ev) => { state.priority = ev.target.value; state.page = 1; render(); });
  $('#review-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    state.reviews.set(state.selected, { status: $('#review-status').value, note: $('#review-note').value });
    toast('검토 기록을 저장했습니다.');
  });
}

async function explain() {
  const r = state.analysis.results.find((x) => x.person_id === state.selected);
  const payload = E.evidence(r);
  let result;
  try {
    if (!window.INSURELENS_SERVER) throw Error('서버 미연결');
    const response = await fetch('/api/explain-person', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // [기존 보존] signal: AbortSignal.timeout(30000) — 서버가 숫자가 틀리면 최대 3번까지 다시 쓰게 해서 120초로 늘렸다
      // [이전] signal: AbortSignal.timeout(120000) — 약관 RAG 병합으로 아래 LLM_WAIT_MS(130000, 서버 대기보다 길게)로 바꿨다
      body: JSON.stringify({ evidence: payload }), signal: AbortSignal.timeout(LLM_WAIT_MS),
    });
    if (!response.ok) throw Error('API 요청 실패');
    result = await response.json();
    if (typeof result.summary !== 'string' || !Array.isArray(result.basis)) throw Error('잘못된 응답');
  } catch {
    result = E.demoExplain(payload);
    if (window.INSURELENS_SERVER) toast('LLM 연결에 실패해 데모 설명을 표시합니다.');
  }
  let check = verifyWithTerms(payload, result);
  if (!check.ok && result.provider === 'api') {
    toast('설명 속 수치가 코드 계산과 달라 데모 설명으로 대체했습니다.');
    const demo = E.demoExplain(payload);
    state.explanation = demo;
    state.verification = check;
  } else {
    state.explanation = result;
    state.verification = check;
  }
  render();
}

async function assist(kind, question = '') {
  const r = current();
  const payload = E.evidence(r);
  const demo = { ask: () => E.demoAsk(payload, question), request: () => E.demoRequest(payload), gap: () => E.demoGap(payload) }[kind];
  let result;
  try {
    if (!window.INSURELENS_SERVER) throw Error('서버 미연결');
    const response = await fetch('/api/person-assist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, evidence: payload, question }), signal: AbortSignal.timeout(LLM_WAIT_MS),
    });
    if (!response.ok) throw Error('API 요청 실패');
    result = await response.json();
  } catch {
    result = demo();
    if (window.INSURELENS_SERVER) toast('LLM 연결에 실패해 데모 답변을 표시합니다.');
  }
  const check = verifyWithTerms(payload, result);
  if (!check.ok && result.provider === 'api') { toast('답변 속 수치가 코드 계산과 달라 데모 답변으로 대체했습니다.'); result = demo(); }
  state.assist[kind] = { result, check, question };
  render();
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action],[data-select],[data-tab],[data-list],[data-ask],[data-page],[data-chart-view],[data-chart-filter],[data-clear-filter],[data-reset-filters],[data-quick-priority],.close-dialog');
  if (!el || el.disabled) return;
  if (el.matches('.close-dialog')) { el.closest('dialog').close(); return; }
  if (el.dataset.chartView) { state.chartViews[el.dataset.chartView] = el.dataset.chartMode; render(); return; }
  if (el.dataset.chartFilter) { // 우선순위 조각, 범례, 점수 막대만 검토 대상으로 연결합니다
    const key = el.dataset.chartFilter;
    if (key === 'priority' || key === 'scoreRange') {
      if (state.tab !== 'list') resetFilters();
      state[key] = JSON.parse(el.dataset.chartValue); state.page = 1; go('list'); window.scrollTo({ top: 0, behavior: 'instant' });
    }
    return;
  }
  if (el.hasAttribute('data-reset-filters')) { resetFilters(); render(); return; }
  if (el.dataset.clearFilter) { const key = el.dataset.clearFilter; state[key] = ['type', 'priority'].includes(key) ? 'all' : key === 'search' ? '' : null; state.page = 1; render(); return; }
  if (el.dataset.quickPriority) { state.priority = el.dataset.quickPriority; state.page = 1; render(); return; }
  if (el.dataset.page) { state.page = Number(el.dataset.page); render(); return; }
  if (el.dataset.action === 'data') { $('#upload-error').hidden = true; $('#data-dialog').showModal(); }
  if (el.dataset.action === 'evidence') { $('#evidence-json').textContent = JSON.stringify(E.evidence(current()), null, 2); $('#evidence-dialog').showModal(); }
  if (el.dataset.action === 'export') exportCsv();
  if (el.dataset.action === 'settings') showSettings();
  if (el.dataset.action === 'close-change') { state.changeOpen = false; render(); }
  if (el.dataset.action === 'open-change') { state.changeOpen = true; render(); }
  if (el.dataset.select) { state.selected = el.dataset.select; state.query = ''; resetPerson(); state.tab = 'person'; location.hash = 'person'; render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
  if (el.dataset.tab) go(el.dataset.tab);
  if (el.dataset.list) { resetFilters(); state.priority = el.dataset.list; go('list'); }
  if (el.dataset.action === 'explain') explain();
  if (el.dataset.action === 'briefing') runBriefing();
  if (el.dataset.action === 'request') assist('request');
  if (el.dataset.action === 'gap') assist('gap');
  if (el.dataset.ask) assist('ask', el.dataset.ask);
  if (el.dataset.action === 'copy-request') {
    const text = `제목: ${$('#request-subject')?.value || ''}\n\n${$('#request-text')?.value || ''}`;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('메일 제목과 본문을 복사했습니다.'), () => toast('복사에 실패했습니다. 본문을 직접 선택해 복사하세요.'));
  }
  if (el.dataset.action === 'print') window.print();
});

/* ---- 필터 결과 CSV ---- */
function download(name, content, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a'), url = URL.createObjectURL(new Blob([content], { type }));
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCsv() {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = filteredPersons().map((r) => [r.person_id, r.risk, r.scores.overall, r.scores.med, r.scores.auto, r.counts.med, r.counts.autoClaims, Math.round(claimedTotal(r)), reasonsOf(r).join(' / ')]);
  const head = ['사람 ID', '위험도', '종합 점수', '의료 점수', '자동차 점수', '의료 청구 건수', '자동차 청구 건수', '청구 금액', '주요 의심 신호'];
  download('검토 대상.csv', '\uFEFF' + [head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n'));
  toast(`${f(rows.length)}명을 CSV로 내보냈습니다.`);
}

/* ---- 데이터 바꾸기: SQLite 파일(.db)을 올리거나 가상 데이터로 되돌립니다 ---- */
function useDatabase(db, { source, sample, counts }) {
  const analysis = PersonSql.analyzeAllSql(db, state.config); // 형식이 다르면 여기서 오류가 납니다
  if (!analysis.results.length) throw Error('분석할 사람이 없습니다. person 테이블을 확인하세요.');
  if (state.db && state.db !== db) state.db.close();
  Object.assign(state, { db, analysis, engine: 'SQL', source, sample, counts, labels: sample ? state.sampleLabels : null, lastChange: null, changeOpen: false });
  state.selected = (analysis.results.find((r) => r.cross.certain.length) || analysis.results[0]).person_id;
  state.reviews.clear(); state.query = ''; resetPerson(); resetFilters(); render();
}
async function loadSample() {
  const response = await fetch('data/insure.db');
  if (!response.ok) throw Error('data/insure.db를 불러오지 못했습니다.');
  const db = new state.SQLJS.Database(new Uint8Array(await response.arrayBuffer()));
  useDatabase(db, { source: '가상 데이터', sample: true, counts: { med: state.data.med_claim.length, accidents: state.data.auto_accident.length, autoClaims: state.data.auto_claim.length } });
}
async function upload(file) {
  const error = $('#upload-error');
  error.hidden = true;
  if (!file) return;
  try {
    if (!state.SQLJS) throw Error('SQLite를 불러오지 못해 파일을 올릴 수 없습니다.');
    if (file.size > 50 * 1024 * 1024) throw Error('50MB 이하의 파일을 선택해 주세요.');
    const db = new state.SQLJS.Database(new Uint8Array(await file.arrayBuffer()));
    const one = (table) => db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0];
    useDatabase(db, { source: file.name, sample: false, counts: { med: one('med_claim'), accidents: one('auto_accident'), autoClaims: one('auto_claim') } });
    $('#data-dialog').close(); toast('데이터를 바꿔 다시 분석했습니다.');
  } catch (e) {
    error.textContent = /not a database/i.test(e.message) ? '올바른 SQLite 파일이 아닙니다.'
      : /no such (table|column)/i.test(e.message) ? `필요한 테이블이나 열이 없습니다: ${e.message}` : e.message;
    error.hidden = false;
  }
}
$('#db-file').addEventListener('change', (ev) => { upload(ev.target.files[0]); ev.target.value = ''; });
$('#use-sample').addEventListener('click', async () => {
  $('#upload-error').hidden = true;
  try { await loadSample(); $('#data-dialog').close(); toast('가상 데이터를 불러왔습니다.'); } catch (e) { $('#upload-error').textContent = e.message; $('#upload-error').hidden = false; }
});

const tabFromHash = () => (tabs.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : 'home');
document.addEventListener('submit', (ev) => {
  if (ev.target.dataset.form !== 'ask') return;
  ev.preventDefault();
  const q = $('#ask-input').value.trim();
  if (q) assist('ask', q);
});

window.addEventListener('hashchange', () => { state.tab = tabFromHash(); render(); window.scrollTo({ top: 0, behavior: 'instant' }); });

async function init() {
  $('#loading').hidden = false;
  try {
    const response = await fetch('data/mock.json');
    if (!response.ok) throw Error('모의 데이터를 불러오지 못했습니다. data/mock.json을 확인하세요.');
    state.data = await response.json();
    try {
      // 계산은 SQLite 쿼리로 합니다(브라우저 안의 sql.js). 불러오지 못하면 JS 계산으로 대신하고 화면에 표시합니다.
      const SQLJS = await initSqlJs({ locateFile: (file) => 'vendor/' + file });
      const dbResponse = await fetch('data/insure.db');
      if (!dbResponse.ok) throw Error('data/insure.db를 불러오지 못했습니다.');
      state.SQLJS = SQLJS;
      state.db = new SQLJS.Database(new Uint8Array(await dbResponse.arrayBuffer()));
      state.analysis = PersonSql.analyzeAllSql(state.db, state.config);
      state.engine = 'SQL';
    } catch (error) {
      console.warn('SQL 계산을 쓸 수 없어 JS 계산으로 대신합니다:', error.message);
      state.analysis = E.analyzeAll(state.data, state.config);
      state.engine = 'JS';
    }
    const first = state.analysis.results.find((r) => r.cross.certain.length) || state.analysis.results[0];
    state.selected = first.person_id;
    state.tab = tabFromHash();
    state.counts = { med: state.data.med_claim.length, accidents: state.data.auto_accident.length, autoClaims: state.data.auto_claim.length };
    try { const l = await fetch('data/labels.json'); if (l.ok) { state.labels = await l.json(); state.sampleLabels = state.labels; } } catch { /* 정답표 없이도 동작 */ }
    render();
  } catch (error) {
    $('#main').innerHTML = `<section class="panel"><div class="panel-body"><div class="error">${esc(error.message)}</div>
      <p class="muted">python3 data/build_db.py 를 실행해 모의 데이터를 만든 뒤 다시 열어 주세요.</p></div></section>`;
  } finally { $('#loading').hidden = true; }
}
init();
