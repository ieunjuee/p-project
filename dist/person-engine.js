/* 사람 단위 위험도 계산 엔진.
 * 자동차 지표 5개, 의료 지표 5개, 사고-진료 교차 판정을 코드로 계산합니다.
 * 점수와 위험도는 이 파일에서만 정합니다. LLM은 결과를 설명만 합니다.
 * 기준값은 모두 초안입니다. */
(function (root) {
  'use strict';
  const DAY = 86400000;

  const defaults = Object.freeze({
    medWindowDays: 30,      // 의료 진료 횟수와 병원 분산을 보는 기간
    medVisitCount: 8,       // 같은 병명 진료 횟수 기준
    medGapDays: 3,          // 같은 병명 평균 진료 간격 기준 (미만이면 걸림)
    medGapMinClaims: 3,     // 간격을 계산할 최소 진료 건수
    medHospitalCount: 3,    // 같은 병명으로 이용한 병원 수 기준
    autoWindowDays: 90,     // 사고 횟수를 보는 기간
    autoAccidentCount: 3,   // 사고 횟수 기준
    autoGapDays: 30,        // 연속 사고 간격 기준 (미만이면 걸림)
    repeatCount: 2,         // 반복 청구 기준 건수
    costPercentile: 0.95,   // 금액 상위 기준 (상위 5%)
    costHitCount: 2,        // 상위 금액 청구가 몇 건 이상이어야 걸리는지
    minPeers: 15,           // 금액 비교에 필요한 최소 표본
    crossWindowDays: 30,    // 사고 후 진료를 연결하는 기간
    priorDays: 90,          // 기왕증을 확인하는 사고 이전 기간
    amountTolerance: 0.05,  // 중복 의심의 금액 차이 허용 범위
    high: 60,               // 높음 기준 점수
    medium: 30,             // 보통 기준 점수
  });

  const toTime = (value) => Date.parse(value + 'T00:00:00Z');
  const diffDays = (a, b) => (toTime(a) - toTime(b)) / DAY;
  const money = (n) => Math.round(n).toLocaleString('ko-KR') + '원';
  const unique = (list) => [...new Set(list)];

  function percentile(values, p) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  }

  /** 같은 날짜 그룹 안에서 기간 창을 밀며 최댓값을 구합니다. */
  function windowMax(dates, windowDays, valueOf) {
    const sorted = dates.slice().sort();
    let best = 0;
    for (let i = 0; i < sorted.length; i++) {
      const inside = sorted.filter((d, j) => j >= i && diffDays(d, sorted[i]) < windowDays);
      best = Math.max(best, valueOf ? valueOf(inside) : inside.length);
    }
    return best;
  }

  function groupBy(rows, key) {
    const map = new Map();
    for (const row of rows) {
      const k = typeof key === 'function' ? key(row) : row[key];
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(row);
    }
    return map;
  }

  /** 데이터 전체에서 한 번만 계산하는 비교 기준 (금액 상위 5% 경계). */
  function buildReference(data, cfg) {
    const medCost = new Map();
    for (const [key, rows] of groupBy(data.med_claim, (r) => r.disease_code + '|' + r.treatment_type)) {
      medCost.set(key, {
        count: rows.length,
        threshold: rows.length >= cfg.minPeers ? percentile(rows.map((r) => r.claim_amount), cfg.costPercentile) : null,
      });
    }
    const accidentType = new Map(data.auto_accident.map((a) => [a.accident_id, a.accident_type]));
    const repair = new Map();
    for (const [type, rows] of groupBy(
      data.auto_claim.filter((c) => c.claim_type === '대물수리비'),
      (c) => accidentType.get(c.accident_id) || '미상')) {
      repair.set(type, {
        count: rows.length,
        threshold: rows.length >= cfg.minPeers ? percentile(rows.map((r) => r.amount), cfg.costPercentile) : null,
      });
    }
    // 경미 사고는 접촉 사고로 대신 봅니다. 접촉 사고 대인 치료비의 치료기간(일) 상위 5% 경계.
    const treatDays = data.auto_claim
      .filter((c) => c.claim_type === '대인치료비' && c.treat_start && c.treat_end && accidentType.get(c.accident_id) === '접촉')
      .map((c) => diffDays(c.treat_end, c.treat_start) + 1);
    const treat = {
      count: treatDays.length,
      threshold: treatDays.length >= cfg.minPeers ? percentile(treatDays, cfg.costPercentile) : null,
    };
    return {
      medCost,
      repair,
      treat,
      accidentType,
      kcd: new Map(data.kcd.map((k) => [k.disease_code, k])),
    };
  }

  /** 사람 한 명의 기록을 꺼냅니다. */
  function profile(personId, data) {
    return {
      person: data.person.find((p) => p.person_id === personId) || null,
      med: data.med_claim.filter((r) => r.person_id === personId)
        .sort((a, b) => a.visit_date.localeCompare(b.visit_date)),
      accidents: data.auto_accident.filter((r) => r.person_id === personId)
        .sort((a, b) => a.accident_date.localeCompare(b.accident_date)),
      autoClaims: data.auto_claim.filter((r) => r.person_id === personId)
        .sort((a, b) => a.claim_date.localeCompare(b.claim_date)),
    };
  }

  const signal = (id, name, hit, observed, threshold, evidence, note) =>
    ({ id, name, hit: !!hit, observed, threshold, evidence: evidence || [], note: note || '' });

  /** 의료 지표 5개 */
  function medicalSignals(rec, ref, cfg) {
    const byDisease = groupBy(rec.med, 'disease_code');
    const out = [];

    let bestCount = 0, countEvidence = [], countCode = null;
    for (const [code, rows] of byDisease) {
      const n = windowMax(rows.map((r) => r.visit_date), cfg.medWindowDays);
      if (n > bestCount) { bestCount = n; countCode = code; countEvidence = rows.map((r) => r.claim_id); }
    }
    out.push(signal('med_count', '진료 횟수', bestCount >= cfg.medVisitCount, bestCount, cfg.medVisitCount,
      bestCount >= cfg.medVisitCount ? countEvidence : [],
      countCode ? `${countCode} 기준 ${cfg.medWindowDays}일 최대 ${bestCount}회` : '진료 기록 없음'));

    let bestGap = null, gapEvidence = [];
    for (const [, rows] of byDisease) {
      if (rows.length < cfg.medGapMinClaims) continue;
      const span = diffDays(rows.at(-1).visit_date, rows[0].visit_date) / (rows.length - 1);
      if (bestGap === null || span < bestGap) { bestGap = span; gapEvidence = rows.map((r) => r.claim_id); }
    }
    out.push(signal('med_gap', '진료 간격', bestGap !== null && bestGap < cfg.medGapDays,
      bestGap === null ? null : Math.round(bestGap * 10) / 10, cfg.medGapDays,
      bestGap !== null && bestGap < cfg.medGapDays ? gapEvidence : [],
      bestGap === null ? `같은 병명 ${cfg.medGapMinClaims}건 미만으로 평가 보류` : '평균 간격(일)'));

    const costHits = rec.med.filter((r) => {
      const peer = ref.medCost.get(r.disease_code + '|' + r.treatment_type);
      return peer && peer.threshold !== null && r.claim_amount >= peer.threshold;
    });
    out.push(signal('med_cost', '진료비', costHits.length >= cfg.costHitCount, costHits.length, cfg.costHitCount,
      costHits.length >= cfg.costHitCount ? costHits.map((r) => r.claim_id) : [],
      `같은 병명과 치료 종류 중 상위 ${Math.round((1 - cfg.costPercentile) * 100)}% 금액 ${costHits.length}건`));

    const receipts = groupBy(rec.med.filter((r) => r.receipt_no), 'receipt_no');
    const sameDay = groupBy(rec.med, (r) => r.visit_date + '|' + r.hospital_id + '|' + r.claim_amount);
    const repeatEvidence = [];
    for (const [, rows] of receipts) if (rows.length >= cfg.repeatCount) repeatEvidence.push(...rows.map((r) => r.claim_id));
    for (const [, rows] of sameDay) if (rows.length >= cfg.repeatCount) repeatEvidence.push(...rows.map((r) => r.claim_id));
    out.push(signal('med_repeat', '반복 청구', repeatEvidence.length > 0, unique(repeatEvidence).length, cfg.repeatCount,
      unique(repeatEvidence), '같은 영수증 번호 또는 같은 날, 같은 병원, 같은 금액'));

    let bestHospitals = 0, hospitalEvidence = [];
    for (const [, rows] of byDisease) {
      const n = windowMax(rows.map((r) => r.visit_date), cfg.medWindowDays,
        (inside) => unique(rows.filter((r) => inside.includes(r.visit_date)).map((r) => r.hospital_id)).length);
      if (n > bestHospitals) { bestHospitals = n; hospitalEvidence = rows.map((r) => r.claim_id); }
    }
    out.push(signal('med_hospital', '병원 분산', bestHospitals >= cfg.medHospitalCount, bestHospitals, cfg.medHospitalCount,
      bestHospitals >= cfg.medHospitalCount ? hospitalEvidence : [],
      `같은 병명으로 ${cfg.medWindowDays}일 안에 이용한 병원 수`));

    return out;
  }

  /** 자동차 지표 5개 */
  function autoSignals(rec, ref, cfg) {
    const out = [];
    const dates = rec.accidents.map((a) => a.accident_date);

    const count = windowMax(dates, cfg.autoWindowDays);
    out.push(signal('auto_count', '사고 횟수', count >= cfg.autoAccidentCount, count, cfg.autoAccidentCount,
      count >= cfg.autoAccidentCount ? rec.accidents.map((a) => a.accident_id) : [],
      `${cfg.autoWindowDays}일 안의 최대 사고 수`));

    let minGap = null;
    for (let i = 1; i < dates.length; i++) {
      const gap = diffDays(dates[i], dates[i - 1]);
      if (minGap === null || gap < minGap) minGap = gap;
    }
    out.push(signal('auto_gap', '사고 간격', minGap !== null && minGap < cfg.autoGapDays, minGap, cfg.autoGapDays,
      minGap !== null && minGap < cfg.autoGapDays ? rec.accidents.map((a) => a.accident_id) : [],
      minGap === null ? '사고가 1건 이하' : '가장 짧은 사고 간격(일)'));

    const longTreat = rec.autoClaims.filter((c) => c.claim_type === '대인치료비' && c.treat_start && c.treat_end
      && ref.accidentType.get(c.accident_id) === '접촉'
      && ref.treat.threshold !== null
      && diffDays(c.treat_end, c.treat_start) + 1 > ref.treat.threshold); // 일수는 같은 값이 많아 경계값 초과만 봅니다
    out.push(signal('auto_treat', '치료 기간', longTreat.length > 0, longTreat.length, 1,
      longTreat.map((c) => c.auto_claim_id),
      `접촉 사고(경미 사고 대신) 대인 치료 기간이 상위 ${Math.round((1 - cfg.costPercentile) * 100)}% 경계 초과`));

    const repairHits = rec.autoClaims.filter((c) => {
      if (c.claim_type !== '대물수리비') return false;
      const peer = ref.repair.get(ref.accidentType.get(c.accident_id) || '미상');
      return peer && peer.threshold !== null && c.amount >= peer.threshold;
    });
    out.push(signal('auto_cost', '수리비', repairHits.length > 0, repairHits.length, 1,
      repairHits.map((c) => c.auto_claim_id),
      `같은 사고 유형 중 상위 ${Math.round((1 - cfg.costPercentile) * 100)}% 수리비`));

    const repeatEvidence = [];
    for (const key of ['counterparty_id', 'repair_shop_id']) {
      for (const [value, rows] of groupBy(rec.accidents.filter((a) => a[key]), key)) {
        if (rows.length >= cfg.repeatCount) repeatEvidence.push(...rows.map((a) => a.accident_id));
      }
    }
    for (const [, rows] of groupBy(rec.autoClaims, (c) => c.accident_id + '|' + c.claim_type)) {
      if (rows.length >= cfg.repeatCount) repeatEvidence.push(...rows.map((c) => c.auto_claim_id));
    }
    out.push(signal('auto_repeat', '반복 청구', repeatEvidence.length > 0, unique(repeatEvidence).length, cfg.repeatCount,
      unique(repeatEvidence), '같은 상대방이나 정비소, 또는 같은 사고에 같은 종류를 여러 번 청구'));

    return out;
  }

  /** 사고와 진료를 연결하고 중복 보상 여부를 판정합니다. */
  function crossCheck(rec, ref, cfg) {
    const links = [];
    for (const accident of rec.accidents) {
      const claims = rec.autoClaims.filter((c) => c.accident_id === accident.accident_id);
      const careClaims = claims.filter((c) => c.claim_type === '대인치료비');
      const linked = rec.med.filter((m) => {
        const code = ref.kcd.get(m.disease_code);
        const gap = diffDays(m.visit_date, accident.accident_date);
        return code && code.injury_flag === 1 && gap >= 0 && gap <= cfg.crossWindowDays;
      });
      for (const med of linked) {
        let verdict = '정상 분리 청구', reason = '사고와 연결되지만 중복으로 볼 근거가 없습니다.', pair = null;
        for (const care of careClaims) {
          const bothPaid = care.paid_amount > 0 && med.paid_amount > 0;
          if (care.receipt_no && med.receipt_no && care.receipt_no === med.receipt_no && bothPaid) {
            verdict = '중복 확실';
            reason = `같은 영수증 번호 ${med.receipt_no}가 자동차와 의료 양쪽에서 지급되었습니다.`;
            pair = care; break;
          }
          const sameHospital = care.hospital_id && care.hospital_id === med.hospital_id;
          const inPeriod = care.treat_start && care.treat_end
            && med.visit_date >= care.treat_start && med.visit_date <= care.treat_end;
          const high = Math.max(care.amount, med.claim_amount), low = Math.min(care.amount, med.claim_amount);
          const closeAmount = high > 0 && (high - low) / high <= cfg.amountTolerance;
          if (!care.receipt_no && !med.receipt_no && sameHospital && inPeriod) {
            verdict = '판정 불가';
            reason = '양쪽 영수증 번호가 비어 있어 같은 비용인지 확인할 수 없습니다.';
            pair = care; continue;
          }
          if (sameHospital && inPeriod && closeAmount && verdict === '정상 분리 청구') {
            verdict = '중복 의심';
            reason = '영수증 번호는 다르지만 같은 병원, 같은 치료 기간, 금액 차이가 5% 이내입니다.';
            pair = care;
          }
        }
        if (verdict === '정상 분리 청구' && med.accident_flag === '질병') {
          verdict = '고지 확인';
          reason = '사고 관련 손상 진료인데 의료보험에는 질병으로 청구되었습니다.';
        }
        const part = ref.kcd.get(med.disease_code).body_part;
        const prior = rec.med.filter((m) => {
          const other = ref.kcd.get(m.disease_code);
          const before = diffDays(accident.accident_date, m.visit_date);
          return other && other.body_part === part && before > 0 && before <= cfg.priorDays;
        });
        links.push({
          accident_id: accident.accident_id,
          accident_date: accident.accident_date,
          accident_type: accident.accident_type,
          claim_id: med.claim_id,
          visit_date: med.visit_date,
          disease_code: med.disease_code,
          body_part: part,
          hospital_id: med.hospital_id,
          med_amount: med.claim_amount,
          med_paid: med.paid_amount,
          auto_claim_id: pair ? pair.auto_claim_id : null,
          auto_paid: pair ? pair.paid_amount : null,
          verdict,
          reason,
          prior: prior.map((m) => m.claim_id),
        });
      }
    }
    const of = (name) => links.filter((l) => l.verdict === name);
    const overlap = [...of('중복 확실'), ...of('중복 의심')]
      .reduce((sum, l) => sum + Math.min(l.auto_paid || 0, l.med_paid || 0), 0);
    const linkedPaid = links.reduce((sum, l) => sum + (l.med_paid || 0), 0);
    return {
      links,
      certain: of('중복 확실'),
      suspected: of('중복 의심'),
      disclosure: of('고지 확인'),
      prior: links.filter((l) => l.prior.length),
      undecidable: of('판정 불가'),
      overlapAmount: overlap,
      overlapRatio: linkedPaid ? overlap / linkedPaid : 0,
    };
  }

  function analyzePerson(personId, data, settings) {
    const cfg = { ...defaults, ...(settings || {}) };
    const ref = data.__ref && data.__ref.cfg === cfg ? data.__ref.value : buildReference(data, cfg);
    const rec = profile(personId, data);
    if (!rec.person) throw Error('등록되지 않은 사람 번호입니다: ' + personId);

    return assemble(personId, rec, medicalSignals(rec, ref, cfg), autoSignals(rec, ref, cfg), crossCheck(rec, ref, cfg), cfg);
  }

  /** 지표와 교차 판정 결과를 받아 점수, 위험도, 이유를 정합니다. 계산 방식(JS 또는 SQL)과 무관합니다. */
  function assemble(personId, rec, med, auto, cross, cfg) {
    const medHits = med.filter((s) => s.hit), autoHits = auto.filter((s) => s.hit);
    const medScore = medHits.length / med.length * 100;
    const autoScore = autoHits.length / auto.length * 100;
    const overall = Math.max(medScore, autoScore);

    const attention = cross.suspected.length + cross.disclosure.length + cross.prior.length;
    let risk, reason;
    if (cross.certain.length) {
      risk = '높음';
      reason = `같은 영수증이 자동차와 의료 양쪽에서 지급된 건이 ${cross.certain.length}건 있어 점수와 상관없이 정밀 검토 대상입니다.`;
    } else if (cross.undecidable.length) {
      risk = '판단 불가';
      reason = '사고와 진료가 연결되지만 양쪽 영수증 번호가 비어 있어 중복 여부를 판정할 수 없습니다.';
    } else if (overall >= cfg.high) {
      risk = '높음';
      reason = `걸린 지표가 ${Math.max(medHits.length, autoHits.length)}개로 점수 ${overall.toFixed(0)}점입니다.`;
    } else if (overall >= cfg.medium || attention) {
      risk = '보통';
      reason = overall >= cfg.medium
        ? `걸린 지표가 ${Math.max(medHits.length, autoHits.length)}개로 점수 ${overall.toFixed(0)}점입니다.`
        : '점수는 낮지만 사고와 진료 사이에 확인할 항목이 있습니다.';
    } else {
      risk = '낮음';
      reason = '지표와 교차 확인에서 특별한 위험 신호가 없습니다.';
    }

    return {
      person_id: personId,
      person: rec.person,
      counts: { med: rec.med.length, accidents: rec.accidents.length, autoClaims: rec.autoClaims.length },
      paid: {
        med: rec.med.reduce((s, r) => s + r.paid_amount, 0),
        auto: rec.autoClaims.reduce((s, r) => s + r.paid_amount, 0),
      },
      signals: { med, auto },
      hits: { med: medHits.map((s) => s.name), auto: autoHits.map((s) => s.name) },
      cross,
      scores: { med: medScore, auto: autoScore, overall },
      risk,
      reason,
      records: rec,
      config: cfg,
    };
  }

  function analyzeAll(data, settings) {
    const cfg = { ...defaults, ...(settings || {}) };
    const ref = buildReference(data, cfg);
    data.__ref = { cfg, value: ref };
    const results = data.person.map((p) => analyzePerson(p.person_id, data, cfg));
    delete data.__ref;
    return { ...summarize(results), config: cfg, reference: ref };
  }

  function summarize(results) {
    const summary = { count: results.length, 높음: 0, 보통: 0, 낮음: 0, '판단 불가': 0, certain: 0 };
    for (const r of results) {
      summary[r.risk]++;
      if (r.cross.certain.length) summary.certain++;
    }
    return { results, summary };
  }

  /** LLM에 보내는 근거. 사람 번호와 병원 번호는 제외합니다. */
  function evidence(result) {
    const show = (s) => ({ id: s.id, name: s.name, hit: s.hit, observed: s.observed, threshold: s.threshold, note: s.note, evidence_ids: s.evidence });
    return {
      risk: result.risk,
      decision: decision(result),
      risk_reason: result.reason,
      scores: {
        medical: Math.round(result.scores.med),
        auto: Math.round(result.scores.auto),
        overall: Math.round(result.scores.overall),
      },
      counts: result.counts,
      paid_total: result.paid,
      medical_signals: result.signals.med.map(show),
      auto_signals: result.signals.auto.map(show),
      cross_links: result.cross.links.map((l) => ({
        accident_id: l.accident_id, accident_date: l.accident_date, accident_type: l.accident_type,
        claim_id: l.claim_id, visit_date: l.visit_date, disease_code: l.disease_code,
        body_part: l.body_part, verdict: l.verdict, reason: l.reason,
        med_paid: l.med_paid, auto_paid: l.auto_paid, prior_claim_ids: l.prior,
      })),
      overlap_amount: result.cross.overlapAmount,
      overlap_ratio: Math.round(result.cross.overlapRatio * 1000) / 1000,
      config: result.config,
      limitations: [
        '위험도는 검토 순서를 정하는 지표이며 보험사기 확률이 아닙니다.',
        '지급 여부는 담당자가 결정합니다.',
        '기준값은 가상 데이터로 정한 실험 설정입니다.',
      ],
    };
  }

  /** 지급 판단 3결과(제안). 중복 확실만 정지 권고, 낮음만 지급, 나머지는 보류. 최종 결정은 담당자입니다. */
  function decision(result) {
    if (result.cross.certain.length) return '지급 정지 권고';
    return result.risk === '낮음' ? '지급' : '지급 보류';
  }

  const hitSignals = (e) => [...e.medical_signals, ...e.auto_signals].filter((s) => s.hit);
  const flaggedLinks = (e) => e.cross_links.filter((l) => l.verdict !== '정상 분리 청구');
  const citeIds = (e) => unique([
    ...hitSignals(e).flatMap((s) => s.evidence_ids),
    ...flaggedLinks(e).flatMap((l) => [l.accident_id, l.claim_id]),
  ]);

  const legit = {
    med_count: '만성 질환이나 치료 계획에 따라 반복 진료를 받았을 수 있습니다.',
    med_gap: '집중 치료 기간이어서 진료 간격이 짧았을 수 있습니다.',
    med_cost: '고가 치료나 입원 때문에 비용이 높았을 수 있습니다.',
    med_repeat: '분할 청구나 입력 중복일 수 있습니다.',
    med_hospital: '전원이나 전문의 의뢰로 병원을 옮겼을 수 있습니다.',
    auto_count: '서로 무관한 사고가 우연히 가까운 시기에 겹쳤을 수 있습니다.',
    auto_gap: '서로 무관한 사고가 우연히 가까운 시기에 겹쳤을 수 있습니다.',
    auto_treat: '실제로 치료가 오래 필요한 부상일 수 있습니다.',
    auto_cost: '고가 차량이나 부품 때문에 수리비가 높았을 수 있습니다.',
    auto_repeat: '자주 이용하는 정비소나 같은 상대방과의 우연한 반복일 수 있습니다.',
  };
  const legitVerdict = {
    '중복 의심': '서로 다른 비용 항목을 같은 병원에서 청구했을 수 있습니다.',
    '고지 확인': '신고할 때 사고와 질병의 구분을 착오했을 수 있습니다.',
    '판정 불가': '영수증 번호가 단순히 입력되지 않았을 수 있습니다.',
  };

  /** 담당자 질문에 대한 데모 답변. 근거 JSON의 값만 사용하고 질문 종류를 단어로 구분합니다.
   *  answer는 결론 한두 문장, points는 근거를 한 줄씩 나눈 목록입니다. */
  function demoAsk(e, question = '') {
    const q = String(question);
    const hits = hitSignals(e);
    const links = flaggedLinks(e);
    const base = demoExplain(e);
    let answer, points = [];
    if (/정상|억울|문제\s*없|아닐/.test(q)) {
      points = unique([
        ...hits.map((s) => legit[s.id]),
        ...links.map((l) => legitVerdict[l.verdict]),
      ].filter(Boolean));
      answer = points.length
        ? '정상일 수 있는 이유가 있습니다. 다만 확인되기 전에는 위험도를 낮추지 않습니다.'
        : '걸린 항목이 없어 정상 범위로 봅니다.';
    } else if (/확인|서류|증빙|무엇|뭘|어떻게/.test(q)) {
      answer = '아래 항목을 확인하세요.';
      points = base.checks;
    } else if (/점수|몇\s*점|계산/.test(q)) {
      answer = `종합 점수는 ${e.scores.overall}점입니다. 의료와 자동차 점수 중 큰 값입니다.`;
      points = [`의료 점수 ${e.scores.medical}점`, `자동차 점수 ${e.scores.auto}점`, '중복 확실은 점수와 상관없이 높음입니다.'];
    } else {
      answer = `결과는 ${e.decision}입니다. ${e.risk_reason}`;
      points = base.basis;
    }
    return { provider: 'demo', answer, points, citations: citeIds(e).slice(0, 8) };
  }

  /** 증빙 요청서 이메일 본문을 조립합니다. 인사말과 끝인사는 코드가 붙이고,
   *  서류 번호는 숫자 검증에 걸리지 않도록 동그라미 숫자로 붙입니다. */
  function composeRequest(r) {
    const circled = '①②③④⑤⑥⑦⑧⑨⑩';
    const docs = r.documents || [], reasons = r.reasons || [];
    const lines = ['안녕하세요.', '', String(r.intro || '').trim(), '', '[ 요청 서류 ]'];
    docs.forEach((d, i) => {
      lines.push(`${circled[i] || '-'} ${d}`);
      if (reasons[i]) lines.push(`   - ${reasons[i]}`);
    });
    lines.push('', String(r.closing || '').trim(), '', '감사합니다.');
    return lines.join('\n');
  }

  const requestReason = {
    '두 청구의 영수증 원본': '청구 내용과 영수증을 대조하기 위해 필요합니다.',
    '진료비 세부내역서': '진료비 항목과 금액을 확인하기 위해 필요합니다.',
    '다른 보험에서 지급받은 내역 확인서': '같은 비용이 다른 보험에서 지급되었는지 확인하기 위해 필요합니다.',
    '치료 기간을 확인할 수 있는 진료확인서': '치료 기간과 횟수를 확인하기 위해 필요합니다.',
    '초진 경위가 적힌 진료기록 사본': '첫 진료가 어떤 경위로 이루어졌는지 확인하기 위해 필요합니다.',
    '사고와 진료의 관련 여부 확인서': '진료가 사고와 관련된 것인지 확인하기 위해 필요합니다.',
    '빠진 영수증 사본': '영수증 번호가 확인되지 않아 청구 내용을 대조하기 위해 필요합니다.',
    '사고 전 같은 부위 진료기록': '사고 이전의 진료 내역을 확인하기 위해 필요합니다.',
    '치료 계획이 적힌 진료기록부': '진료 횟수가 치료 계획에 따른 것인지 확인하기 위해 필요합니다.',
    '병원을 옮긴 사유가 적힌 진료의뢰서': '병원을 옮기신 사유를 확인하기 위해 필요합니다.',
    '치료 기간 소견이 적힌 진단서': '치료에 필요한 기간에 대한 의사 소견을 확인하기 위해 필요합니다.',
    '각 사고의 경위서': '각 사고의 경위를 확인하기 위해 필요합니다.',
    '수리 견적서와 작업 내역서': '수리 내용과 비용을 확인하기 위해 필요합니다.',
    '청구 내용을 확인할 수 있는 진료기록 사본': '청구 내용을 확인하기 위해 필요합니다.',
  };

  /** 보류 건에 고객에게 보낼 증빙 요청 이메일 초안. 담당자가 확인한 뒤 발송합니다.
   *  documents는 서류 이름, reasons는 같은 순서의 필요한 이유, message는 조립된 본문입니다. */
  function demoRequest(e) {
    if (e.decision === '지급') return { provider: 'demo', subject: '', documents: [], reasons: [], message: '지급 판단이어서 추가 서류가 필요하지 않습니다.' };
    const docs = [];
    const add = (t) => { if (!docs.includes(t)) docs.push(t); };
    const verdicts = e.cross_links.map((l) => l.verdict);
    if (verdicts.includes('중복 확실')) { add('두 청구의 영수증 원본'); add('진료비 세부내역서'); add('다른 보험에서 지급받은 내역 확인서'); }
    if (verdicts.includes('중복 의심')) { add('진료비 세부내역서'); add('치료 기간을 확인할 수 있는 진료확인서'); }
    if (verdicts.includes('고지 확인')) { add('초진 경위가 적힌 진료기록 사본'); add('사고와 진료의 관련 여부 확인서'); }
    if (verdicts.includes('판정 불가')) add('빠진 영수증 사본');
    if (e.cross_links.some((l) => l.prior_claim_ids.length)) add('사고 전 같은 부위 진료기록');
    for (const s of hitSignals(e)) {
      if (['med_count', 'med_gap'].includes(s.id)) add('치료 계획이 적힌 진료기록부');
      if (s.id === 'med_hospital') add('병원을 옮긴 사유가 적힌 진료의뢰서');
      if (s.id === 'med_cost') add('진료비 세부내역서');
      if (s.id === 'auto_treat') add('치료 기간 소견이 적힌 진단서');
      if (['auto_count', 'auto_gap', 'auto_repeat'].includes(s.id)) add('각 사고의 경위서');
      if (s.id === 'auto_cost') add('수리 견적서와 작업 내역서');
    }
    if (!docs.length) add('청구 내용을 확인할 수 있는 진료기록 사본');
    const ids = citeIds(e).slice(0, 5);
    const draft = {
      subject: '[보험금 청구] 추가 서류 제출 안내',
      intro: `보험금 청구 건${ids.length ? `(${ids.join(', ')})` : ''}을 확인하던 중 아래 서류가 추가로 필요해 연락드립니다.`,
      documents: docs,
      reasons: docs.map((d) => requestReason[d] || ''),
      closing: '서류를 확인한 뒤 지급 여부를 안내드리겠습니다. 궁금한 점은 담당자에게 문의해 주세요.',
    };
    return { provider: 'demo', ...draft, message: composeRequest(draft) };
  }

  /** 고객에게 나가는 이메일에 내부 기준이나 압박하는 표현이 섞이지 않게 막는 가드.
   *  LLM이 지시를 어겨도 이 단계에서 코드가 정한 기본 문구로 바꿉니다.
   *  바꾼 항목은 guarded에 남깁니다. */
  function sanitizeRequest(e, r) {
    const base = demoRequest(e);
    const internal = /\d|기준|상위|초과|순위|점수|위험|의심|사기|비정상/;
    const pressure = /필수|반드시|즉시|의심|사기|위험|점수/;
    const guarded = [];
    const docs = [], reasons = [];
    (r.documents || []).slice(0, 10).forEach((d, i) => {
      const name = String(d || '').trim();
      if (!name || internal.test(name)) { guarded.push(`서류 ${i + 1} 삭제`); return; }
      const reason = String(r.reasons?.[i] || '').trim();
      if (!reason || internal.test(reason)) {
        guarded.push(`서류 ${i + 1} 사유`);
        reasons.push(requestReason[name] || '청구 내용을 확인하기 위해 필요합니다.');
      } else reasons.push(reason);
      docs.push(name);
    });
    if (!docs.length) { docs.push(...base.documents); reasons.push(...base.reasons); guarded.push('서류 목록'); }
    const pick = (value, fallback, bad, label) => {
      const v = String(value || '').trim();
      if (!v || bad.test(v)) { guarded.push(label); return fallback; }
      return v;
    };
    return {
      subject: pick(r.subject, base.subject, pressure, '제목'),
      intro: pick(r.intro, base.intro, /기준|상위|초과|순위|점수|위험|의심|사기|비정상/, '연락 사유'),
      documents: docs,
      reasons,
      closing: pick(r.closing, base.closing, pressure, '맺음말'),
      guarded,
    };
  }

  /** 판단 불가 건에서 무엇을 확인하면 판단되는지. */
  function demoGap(e) {
    const gaps = e.cross_links.filter((l) => l.verdict === '판정 불가');
    if (!gaps.length) return { provider: 'demo', summary: '판단 불가 건이 아닙니다.', missing: [], how: [] };
    return {
      provider: 'demo',
      summary: '자동차와 의료 청구가 연결되지만 영수증 번호가 비어 같은 비용을 두 번 받았는지 알 수 없습니다.',
      missing: gaps.map((l) => `사고 ${l.accident_id}와 의료 청구 ${l.claim_id}: 양쪽 영수증 번호가 비어 있습니다.`),
      how: [
        '병원에서 두 청구의 영수증 사본을 받아 번호를 입력하세요.',
        '번호가 같으면 중복 확실이고, 서로 다르면 같은 병원, 같은 기간, 비슷한 금액 비교로 중복 의심 또는 정상 분리를 다시 판정합니다.',
        '영수증을 받을 수 없으면 진료비 세부내역서와 다른 보험의 지급 내역을 대조하세요.',
      ],
    };
  }

  /** API 미연결 시 사용하는 설명. 모든 수치는 위 근거에서만 가져옵니다. */
  function demoExplain(e) {
    const hits = [...e.medical_signals, ...e.auto_signals].filter((s) => s.hit);
    const basis = hits.map((s) => `${s.name}: 관측 ${s.observed} / 기준 ${s.threshold} (${s.note})`);
    for (const link of e.cross_links) {
      if (link.verdict !== '정상 분리 청구') basis.push(`${link.verdict} — ${link.reason} (사고 ${link.accident_id}, 청구 ${link.claim_id})`);
    }
    if (!basis.length) basis.push('지표와 교차 확인에서 걸린 항목이 없습니다.');
    const checks = [];
    if (e.cross_links.some((l) => l.verdict === '중복 확실')) checks.push('같은 영수증으로 지급된 두 건의 원본 영수증과 지급 내역을 대조하세요.');
    if (e.cross_links.some((l) => l.verdict === '중복 의심')) checks.push('같은 병원, 같은 기간의 청구가 서로 다른 비용 항목인지 확인하세요.');
    if (e.cross_links.some((l) => l.verdict === '고지 확인')) checks.push('사고 관련 진료를 질병으로 청구한 사유를 확인하세요.');
    if (e.cross_links.some((l) => l.prior_claim_ids.length)) checks.push('사고 전 같은 부위 진료 기록이 있어 기왕증 기여도를 확인하세요.');
    if (hits.some((s) => s.id === 'med_count' || s.id === 'med_gap')) checks.push('잦은 진료가 치료 계획에 따른 것인지 진료기록으로 확인하세요.');
    if (!checks.length) checks.push('추가 확인이 필요한 항목이 없습니다. 통상 절차로 진행하세요.');
    return {
      provider: 'demo',
      summary: `위험도는 ${e.risk}이고 종합 점수는 ${e.scores.overall}점입니다. ${e.risk_reason}`,
      basis,
      checks,
    };
  }

  /** 설명에 나온 숫자와 근거 번호가 코드 계산 결과에 있는지 확인합니다.
   *  LLM이 지어낸 수치를 걸러내기 위한 단계입니다. */
  function verifyExplanation(e, explanation) {
    const numbers = new Set(), ids = new Set();
    const addNumber = (n) => {
      if (!Number.isFinite(n)) return;
      numbers.add(String(Math.round(n * 10) / 10));
      numbers.add(String(Math.round(n)));
      numbers.add(Math.round(n).toLocaleString('ko-KR'));
    };
    for (const s of [...e.medical_signals, ...e.auto_signals]) {
      addNumber(s.observed); addNumber(s.threshold);
      s.evidence_ids.forEach((id) => ids.add(id));
    }
    for (const key of ['medical', 'auto', 'overall']) addNumber(e.scores[key]);
    for (const key of Object.keys(e.counts)) addNumber(e.counts[key]);
    addNumber(e.paid_total.med); addNumber(e.paid_total.auto);
    addNumber(e.overlap_amount); addNumber(Math.round(e.overlap_ratio * 100));
    for (const value of Object.values(e.config)) addNumber(value);
    for (const link of e.cross_links) {
      addNumber(link.med_paid); addNumber(link.auto_paid);
      ids.add(link.accident_id); ids.add(link.claim_id);
      link.prior_claim_ids.forEach((id) => ids.add(id));
    }
    const haystack = JSON.stringify(e);
    const collect = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(collect)
      : v && typeof v === 'object' ? Object.entries(v).filter(([k]) => k !== 'provider').flatMap(([, x]) => collect(x)) : []);
    const text = collect(explanation).join(' ');
    // 청구 번호, 영수증 번호 같은 식별자를 먼저 확인하고 본문에서 제거한 뒤 숫자를 검사합니다.
    const badIds = unique((text.match(/[A-Z]{1,2}\d{3,6}/g) || [])
      .filter((x) => !ids.has(x) && !haystack.includes(x)));
    const stripped = text.replace(/[A-Z]{1,2}\d{3,6}/g, ' ').replace(/\d{4}-\d{2}-\d{2}/g, ' ');
    const badNumbers = unique((stripped.match(/\d[\d,]*(?:\.\d+)?/g) || [])
      .map((x) => x.replace(/,$/, ''))
      .filter((x) => !numbers.has(x) && !numbers.has(x.replace(/,/g, '')) && !haystack.includes(x.replace(/,/g, ''))));
    // 결과 제안 이름(지급 보류, 지급 정지 권고)이 코드가 정한 결정과 다르게 쓰였는지 확인합니다.
    const badTerms = ['지급 보류', '지급 정지'].filter((t) => text.includes(t) && !String(e.decision).includes(t));
    return { ok: !badNumbers.length && !badIds.length && !badTerms.length, badNumbers, badIds, badTerms };
  }

  /** 정답표와 비교한 성능. 정답표는 화면 데이터에 포함하지 않습니다. */
  function evaluate(results, labels) {
    const rows = results.filter((r) => labels[r.person_id]);
    const count = (predicate) => rows.filter(predicate).length;
    const positive = (r) => r.risk === '높음';
    const actual = (r) => labels[r.person_id].is_suspicious === 1;
    const tp = count((r) => positive(r) && actual(r));
    const fp = count((r) => positive(r) && !actual(r));
    const fn = count((r) => !positive(r) && actual(r));
    const tn = count((r) => !positive(r) && !actual(r));
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const byScenario = {};
    for (const r of rows) {
      const name = labels[r.person_id].scenario;
      byScenario[name] = byScenario[name] || { n: 0, 높음: 0, 보통: 0, 낮음: 0, '판단 불가': 0 };
      byScenario[name].n++;
      byScenario[name][r.risk]++;
    }
    return {
      n: rows.length, tp, fp, fn, tn, precision, recall,
      f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
      fastTrackMiss: count((r) => actual(r) && r.risk === '낮음'),
      byScenario,
    };
  }

  const api = { defaults, analyzePerson, analyzeAll, assemble, summarize, evidence, decision, demoExplain, demoAsk, demoRequest, composeRequest, sanitizeRequest, demoGap, verifyExplanation, evaluate, profile, buildReference, percentile, money, diffDays };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PersonLens = api;
})(typeof window !== 'undefined' ? window : globalThis);
