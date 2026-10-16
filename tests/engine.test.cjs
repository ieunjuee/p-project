const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('../dist/engine.js');
const claim=(id,date,amount=100,customer='C')=>({claim_id:id,customer_id:customer,claim_date:date,amount,insurance_type:'실손',hospital_id:'H'+id,treatment_type:'외래'});

test('CSV handles quoted fields, BOM and malformed quotes',()=>{
  const rows=[{...claim('A','2025-01-01'),treatment_type:'검사, 정밀'}];
  assert.equal(E.parseCSV(E.csv(rows))[0].treatment_type,'검사, 정밀');
  assert.throws(()=>E.parseCSV('claim_id\nA'),/필수 열/);
  assert.throws(()=>E.parseCSV('"broken'),/따옴표/);
});
test('preprocessing separates invalid, duplicate, missing and impossible dates',()=>{
  const raw=[claim('A','2025-01-01'),claim('A','2025-01-02'),claim('B','2025-02-30'),claim('D','2025-01-03',-3),{...claim('E','2025-01-04'),customer_id:''}];
  const result=E.preprocess(raw);
  assert.equal(result.clean.length,1);assert.equal(result.rejected.length,4);assert.equal(raw[2].claim_date,'2025-02-30');
});
test('features exclude same day and future claims',()=>{
  const raw=[claim('A','2025-01-01'),claim('B','2025-01-01'),claim('C','2025-01-02',500),claim('D','2025-12-01',9999)];
  const cfg={...E.defaults,minPeers:1},a=E.features(E.preprocess(raw.slice(0,3)).clean,cfg),b=E.features(E.preprocess(raw).clean,cfg);
  assert.deepEqual(a,b.slice(0,3));assert.equal(a[0].recentCount,1);assert.equal(a[1].priorClaims,0);assert.equal(a[2].peerMedian,100);assert.equal(a[2].recentCount,3);
});
test('previous gap remains valid outside the rolling window',()=>{
  const rows=E.features(E.preprocess([claim('A','2025-01-01'),claim('B','2025-03-01')]).clean,E.defaults);
  assert.equal(rows[1].recentCount,1);assert.equal(rows[1].gapDays,59);
});
test('repeat rules and adjustable weights recalculate scores',()=>{
  const raw=[1,2,3,4,5].map(n=>claim(String(n),'2025-01-0'+n));
  const a=E.analyze(raw);assert.equal(a.results[3].rules.find(r=>r.id==='repeat').hit,true);
  assert.equal(a.modelInfo.enabled,false);assert.equal(a.results[3].score,a.results[3].ruleScore);
  const sample=E.sample(300),b=E.analyze(sample.rows,{ruleWeight:1}),c=E.analyze(sample.rows,{ruleWeight:0});
  assert.ok(b.results.some((r,i)=>r.score!==c.results[i].score));
  assert.throws(()=>E.analyze(raw,{high:40,medium:50}),/기준/);
});
test('seed makes model reproducible and labels never enter features',()=>{
  const s=E.sample(250),a=E.analyze(s.rows),b=E.analyze(s.rows.map(r=>({...r,is_injected_anomaly:!s.labels[r.claim_id].anomaly})));
  assert.deepEqual(a.results,b.results);
  assert.ok(a.results.every(r=>r.score>=0&&r.score<=100));
});
test('evaluation amounts do not fit the model or score calibration',()=>{
  const s=E.sample(300),a=E.analyze(s.rows),cut=a.modelInfo.cutoff;
  const changed=s.rows.map(r=>r.claim_date>=cut?{...r,amount:r.amount*100}:r),b=E.analyze(changed);
  assert.deepEqual(a.results.filter(r=>r.partition==='학습'),b.results.filter(r=>r.partition==='학습'));
  assert.ok(a.results.filter(r=>r.partition==='학습').every(r=>r.claim_date<cut));
});
test('synthetic evaluation uses only held out dates',()=>{
  const s=E.sample(300),a=E.analyze(s.rows),evaluation=E.evaluate(a,s.labels);
  assert.equal(evaluation.length,3);assert.equal(evaluation[0].n,a.modelInfo.testCount);
  assert.equal(evaluation[0].tp+evaluation[0].fp+evaluation[0].fn+evaluation[0].tn,a.modelInfo.testCount);
});
test('explanations preserve engine scores and omit personal identifiers',()=>{
  const s=E.sample(100),a=E.analyze(s.rows),payload=E.evidence(a.results[0],a),answer=E.demoExplain(payload,'점수는?');
  assert.equal(payload.score,a.results[0].score);assert.equal(payload.customer_id,undefined);assert.equal(payload.hospital_id,undefined);assert.equal(answer.provider,'demo');assert.match(answer.answer,/사기 확률/);
});
test('LLM sends structured selected evidence using server key, accepts schema response',async()=>{
  const {explainClaim}=await import('../llm.mjs');const a=E.analyze(E.sample(100).rows),evidence={...E.evidence(a.results[0],a),customer_id:'private'};let request;
  const expected={summary:'분석 요약',basis:['제공된 근거'],checks:['서류 확인'],answer:null};
  const fetch=async(url,options)=>{request={url,...options};return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(expected)}}]})};};
  const result=await explainClaim(evidence,'',{key:'test-only',fetch});
  assert.equal(result.provider,'api');const sent=JSON.parse(request.body),data=JSON.parse(sent.messages[1].content);
  assert.equal(data.analysis.score,evidence.score);assert.equal(data.analysis.customer_id,undefined);assert.equal(sent.response_format.json_schema.strict,true);
  assert.equal(request.headers.Authorization,'Bearer test-only');
});
test('invalid LLM evidence is rejected and no key returns a demo',async()=>{
  const {explainClaim}=await import('../llm.mjs');await assert.rejects(()=>explainClaim({}),/근거 형식/);
  const a=E.analyze(E.sample(80).rows),p=E.evidence(a.results[0],a);assert.equal((await explainClaim(p,'',{key:''})).provider,'demo');
});
test('identical training distribution does not flag every claim as unusual',()=>{
  const rows=Array.from({length:100},(_,i)=>claim(String(i),new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10),100,'C'+i));
  const a=E.analyze(rows);assert.equal(a.modelInfo.enabled,true);assert.ok(a.results.every(r=>r.mlScore===0&&!r.mlFlag));
});
test('CSV export neutralizes spreadsheet formulas in text fields',()=>{
  const csv=E.csv([{...claim('A','2025-01-01'),insurance_type:'=1+1'}]);
  assert.match(csv,/"'=1\+1"/);
});
