/* 사람 단위 위험도 계산의 SQL 버전.
 * 지표 10개와 교차 판정을 SQLite 쿼리(sql.js, 브라우저 안의 SQLite)로 계산합니다.
 * 점수, 위험도, 결과 제안을 정하는 부분은 person-engine.js의 assemble()을 그대로 씁니다.
 * person-engine.js의 JS 계산과 같은 결과가 나오는지는 tests/person-sql.test.cjs가 사람 전원에게 확인합니다. */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./person-engine.js') : root.PersonLens;
  const unique = (list) => [...new Set(list)];

  function query(db, sql, params) {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }

  /** 백분위 경계: 오름차순 정렬 후 ceil(p*n)번째 값. JS의 percentile()과 같은 방식입니다. */
  const PERCENTILE = (value, group) => `
    SELECT *, CAST(x AS INTEGER) + (x > CAST(x AS INTEGER)) AS c FROM (
      SELECT *, $p * n AS x FROM (
        SELECT ${group} AS g, ${value} AS v,
               ROW_NUMBER() OVER (PARTITION BY ${group} ORDER BY ${value}) AS rn,
               COUNT(*) OVER (PARTITION BY ${group}) AS n
        FROM base))`;

  const SQL = {
    // 의료: 같은 병명 안에서 기간 창(시작 청구부터 N일)의 진료 횟수와 병원 수
    medWindow: `
      SELECT person_id, disease_code, MAX(n) AS cnt, MAX(h) AS hosp FROM (
        SELECT a.person_id, a.disease_code, a.claim_id, COUNT(*) AS n, COUNT(DISTINCT b.hospital_id) AS h
        FROM med_claim a JOIN med_claim b
          ON b.person_id = a.person_id AND b.disease_code = a.disease_code
         AND julianday(b.visit_date) - julianday(a.visit_date) >= 0
         AND julianday(b.visit_date) - julianday(a.visit_date) < $win
        GROUP BY a.person_id, a.disease_code, a.claim_id)
      GROUP BY person_id, disease_code`,
    // 의료: 같은 병명 평균 진료 간격 (건수가 충분할 때만)
    medGap: `
      SELECT person_id, disease_code,
             (julianday(MAX(visit_date)) - julianday(MIN(visit_date))) / (COUNT(*) - 1) AS gap
      FROM med_claim GROUP BY person_id, disease_code HAVING COUNT(*) >= $minClaims`,
    // 의료: 같은 병명과 치료 종류 집단의 상위 5% 금액 이상 청구
    medCost: `
      WITH base AS (SELECT disease_code || '|' || treatment_type AS grp, disease_code, treatment_type, claim_amount FROM med_claim),
      ranked AS (${PERCENTILE('claim_amount', 'grp')}),
      ref AS (SELECT g, v AS threshold FROM ranked WHERE n >= $minPeers AND rn = MIN(n, c))
      SELECT m.person_id, m.claim_id FROM med_claim m
      JOIN ref ON ref.g = m.disease_code || '|' || m.treatment_type
      WHERE m.claim_amount >= ref.threshold`,
    // 의료: 같은 영수증 번호, 또는 같은 날 같은 병원 같은 금액이 반복된 청구
    medRepeat: `
      SELECT person_id, claim_id FROM (
        SELECT person_id, claim_id,
          CASE WHEN receipt_no IS NOT NULL AND receipt_no <> ''
               THEN COUNT(*) OVER (PARTITION BY person_id, receipt_no) ELSE 0 END AS r,
          COUNT(*) OVER (PARTITION BY person_id, visit_date, hospital_id, claim_amount) AS s
        FROM med_claim) WHERE r >= $rc OR s >= $rc`,
    // 자동차: 기간 창 안의 사고 수
    autoCount: `
      SELECT person_id, MAX(n) AS n FROM (
        SELECT a.person_id, a.accident_id, COUNT(*) AS n
        FROM auto_accident a JOIN auto_accident b
          ON b.person_id = a.person_id
         AND julianday(b.accident_date) - julianday(a.accident_date) >= 0
         AND julianday(b.accident_date) - julianday(a.accident_date) < $win
        GROUP BY a.person_id, a.accident_id)
      GROUP BY person_id`,
    // 자동차: 가장 짧은 사고 간격
    autoGap: `
      SELECT person_id, MIN(gap) AS gap FROM (
        SELECT person_id, julianday(accident_date)
               - julianday(LAG(accident_date) OVER (PARTITION BY person_id ORDER BY accident_date, rowid)) AS gap
        FROM auto_accident) WHERE gap IS NOT NULL GROUP BY person_id`,
    // 자동차: 접촉 사고 대인 치료 기간이 같은 접촉 사고 집단의 상위 5% 경계를 넘음
    autoTreat: `
      WITH base AS (
        SELECT c.auto_claim_id, c.person_id, 'all' AS grp,
               julianday(c.treat_end) - julianday(c.treat_start) + 1 AS dur
        FROM auto_claim c JOIN auto_accident a ON a.accident_id = c.accident_id
        WHERE c.claim_type = '대인치료비' AND c.treat_start IS NOT NULL AND c.treat_start <> ''
          AND c.treat_end IS NOT NULL AND c.treat_end <> '' AND a.accident_type = '접촉'),
      ranked AS (${PERCENTILE('dur', 'grp')}),
      ref AS (SELECT v AS threshold FROM ranked WHERE n >= $minPeers AND rn = MIN(n, c))
      SELECT b.person_id, b.auto_claim_id FROM base b, ref WHERE b.dur > ref.threshold`,
    // 자동차: 같은 사고 유형 집단의 상위 5% 수리비
    autoCost: `
      WITH base AS (
        SELECT c.auto_claim_id, c.person_id, c.amount, COALESCE(a.accident_type, '미상') AS grp
        FROM auto_claim c LEFT JOIN auto_accident a ON a.accident_id = c.accident_id
        WHERE c.claim_type = '대물수리비'),
      ranked AS (${PERCENTILE('amount', 'grp')}),
      ref AS (SELECT g, v AS threshold FROM ranked WHERE n >= $minPeers AND rn = MIN(n, c))
      SELECT b.person_id, b.auto_claim_id FROM base b JOIN ref ON ref.g = b.grp WHERE b.amount >= ref.threshold`,
    // 자동차: 같은 상대방이나 정비소가 반복된 사고, 같은 사고에 같은 종류를 반복 청구한 건
    autoRepeatAccident: `
      SELECT person_id, accident_id AS id FROM (
        SELECT person_id, accident_id,
          CASE WHEN counterparty_id IS NOT NULL AND counterparty_id <> ''
               THEN COUNT(*) OVER (PARTITION BY person_id, counterparty_id) ELSE 0 END AS a,
          CASE WHEN repair_shop_id IS NOT NULL AND repair_shop_id <> ''
               THEN COUNT(*) OVER (PARTITION BY person_id, repair_shop_id) ELSE 0 END AS b
        FROM auto_accident) WHERE a >= $rc OR b >= $rc`,
    autoRepeatClaim: `
      SELECT person_id, auto_claim_id AS id FROM (
        SELECT person_id, auto_claim_id,
               COUNT(*) OVER (PARTITION BY accident_id, claim_type) AS n FROM auto_claim) WHERE n >= $rc`,
    // 교차: 사고 후 N일 안의 손상 진료와, 같은 사고의 대인치료비 청구를 짝지어 판정 재료를 만듭니다.
    crossPairs: `
      SELECT a.person_id, a.accident_id, m.claim_id AS med_id, ac.auto_claim_id AS care_id,
        CASE WHEN ac.receipt_no IS NOT NULL AND ac.receipt_no <> '' AND m.receipt_no IS NOT NULL AND m.receipt_no <> ''
              AND ac.receipt_no = m.receipt_no AND ac.paid_amount > 0 AND m.paid_amount > 0 THEN 1 ELSE 0 END AS cert,
        CASE WHEN (ac.receipt_no IS NULL OR ac.receipt_no = '') AND (m.receipt_no IS NULL OR m.receipt_no = '')
              AND ac.hospital_id IS NOT NULL AND ac.hospital_id <> '' AND ac.hospital_id = m.hospital_id
              AND ac.treat_start IS NOT NULL AND ac.treat_start <> '' AND ac.treat_end IS NOT NULL AND ac.treat_end <> ''
              AND m.visit_date >= ac.treat_start AND m.visit_date <= ac.treat_end THEN 1 ELSE 0 END AS undec,
        CASE WHEN ac.hospital_id IS NOT NULL AND ac.hospital_id <> '' AND ac.hospital_id = m.hospital_id
              AND ac.treat_start IS NOT NULL AND ac.treat_start <> '' AND ac.treat_end IS NOT NULL AND ac.treat_end <> ''
              AND m.visit_date >= ac.treat_start AND m.visit_date <= ac.treat_end
              AND MAX(ac.amount, m.claim_amount) > 0
              AND (MAX(ac.amount, m.claim_amount) - MIN(ac.amount, m.claim_amount)) * 1.0 / MAX(ac.amount, m.claim_amount) <= $tol
             THEN 1 ELSE 0 END AS susp
      FROM auto_accident a
      JOIN med_claim m ON m.person_id = a.person_id
      JOIN kcd_master k ON k.disease_code = m.disease_code AND k.injury_flag = 1
      LEFT JOIN auto_claim ac ON ac.accident_id = a.accident_id AND ac.claim_type = '대인치료비'
      WHERE julianday(m.visit_date) - julianday(a.accident_date) >= 0
        AND julianday(m.visit_date) - julianday(a.accident_date) <= $cw
      ORDER BY a.person_id, a.accident_date, a.rowid, m.visit_date, m.rowid, ac.claim_date, ac.rowid`,
    // 교차: 사고 전 N일 안에 같은 부위로 진료받은 기록 (기왕증)
    crossPrior: `
      SELECT a.accident_id, m.claim_id AS med_id, p.claim_id AS prior_id
      FROM auto_accident a
      JOIN med_claim m ON m.person_id = a.person_id
      JOIN kcd_master k ON k.disease_code = m.disease_code AND k.injury_flag = 1
      JOIN med_claim p ON p.person_id = a.person_id
      JOIN kcd_master kp ON kp.disease_code = p.disease_code AND kp.body_part IS k.body_part
      WHERE julianday(m.visit_date) - julianday(a.accident_date) >= 0
        AND julianday(m.visit_date) - julianday(a.accident_date) <= $cw
        AND julianday(a.accident_date) - julianday(p.visit_date) > 0
        AND julianday(a.accident_date) - julianday(p.visit_date) <= $prior
      ORDER BY p.visit_date, p.rowid`,
    // 화면 표시용 원본 행
    persons: 'SELECT * FROM person ORDER BY rowid',
    kcd: 'SELECT * FROM kcd_master ORDER BY rowid',
    med: 'SELECT * FROM med_claim ORDER BY visit_date, rowid',
    accidents: 'SELECT * FROM auto_accident ORDER BY accident_date, rowid',
    autoClaims: 'SELECT * FROM auto_claim ORDER BY claim_date, rowid',
  };

  const signal = (id, name, hit, observed, threshold, evidence, note) =>
    ({ id, name, hit: !!hit, observed, threshold, evidence: evidence || [], note: note || '' });
  const byPerson = (rows, pick) => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.person_id)) map.set(r.person_id, []);
      map.get(r.person_id).push(pick ? pick(r) : r);
    }
    return map;
  };

  /** SQLite 데이터베이스 전체를 SQL로 분석합니다. 반환 형태는 PersonLens.analyzeAll과 같습니다. */
  function analyzeAllSql(db, settings) {
    const cfg = { ...E.defaults, ...(settings || {}) };
    const pct = { $p: cfg.costPercentile, $minPeers: cfg.minPeers };

    const persons = query(db, SQL.persons);
    const kcd = new Map(query(db, SQL.kcd).map((k) => [k.disease_code, k]));
    const medBy = byPerson(query(db, SQL.med));
    const accBy = byPerson(query(db, SQL.accidents));
    const claimBy = byPerson(query(db, SQL.autoClaims));

    const medWindow = byPerson(query(db, SQL.medWindow, { $win: cfg.medWindowDays }));
    const medGap = byPerson(query(db, SQL.medGap, { $minClaims: cfg.medGapMinClaims }));
    const medCost = byPerson(query(db, SQL.medCost, pct), (r) => r.claim_id);
    const medRepeat = byPerson(query(db, SQL.medRepeat, { $rc: cfg.repeatCount }), (r) => r.claim_id);
    const autoCount = new Map(query(db, SQL.autoCount, { $win: cfg.autoWindowDays }).map((r) => [r.person_id, r.n]));
    const autoGap = new Map(query(db, SQL.autoGap).map((r) => [r.person_id, r.gap]));
    const autoTreat = byPerson(query(db, SQL.autoTreat, pct), (r) => r.auto_claim_id);
    const autoCost = byPerson(query(db, SQL.autoCost, pct), (r) => r.auto_claim_id);
    const repeatAcc = byPerson(query(db, SQL.autoRepeatAccident, { $rc: cfg.repeatCount }), (r) => r.id);
    const repeatClaim = byPerson(query(db, SQL.autoRepeatClaim, { $rc: cfg.repeatCount }), (r) => r.id);
    const pairsBy = byPerson(query(db, SQL.crossPairs, { $tol: cfg.amountTolerance, $cw: cfg.crossWindowDays }));
    const priorMap = new Map();
    for (const r of query(db, SQL.crossPrior, { $cw: cfg.crossWindowDays, $prior: cfg.priorDays })) {
      const key = r.accident_id + '|' + r.med_id;
      if (!priorMap.has(key)) priorMap.set(key, []);
      priorMap.get(key).push(r.prior_id);
    }

    const results = persons.map((person) => {
      const id = person.person_id;
      const rec = { person, med: medBy.get(id) || [], accidents: accBy.get(id) || [], autoClaims: claimBy.get(id) || [] };
      const pick = (list, set) => list.filter((x) => set.has(x[1])).map((x) => x[0]);
      const inRecord = (rows, key, ids) => { const set = new Set(ids || []); return rows.filter((r) => set.has(r[key])).map((r) => r[key]); };

      // 의료 지표
      const groups = new Map();
      for (const row of rec.med) if (!groups.has(row.disease_code)) groups.set(row.disease_code, []);
      const win = new Map((medWindow.get(id) || []).map((w) => [w.disease_code, w]));
      const idsOf = (code) => rec.med.filter((r) => r.disease_code === code).map((r) => r.claim_id);
      let bestCount = 0, countCode = null, bestHosp = 0, hospCode = null;
      for (const code of groups.keys()) {
        const w = win.get(code);
        if (w.cnt > bestCount) { bestCount = w.cnt; countCode = code; }
        if (w.hosp > bestHosp) { bestHosp = w.hosp; hospCode = code; }
      }
      let bestGap = null, gapCode = null;
      const gapRows = new Map((medGap.get(id) || []).map((g) => [g.disease_code, g.gap]));
      for (const code of groups.keys()) {
        if (!gapRows.has(code)) continue;
        if (bestGap === null || gapRows.get(code) < bestGap) { bestGap = gapRows.get(code); gapCode = code; }
      }
      const costIds = inRecord(rec.med, 'claim_id', medCost.get(id));
      const repeatIds = inRecord(rec.med, 'claim_id', medRepeat.get(id));
      const med = [
        signal('med_count', '진료 횟수', bestCount >= cfg.medVisitCount, bestCount, cfg.medVisitCount,
          bestCount >= cfg.medVisitCount ? idsOf(countCode) : [],
          countCode ? `${countCode} 기준 ${cfg.medWindowDays}일 최대 ${bestCount}회` : '진료 기록 없음'),
        signal('med_gap', '진료 간격', bestGap !== null && bestGap < cfg.medGapDays,
          bestGap === null ? null : Math.round(bestGap * 10) / 10, cfg.medGapDays,
          bestGap !== null && bestGap < cfg.medGapDays ? idsOf(gapCode) : [],
          bestGap === null ? `같은 병명 ${cfg.medGapMinClaims}건 미만으로 평가 보류` : '평균 간격(일)'),
        signal('med_cost', '진료비', costIds.length >= cfg.costHitCount, costIds.length, cfg.costHitCount,
          costIds.length >= cfg.costHitCount ? costIds : [],
          `같은 병명과 치료 종류 중 상위 ${Math.round((1 - cfg.costPercentile) * 100)}% 금액 ${costIds.length}건`),
        signal('med_repeat', '반복 청구', repeatIds.length > 0, repeatIds.length, cfg.repeatCount, repeatIds,
          '같은 영수증 번호 또는 같은 날, 같은 병원, 같은 금액'),
        signal('med_hospital', '병원 분산', bestHosp >= cfg.medHospitalCount, bestHosp, cfg.medHospitalCount,
          bestHosp >= cfg.medHospitalCount ? idsOf(hospCode) : [],
          `같은 병명으로 ${cfg.medWindowDays}일 안에 이용한 병원 수`),
      ];

      // 자동차 지표
      const count = autoCount.get(id) || 0;
      const minGap = autoGap.has(id) ? autoGap.get(id) : null;
      const accIds = rec.accidents.map((a) => a.accident_id);
      const treatIds = inRecord(rec.autoClaims, 'auto_claim_id', autoTreat.get(id));
      const costAutoIds = inRecord(rec.autoClaims, 'auto_claim_id', autoCost.get(id));
      const repeatAuto = unique([
        ...inRecord(rec.accidents, 'accident_id', repeatAcc.get(id)),
        ...inRecord(rec.autoClaims, 'auto_claim_id', repeatClaim.get(id)),
      ]);
      const auto = [
        signal('auto_count', '사고 횟수', count >= cfg.autoAccidentCount, count, cfg.autoAccidentCount,
          count >= cfg.autoAccidentCount ? accIds : [], `${cfg.autoWindowDays}일 안의 최대 사고 수`),
        signal('auto_gap', '사고 간격', minGap !== null && minGap < cfg.autoGapDays, minGap, cfg.autoGapDays,
          minGap !== null && minGap < cfg.autoGapDays ? accIds : [],
          minGap === null ? '사고가 1건 이하' : '가장 짧은 사고 간격(일)'),
        signal('auto_treat', '치료 기간', treatIds.length > 0, treatIds.length, 1, treatIds,
          `접촉 사고(경미 사고 대신) 대인 치료 기간이 상위 ${Math.round((1 - cfg.costPercentile) * 100)}% 경계 초과`),
        signal('auto_cost', '수리비', costAutoIds.length > 0, costAutoIds.length, 1, costAutoIds,
          `같은 사고 유형 중 상위 ${Math.round((1 - cfg.costPercentile) * 100)}% 수리비`),
        signal('auto_repeat', '반복 청구', repeatAuto.length > 0, repeatAuto.length, cfg.repeatCount, repeatAuto,
          '같은 상대방이나 정비소, 또는 같은 사고에 같은 종류를 여러 번 청구'),
      ];

      // 교차 판정: SQL이 만든 짝(사고, 진료, 대인치료비)을 순서대로 보며 판정을 정합니다.
      const medById = new Map(rec.med.map((m) => [m.claim_id, m]));
      const careById = new Map(rec.autoClaims.map((c) => [c.auto_claim_id, c]));
      const accById = new Map(rec.accidents.map((a) => [a.accident_id, a]));
      const links = [];
      const order = [];
      const grouped = new Map();
      for (const r of pairsBy.get(id) || []) {
        const key = r.accident_id + '|' + r.med_id;
        if (!grouped.has(key)) { grouped.set(key, []); order.push(key); }
        if (r.care_id) grouped.get(key).push(r);
      }
      for (const key of order) {
        const [accidentId, medId] = key.split('|');
        const accident = accById.get(accidentId), medRow = medById.get(medId);
        let verdict = '정상 분리 청구', reason = '사고와 연결되지만 중복으로 볼 근거가 없습니다.', pair = null;
        for (const r of grouped.get(key)) {
          if (r.cert) {
            verdict = '중복 확실';
            reason = `같은 영수증 번호 ${medRow.receipt_no}가 자동차와 의료 양쪽에서 지급되었습니다.`;
            pair = careById.get(r.care_id); break;
          }
          if (r.undec) {
            verdict = '판정 불가';
            reason = '양쪽 영수증 번호가 비어 있어 같은 비용인지 확인할 수 없습니다.';
            pair = careById.get(r.care_id); continue;
          }
          if (r.susp && verdict === '정상 분리 청구') {
            verdict = '중복 의심';
            reason = '영수증 번호는 다르지만 같은 병원, 같은 치료 기간, 금액 차이가 5% 이내입니다.';
            pair = careById.get(r.care_id);
          }
        }
        if (verdict === '정상 분리 청구' && medRow.accident_flag === '질병') {
          verdict = '고지 확인';
          reason = '사고 관련 손상 진료인데 의료보험에는 질병으로 청구되었습니다.';
        }
        links.push({
          accident_id: accident.accident_id, accident_date: accident.accident_date, accident_type: accident.accident_type,
          claim_id: medRow.claim_id, visit_date: medRow.visit_date, disease_code: medRow.disease_code,
          body_part: kcd.get(medRow.disease_code).body_part, hospital_id: medRow.hospital_id,
          med_amount: medRow.claim_amount, med_paid: medRow.paid_amount,
          auto_claim_id: pair ? pair.auto_claim_id : null, auto_paid: pair ? pair.paid_amount : null,
          verdict, reason, prior: priorMap.get(key) || [],
        });
      }
      const of = (name) => links.filter((l) => l.verdict === name);
      const overlap = [...of('중복 확실'), ...of('중복 의심')]
        .reduce((sum, l) => sum + Math.min(l.auto_paid || 0, l.med_paid || 0), 0);
      const linkedPaid = links.reduce((sum, l) => sum + (l.med_paid || 0), 0);
      const cross = {
        links, certain: of('중복 확실'), suspected: of('중복 의심'), disclosure: of('고지 확인'),
        prior: links.filter((l) => l.prior.length), undecidable: of('판정 불가'),
        overlapAmount: overlap, overlapRatio: linkedPaid ? overlap / linkedPaid : 0,
      };
      return E.assemble(id, rec, med, auto, cross, cfg);
    });
    return { ...E.summarize(results), config: cfg, reference: null, source: 'sql' };
  }

  /** 화면 표시용 건수와 생성 정보. */
  function describe(db) {
    const one = (sql) => query(db, sql)[0].n;
    return {
      med_claim: one('SELECT COUNT(*) AS n FROM med_claim'),
      auto_accident: one('SELECT COUNT(*) AS n FROM auto_accident'),
      auto_claim: one('SELECT COUNT(*) AS n FROM auto_claim'),
    };
  }

  const api = { analyzeAllSql, describe, SQL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PersonSql = api;
})(typeof window !== 'undefined' ? window : globalThis);
