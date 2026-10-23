'use strict';
/* 보험 이력 확인 화면(탭 5개). 계산은 person-engine.js가 하고 이 파일은 표시만 합니다. */
const E = window.PersonLens;
const $ = (q) => document.querySelector(q);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f = (n) => Number(n).toLocaleString('ko-KR');
const money = (n) => f(Math.round(n)) + '원';

const state = { tab: 'overview', data: null, labels: null, analysis: null, selected: null, query: '', explanation: null, verification: null, listFilter: '높음', assist: {} };
const resetPerson = () => { state.explanation = null; state.verification = null; state.assist = {}; };
const tabs = [['overview', '분석 개요'], ['list', '확인 대상 목록'], ['person', '사람 조회'], ['report', '분석 보고서'], ['check', '검증 결과']];
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

function pageHead(eyebrow, title, desc) {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${desc}</p></div></div>`;
}

function sourceStrip() {
  const s = state.analysis.summary;
  return `<div class="source-strip"><div class="source-left"><strong>가상 데이터 ${f(s.count)}명</strong>
  <span class="badge gray">MOCK</span>
  <span class="badge ${state.engine === 'SQL' ? 'green' : 'gray'}" title="${state.engine === 'SQL' ? '지표와 교차 판정을 SQLite 쿼리로 계산했습니다' : 'SQLite를 불러오지 못해 JavaScript로 계산했습니다'}">${state.engine === 'SQL' ? '계산: SQLite 쿼리' : '계산: JS 대체'}</span><span class="source-divider"></span>
  <span class="muted">의료 청구 ${f(state.data.med_claim.length)}건 · 사고 ${f(state.data.auto_accident.length)}건 · 자동차 청구 ${f(state.data.auto_claim.length)}건</span>
  <span class="source-status">· 생성 ${esc(state.data.generated)} · seed ${esc(state.data.seed)}</span></div></div>`;
}

function heading() {
  return pageHead('PERSON LOOKUP', '이 사람의 보험 이력에 이상한 점이 있는지 확인하세요.',
    '사람 번호를 고르면 자동차보험과 의료보험 이력을 함께 살펴보고, 같은 비용을 두 번 받은 흔적이 있는지까지 보여줍니다.') + sourceStrip();
}

function searchBox() {
  const hits = state.query
    ? state.analysis.results.filter((r) => r.person_id.toLowerCase().includes(state.query.toLowerCase())).slice(0, 8)
    : [];
  return `<section class="panel"><div class="filters">
    <label class="search"><input id="person-search" placeholder="사람 번호로 조회 (예: P0001)" aria-label="사람 번호 조회" value="${esc(state.query)}"></label>
    <select id="person-select" aria-label="사람 선택">${state.analysis.results.map((r) => `<option value="${esc(r.person_id)}" ${r.person_id === state.selected ? 'selected' : ''}>${esc(r.person_id)} · ${r.risk} · ${Math.round(r.scores.overall)}점</option>`).join('')}</select>
    </div>${hits.length ? `<div class="active-filters">${hits.map((r) => `<button class="filter-chip" data-select="${esc(r.person_id)}"><span>${esc(r.person_id)} · ${r.risk}</span></button>`).join('')}</div>` : ''}
    <div class="table-foot"><span>전체 ${f(state.analysis.summary.count)}명 · 높음 ${state.analysis.summary['높음']}명 · 보통 ${state.analysis.summary['보통']}명 · 낮음 ${state.analysis.summary['낮음']}명 · 판단 불가 ${state.analysis.summary['판단 불가']}명</span>
    <span>중복 확실 ${state.analysis.summary.certain}명</span></div></section>`;
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

function signalList(title, signals, hint) {
  return `<section class="panel section-gap"><div class="panel-head"><h2>${title}</h2>
    <span class="badge gray">${signals.filter((s) => s.hit).length} / ${signals.length} 걸림</span></div>
    <div class="rule-list">${signals.map((s) => `<div class="rule-item ${s.hit ? 'hit' : ''}">
      <span class="rule-state">${s.hit ? '!' : '✓'}</span>
      <div><h4>${esc(s.name)}</h4><p>관측 ${s.observed === null ? '—' : esc(s.observed)} · 기준 ${esc(s.threshold)} · ${esc(s.note)}</p>
      ${s.evidence.length ? `<p class="muted">근거: ${s.evidence.slice(0, 4).map(esc).join(', ')}${s.evidence.length > 4 ? ` 외 ${s.evidence.length - 4}건` : ''}</p>` : ''}</div>
      <span class="badge ${s.hit ? 'amber' : 'gray'}">${s.hit ? '걸림' : '정상'}</span></div>`).join('')}</div>
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
  return `<section class="panel ai-panel"><div class="ai-status"><h2>AI 검토 설명</h2>
    <span class="badge ${x && x.provider === 'api' ? 'green' : 'gray'}">${x && x.provider === 'api' ? 'LLM 연결' : '데모 설명'}</span></div>
    ${x ? `<div class="ai-result"><h3>01 · 요약</h3><p>${esc(x.summary)}</p>
      <h3>02 · 근거</h3><ul>${x.basis.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
      <h3>03 · 확인할 항목</h3><ul>${x.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <p class="provider">${x.provider === 'api' ? 'LLM이 코드가 만든 근거 JSON을 바탕으로 작성했습니다.' : 'LLM 미연결 · 코드가 계산한 수치로 만든 데모 설명입니다.'}</p></div>
      ${state.verification ? `<div class="info-note ${state.verification.ok ? '' : 'warning'}">수치 검증: ${state.verification.ok
        ? '설명에 나온 모든 숫자와 근거 번호가 코드 계산 결과와 일치합니다.'
        : `코드 계산 결과에 없는 값 ${esc([...state.verification.badNumbers, ...state.verification.badIds, ...(state.verification.badTerms || [])].slice(0, 5).join(', '))} 을 발견해 이 설명을 무효 처리했습니다.`}</div>` : ''}
      <button class="button link section-gap" data-action="explain">설명 다시 생성</button>`
    : `<div class="ai-placeholder"><h3>숫자를 업무의 언어로</h3><p>이 사람의 위험도 근거를 정리하고,<br>확인할 항목을 제시합니다.</p>
      <button class="button primary" data-action="explain">설명 생성</button></div>`}
    <p class="muted" style="font-size:9px;margin-top:14px;line-height:1.8">LLM은 점수와 위험도를 바꾸지 않습니다. 코드가 정한 결과를 설명만 합니다.</p></section>`;
}

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
      ${x.result.citations.length ? `<div style="margin-top:10px">${x.result.citations.map((id) => `<span class="tag">${esc(id)}</span>`).join('')}</div>` : ''}</div>${assistCheck(x)}` : ''}
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
      <div style="margin-top:12px"><button class="button" data-action="copy-request">메일 전체 복사</button></div></div>${assistCheck(x)}
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
      <h3>이렇게 확인하면 판단됩니다</h3><ol style="margin:0;padding-left:20px">${x.result.how.map((m) => `<li>${esc(m)}</li>`).join('')}</ol></div>${assistCheck(x)}
      <button class="button link section-gap" data-action="gap">다시 생성</button>`
    : `<div class="ai-placeholder"><p>영수증 번호가 비어 판단할 수 없는 이유와, 무엇을 확인하면 판단되는지 정리합니다.</p>
      <button class="button primary" data-action="gap">확인할 것 제안</button></div>`}</section>`;
}

function detail(r) {
  return `<div class="detail-grid"><div>${scoreBlock(r)}
    ${signalList('의료 지표 5개', r.signals.med, `같은 병명 기준 ${r.config.medWindowDays}일 관찰 · 기준값은 초안입니다.`)}
    ${signalList('자동차 지표 5개', r.signals.auto, `${r.config.autoWindowDays}일 관찰 · 기준값은 초안입니다.`)}</div>
    <div>${explanationPanel(r)}${askPanel(r)}${requestPanel(r)}${gapPanel(r)}
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

function overview() {
  const a = state.analysis, s = a.summary, res = a.results;
  const hitCount = (kind, i) => res.filter((r) => r.signals[kind][i].hit).length;
  const verdicts = ['중복 확실', '중복 의심', '고지 확인', '판정 불가'];
  const verdictCount = (v) => res.filter((r) => r.cross.links.some((l) => l.verdict === v) || (v === '고지 확인' && r.cross.links.some((l) => l.prior.length))).length;
  const colors = { '높음': '#d98c7a', '보통': '#e6bd7a', '낮음': '#a4c6b5', '판단 불가': '#c5cdd1' };
  return pageHead('OVERVIEW', '전체 사람들의 위험 현황을 한눈에 봅니다.',
    '가상 데이터에 있는 사람을 모두 계산해, 위험도별 인원과 어떤 지표가 많이 걸렸는지 보여줍니다.') + sourceStrip() +
    `<div class="metric-grid">${metric('전체 사람', f(s.count), '명', '자동차와 의료 이력을 합쳐서 계산')}
      ${metric('위험도 높음', f(s['높음']), '명', `전체의 ${(s['높음'] / s.count * 100).toFixed(1)}% · 증빙 요청과 상세 조사 대상`, 'high')}
      ${metric('위험도 보통', f(s['보통']), '명', '확인 항목을 보고 판단')}
      ${metric('판단 불가', f(s['판단 불가']), '명', '영수증 번호가 비어 중복 여부를 알 수 없음')}</div>
    <div class="dashboard-grid"><section class="panel"><div class="panel-head"><div><h2>위험도별 인원</h2><p>사람 수 기준</p></div></div>
      <div class="horizontal-bars">${['높음', '보통', '낮음', '판단 불가'].map((k) => barRow(k, s[k], s.count, colors[k])).join('')}</div>
      <div class="table-foot"><span>높음을 누르면 확인 대상 목록으로 이동합니다 → <button class="button link" data-list="높음">높음 목록 보기</button></span></div></section>
      <section class="panel briefing"><div class="briefing-head"><h2>이 화면 읽는 법</h2></div>
      <p>의료 지표 5개와 자동차 지표 5개 중 몇 개가 걸렸는지로 점수를 매기고, 점수가 높을수록 위험도가 올라갑니다.</p>
      <div class="briefing-separator"></div>
      <p>같은 비용을 자동차보험과 의료보험에서 둘 다 받았는지(중복 확실)는 점수와 상관없이 바로 <strong>높음</strong>입니다.</p></section></div>
    <div class="subgrid"><section class="panel"><div class="panel-head"><div><h2>어떤 지표가 많이 걸렸나</h2><p>해당 지표에 걸린 사람 수</p></div></div>
      <div class="horizontal-bars">${res[0].signals.med.map((x, i) => barRow('의료 · ' + x.name, hitCount('med', i), s.count, '#a4c6b5')).join('')}
      ${res[0].signals.auto.map((x, i) => barRow('자동차 · ' + x.name, hitCount('auto', i), s.count, '#7fb0c9')).join('')}</div></section>
      <section class="panel"><div class="panel-head"><div><h2>사고와 진료 교차 확인 결과</h2><p>해당 판정이 한 건이라도 있는 사람 수</p></div></div>
      <div class="horizontal-bars">${verdicts.map((v) => barRow(v, verdictCount(v), s.count, v === '중복 확실' ? '#d98c7a' : '#e6bd7a')).join('')}</div></section></div>`;
}

function listTab() {
  const res = state.analysis.results, s = state.analysis.summary;
  const rows = res.filter((r) => state.listFilter === '전체' || r.risk === state.listFilter)
    .sort((x, y) => riskOrder[x.risk] - riskOrder[y.risk] || y.scores.overall - x.scores.overall || x.person_id.localeCompare(y.person_id));
  const shown = rows.slice(0, 100);
  const hits = (r) => [...r.signals.med, ...r.signals.auto].filter((x) => x.hit).map((x) => x.name);
  return pageHead('REVIEW LIST', '확인이 필요한 사람 목록', '위험도가 높은 사람부터 보여줍니다. 한 사람을 누르면 사람 조회 화면에서 근거를 볼 수 있습니다.') + sourceStrip() +
    `<section class="panel"><div class="filters"><label>위험도 <select id="list-filter" aria-label="위험도 필터">
      ${['전체', '높음', '보통', '낮음', '판단 불가'].map((k) => `<option ${state.listFilter === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <span class="muted">${f(rows.length)}명 중 ${f(shown.length)}명 표시</span></div>
    <div class="table-wrap"><table><thead><tr><th>사람</th><th>위험도</th><th>종합 점수</th><th>의료 / 자동차</th><th>걸린 지표</th><th>교차 확인</th><th></th></tr></thead><tbody>
    ${shown.map((r) => `<tr><td class="claim-id">${esc(r.person_id)}</td><td>${badge(r.risk)}</td><td class="score-cell ${r.risk === '높음' ? 'high' : ''}">${Math.round(r.scores.overall)}</td>
      <td>${Math.round(r.scores.med)} / ${Math.round(r.scores.auto)}</td>
      <td>${hits(r).map((n) => `<span class="tag">${esc(n)}</span>`).join('') || '<span class="muted">없음</span>'}</td>
      <td>${r.cross.certain.length ? '<span class="badge red">중복 확실</span>' : r.cross.links.some((l) => l.verdict === '중복 의심') ? '<span class="badge amber">중복 의심</span>' : '<span class="muted">—</span>'}</td>
      <td><button class="table-button" data-select="${esc(r.person_id)}">근거 보기</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">해당하는 사람이 없습니다.</td></tr>'}
    </tbody></table></div>
    <div class="table-foot"><span>전체 ${f(s.count)}명 · 높음 ${s['높음']} · 보통 ${s['보통']} · 낮음 ${s['낮음']} · 판단 불가 ${s['판단 불가']}</span></div></section>`;
}

function personTab() {
  return heading() + searchBox() + detail(current());
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
      <section class="report-section"><h3>01 · 걸린 지표 ${hit.length}개</h3>
        ${hit.length ? `<ul>${hit.map(([k, v]) => `<li>${k} · ${esc(v.name)}: 관측 ${esc(v.observed)} / 기준 ${esc(v.threshold)} (근거 ${v.evidence.slice(0, 3).map(esc).join(', ')})</li>`).join('')}</ul>` : '<p>걸린 지표가 없습니다.</p>'}</section>
      <section class="report-section"><h3>02 · 사고와 진료 교차 확인</h3>
        ${r.cross.links.length ? `<ul>${r.cross.links.map((l) => `<li>${esc(l.verdict)}: 사고 ${esc(l.accident_id)}와 의료 청구 ${esc(l.claim_id)} (${esc(l.reason)})</li>`).join('')}</ul>` : '<p>사고와 연결되는 손상 진료가 없습니다.</p>'}</section>
      <section class="report-section"><h3>03 · 설명 및 확인할 항목 <span class="badge gray">${x.provider === 'api' ? 'LLM 설명' : '데모 설명'}</span></h3>
        <p>${esc(x.summary)}</p><ul>${x.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></section>
      <section class="report-section"><h3>해석 범위</h3><p>이 위험도는 확인 순서를 정하는 참고 지표이며, 사기 여부나 지급 여부를 정하지 않습니다. 기준값은 초안이고 데이터는 가상입니다. 최종 판단은 담당자가 합니다.</p></section>
      <div class="report-sign"><span>InsureLens · 보험 청구 심사 지원</span><span>최종 확인: 담당 심사자</span></div></article>
      <aside class="report-aside"><section class="panel"><div class="panel-body"><h3>보고서에 담을 사람</h3>
        <select id="report-person" style="width:100%;margin-top:13px">${state.analysis.results.map((p) => `<option value="${esc(p.person_id)}" ${p.person_id === r.person_id ? 'selected' : ''}>${esc(p.person_id)} · ${p.risk} · ${Math.round(p.scores.overall)}점</option>`).join('')}</select>
        <button class="button" data-tab="person">사람 조회에서 자세히 보기</button></div></section>
        <section class="panel"><div class="panel-body"><h3>PDF로 저장하기</h3><p>아래 버튼을 누른 뒤 인쇄 창의 대상을 ‘PDF로 저장’으로 고르세요.</p>
        <button class="button primary" data-action="print">인쇄 / PDF 저장</button></div></section></aside></div>`;
}

function checkTab() {
  const header = pageHead('CHECK', '계산이 정답표와 얼마나 맞는지 확인합니다.', '가상 데이터를 만들 때 심어 둔 정답표와 비교한 결과입니다. 정답표는 위험도 계산에는 쓰지 않았습니다.');
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

function render() {
  if (!state.analysis) return;
  const r = current();
  state.selected = r.person_id;
  const known = tabs.find(([id]) => id === state.tab) || tabs[0];
  $('#navigation').innerHTML = tabs.map(([id, label]) => `<a href="#${id}" class="${state.tab === id ? 'active' : ''}" ${state.tab === id ? 'aria-current="page"' : ''}>${label}${id === 'list' ? `<span class="nav-count">${state.analysis.summary['높음']}</span>` : ''}</a>`).join('');
  $('#page-label').textContent = known[1];
  document.title = 'InsureLens · ' + known[1];
  $('#main').innerHTML = ({ overview, list: listTab, person: personTab, report: reportTab, check: checkTab }[state.tab] || overview)();
  const input = $('#person-search');
  if (input) input.addEventListener('input', () => {
    state.query = input.value; const pos = input.selectionStart;
    render(); const next = $('#person-search'); next.focus(); next.setSelectionRange(pos, pos);
  });
  $('#person-select')?.addEventListener('change', (ev) => { state.selected = ev.target.value; resetPerson(); render(); });
  $('#report-person')?.addEventListener('change', (ev) => { state.selected = ev.target.value; resetPerson(); render(); });
  $('#list-filter')?.addEventListener('change', (ev) => { state.listFilter = ev.target.value; render(); });
}

async function explain() {
  const r = state.analysis.results.find((x) => x.person_id === state.selected);
  const payload = E.evidence(r);
  let result;
  try {
    if (!window.INSURELENS_SERVER) throw Error('서버 미연결');
    const response = await fetch('/api/explain-person', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidence: payload }), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error('API 요청 실패');
    result = await response.json();
    if (typeof result.summary !== 'string' || !Array.isArray(result.basis)) throw Error('잘못된 응답');
  } catch {
    result = E.demoExplain(payload);
    if (window.INSURELENS_SERVER) toast('LLM 연결에 실패해 데모 설명을 표시합니다.');
  }
  let check = E.verifyExplanation(payload, result);
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
      body: JSON.stringify({ kind, evidence: payload, question }), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error('API 요청 실패');
    result = await response.json();
  } catch {
    result = demo();
    if (window.INSURELENS_SERVER) toast('LLM 연결에 실패해 데모 답변을 표시합니다.');
  }
  const check = E.verifyExplanation(payload, result);
  if (!check.ok && result.provider === 'api') { toast('답변 속 수치가 코드 계산과 달라 데모 답변으로 대체했습니다.'); result = demo(); }
  state.assist[kind] = { result, check, question };
  render();
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action],[data-select],[data-tab],[data-list],[data-ask]');
  if (!el) return;
  if (el.dataset.select) { state.selected = el.dataset.select; state.query = ''; resetPerson(); state.tab = 'person'; location.hash = 'person'; render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
  if (el.dataset.tab) go(el.dataset.tab);
  if (el.dataset.list) { state.listFilter = el.dataset.list; go('list'); }
  if (el.dataset.action === 'explain') explain();
  if (el.dataset.action === 'request') assist('request');
  if (el.dataset.action === 'gap') assist('gap');
  if (el.dataset.ask) assist('ask', el.dataset.ask);
  if (el.dataset.action === 'copy-request') {
    const text = `제목: ${$('#request-subject')?.value || ''}\n\n${$('#request-text')?.value || ''}`;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('메일 제목과 본문을 복사했습니다.'), () => toast('복사에 실패했습니다. 본문을 직접 선택해 복사하세요.'));
  }
  if (el.dataset.action === 'print') window.print();
});

const tabFromHash = () => (tabs.some(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : 'overview');
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
      state.db = new SQLJS.Database(new Uint8Array(await dbResponse.arrayBuffer()));
      state.analysis = PersonSql.analyzeAllSql(state.db);
      state.engine = 'SQL';
    } catch (error) {
      console.warn('SQL 계산을 쓸 수 없어 JS 계산으로 대신합니다:', error.message);
      state.analysis = E.analyzeAll(state.data);
      state.engine = 'JS';
    }
    const first = state.analysis.results.find((r) => r.cross.certain.length) || state.analysis.results[0];
    state.selected = first.person_id;
    state.tab = tabFromHash();
    try { const l = await fetch('data/labels.json'); if (l.ok) state.labels = await l.json(); } catch { /* 정답표 없이도 동작 */ }
    render();
  } catch (error) {
    $('#main').innerHTML = `<section class="panel"><div class="panel-body"><div class="error">${esc(error.message)}</div>
      <p class="muted">python3 data/build_db.py 를 실행해 모의 데이터를 만든 뒤 다시 열어 주세요.</p></div></section>`;
  } finally { $('#loading').hidden = true; }
}
init();
