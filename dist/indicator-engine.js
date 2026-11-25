'use strict';
/* 분석 개요의 'AI 지표 해석' 엔진. 기존 Python(engine.py)의 방식을 웹 화면에 맞게 옮긴 것입니다.
 *
 * 흐름:  계산·판정(코드)  ->  해석·원인 후보·권장 조치(LLM)  ->  숫자 검사(코드)  ->  틀리면 다시 쓰게 함
 *
 * - 코드(overviewEvidence)가 위험도 분포, 신호별 걸린 사람 수, 교차 판정 사람 수, 월별 청구와 전월 대비 증감을 계산합니다.
 *   위험도와 판정은 person-engine.js가 이미 정한 값입니다. LLM은 숫자를 계산하지 않습니다.
 * - 검증(validateNumbers)은 '답에 나온 숫자가 표에 있는 값인가'만 봅니다.
 *   해석이 맞는지, 원인 후보가 타당한지는 코드가 알 수 없으므로 담당자가 판단해야 합니다.
 * - 브라우저(person-app.js)와 서버(indicator-llm.mjs)가 이 파일을 함께 씁니다(person-engine.js와 같은 방식). */
(function (root) {
  const MAX_ATTEMPTS = 3; // 처음 1번 + 숫자가 틀렸을 때 다시 쓰게 하는 2번 (기존 Python의 max_retry=2)

  /** 소수 첫째 자리 반올림. 음수도 부호를 떼고 반올림해 Python round()와 같은 방향으로 맞춥니다. */
  const round1 = (x) => Math.sign(x) * Math.round(Math.abs(x) * 10) / 10;
  const pct = (n, total) => (total ? round1(n / total * 100) : 0);
  const lastDay = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

  /* ---------------------------------------------------------------- 1. 계산·판정(코드)
   * input: { people, risk: {높음, 보통, 낮음, '판단 불가'}, verdicts: [{name, people}], signals: [{name, people}],
   *          months: [{month:'2026-09', count, total}], dataThrough: '2026-10-09', medianAmount }
   * 반환하는 evidence 의 숫자는 모두 코드가 계산한 값이고, LLM에게는 이 값만 보여 줍니다. */
  function overviewEvidence(input) {
    const { people, risk, verdicts, signals, months, dataThrough, medianAmount } = input;
    const monthly = months.map((m, i) => {
      const prev = months[i - 1];
      const avg = m.count ? m.total / m.count : null, prevAvg = prev && prev.count ? prev.total / prev.count : null;
      return {
        month: m.month, claims: m.count,
        avg_amount_man: avg === null ? null : Math.round(avg / 10000), // 건당 평균 청구금액(만원)
        claims_change_pct: prev && prev.count ? round1((m.count - prev.count) / prev.count * 100) : null, // 전월 대비 건수 증감(%)
        avg_amount_change_pct: avg !== null && prevAvg ? round1((avg - prevAvg) / prevAvg * 100) : null,
        // 데이터가 달 중간에서 끝났으면 그 달은 진행 중이라 건수가 적은 것이 감소가 아닙니다
        partial: !!dataThrough && m.month === dataThrough.slice(0, 7) && Number(dataThrough.slice(8, 10)) < lastDay(m.month),
      };
    });
    return {
      people,
      risk: ['높음', '보통', '낮음', '판단 불가'].map((level) => ({ level, people: risk[level], pct: pct(risk[level], people) })),
      verdicts: verdicts.map((v) => ({ name: v.name, people: v.people, pct: pct(v.people, people) })),
      signals: signals.map((s) => ({ name: s.name, people: s.people, pct: pct(s.people, people) })).sort((a, b) => b.people - a.people),
      monthly,
      median_claim_amount_man: Math.round(medianAmount / 10000),
      data_through: dataThrough,
    };
  }

  /* ---------------------------------------------------------------- 2. 프롬프트 (기존 Python build_prompt의 문장을 웹 지표에 맞게 옮김) */
  function buildPrompt(e, feedback) {
    const f = (n) => Number(n).toLocaleString('ko-KR');
    const sign = (v) => (v === null ? '계산불가' : `${v > 0 ? '+' : ''}${v}%`);
    const lines = [
      `- 전체 ${f(e.people)}명, 위험도별 인원: ${e.risk.map((r) => `${r.level} ${f(r.people)}명(${r.pct}%)`).join(', ')}`,
      `- 교차 확인 판정이 있는 사람(코드가 판정): ${e.verdicts.map((v) => `${v.name} ${f(v.people)}명(${v.pct}%)`).join(', ')}`,
      `- 신호별로 걸린 사람 수(코드가 판정, 많은 순): ${e.signals.map((s) => `${s.name} ${f(s.people)}명(${s.pct}%)`).join(', ')}`,
      `- 청구 금액 중앙값: ${f(e.median_claim_amount_man)}만원 (데이터 마지막 날짜 ${e.data_through})`,
      '- 월별 청구(건수, 건당 평균 금액, 전월 대비 건수 증감, 전월 대비 금액 증감):',
      ...e.monthly.map((m) => `  ${m.month}: ${f(m.claims)}건, ${m.avg_amount_man === null ? '-' : f(m.avg_amount_man) + '만원'}, ${sign(m.claims_change_pct)}, ${sign(m.avg_amount_change_pct)}${m.partial ? ' (이 달은 진행 중이라 건수가 적습니다)' : ''}`),
    ];
    let prompt = '당신은 보험 청구 데이터의 지표를 담당자에게 해석해 주는 분석 보조입니다.\n'
      + '아래 지표는 이미 코드가 계산하고 판정했습니다. 새로 계산하지 말고, 표에 있는 수치만 그대로 인용하세요.\n'
      + "원인은 확정하지 말고 '원인 후보'로 쓰세요. 보험사기를 확정하거나 지급 여부를 결정하지 마세요. 최종 판단은 담당자의 몫입니다.\n"
      + '진행 중인 달의 건수가 적은 것은 감소로 해석하지 마세요.\n'
      // 기존 Python 방식에서 정상 지표에까지 원인을 하나씩 지어내는 과잉 해석이 확인되어 추가한 문장
      + '특이한 항목만 골라 해석하고, 특이하지 않은 항목에는 원인과 조치를 쓰지 마세요. 특이점이 없으면 없다고 쓰세요.\n\n'
      + lines.join('\n')
      + '\n\n다음 JSON 형식으로만 답하세요(설명 문장 금지):\n'
      + '{"facts": ["확인된 사실(수치 인용)"], "meaning": "업무적 의미", '
      + '"causes": ["원인 후보"], "actions": ["권장 조치"], "uncertainty": "모르는 점과 한계"}';
    if (feedback) prompt += `\n\n[이전 답변의 오류 - 반드시 고칠 것]\n${feedback}`;
    return prompt;
  }

  /* ---------------------------------------------------------------- 3. 숫자 검사 (기존 Python validate를 옮김)
   * 답 속 숫자가 evidence 에 있는 값(또는 그 반올림)인지 대조합니다. 부호는 무시하고 반올림 오차만 허용합니다.
   * 반환: 어긋난 숫자 문자열 목록(비어 있으면 통과).
   * Python과 다른 점(오탐으로 괜히 다시 쓰게 하는 것을 줄이려는 것):
   *   1) '1,200' 처럼 천 단위 쉼표가 있으면 하나의 숫자로 읽습니다.
   *   2) '3개 지표', '2가지', '9월', '3개월' 같은 개수와 월 표현의 숫자, '2026-09' 같은 날짜는 검사하지 않습니다.
   *      '명', '건', '%', '만원'이 붙은 숫자는 모두 검사합니다.
   * 한계: 숫자만 검사합니다. 틀린 해석, 지어낸 원인, 특이하지 않은 항목에 대한 과잉 해석은 걸러 내지 못합니다. */
  const NUM = /(?<![\d.])(\d+(?:\.\d+)?)(?!\d)(\s*(?:개|가지|회|번|위|곳|단계|차|월))?/g;
  function numbersIn(v, acc) {
    if (typeof v === 'number' && Number.isFinite(v)) acc.push(Math.abs(v));
    else if (Array.isArray(v)) v.forEach((x) => numbersIn(x, acc));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => numbersIn(x, acc));
    return acc;
  }
  function validateNumbers(out, evidence) {
    const allowed = numbersIn(evidence, []).flatMap((a) => [a, Math.round(a), round1(a)]);
    const texts = Object.entries(out || {}).filter(([k]) => k !== 'provider')
      .flatMap(([, v]) => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === 'string');
    const bad = [];
    for (const raw of texts) {
      const text = raw.replace(/\d{4}-\d{2}(?:-\d{2})?/g, ' ').replace(/(?<=\d),(?=\d{3})/g, '');
      for (const m of text.matchAll(NUM)) {
        if (m[2]) continue;
        const x = Number(m[1]);
        if (!allowed.some((a) => Math.abs(x - a) <= Math.max(0.1, 0.005 * a))) bad.push(m[1]);
      }
    }
    return [...new Set(bad)];
  }

  const api = { MAX_ATTEMPTS, overviewEvidence, buildPrompt, validateNumbers };
  root.IndicatorLens = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
