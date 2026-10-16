const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../dist/charts.js');
const E=require('../dist/engine.js');

const row=(amount,priority='낮음',score=0)=>({amount,priority,score,claim_id:'C'+amount,customer_id:'U',claim_date:'2025-01-01',insurance_type:'실손',rules:[]});

test('linear histogram assigns bin edges and maximum exactly once',()=>{
  const rows=[0,10,20,30,40,50,100].map(x=>row(x));
  const data=C.histogram(rows,{count:10,domain:[0,100]});
  assert.equal(data.total,7);assert.equal(data.bins[0].count,1);assert.equal(data.bins[1].count,1);assert.equal(data.bins[9].count,1);
  for(const bin of data.bins)assert.equal(C.filterRows(rows,{amountRange:bin}).length,bin.count);
});
test('log histogram retains extreme claims and drilldown matches every bar',()=>{
  const rows=[1,2,9,10,99,100,9999,10000,1e8].map((x,i)=>row(x,i%2?'높음':'낮음'));
  const data=C.histogram(rows,{scale:'log',count:12});
  assert.equal(data.total,rows.length);assert.equal(data.max,1e8);assert.equal(data.bins.at(-1).count,1);
  for(const bin of data.bins){const selected=C.filterRows(rows,{amountRange:bin});assert.equal(selected.length,bin.count);assert.equal(selected.filter(x=>x.priority==='높음').length,bin.priorities.높음);}
});
test('empty and identical datasets produce finite SVG geometry',()=>{
  assert.equal(C.histogram([]).total,0);
  const rows=[row(15000),row(15000)];const data=C.histogram(rows,{scale:'log'});
  assert.equal(data.bins.length,1);assert.equal(data.bins[0].count,2);
  for(const html of [C.histogramHTML(rows),C.histogramHTML([]),C.pieHTML(C.prioritySeries(rows),{mode:'pie'}),C.pieHTML([])])assert.doesNotMatch(html,/NaN|Infinity/);
});
test('score histogram includes scores zero and one hundred',()=>{
  const rows=[row(10,'낮음',0),row(20,'높음',100),row(30,'보통',40)];
  const data=C.histogram(rows,{key:'score',count:10,domain:[0,100]});
  assert.equal(data.bins[0].count,1);assert.equal(data.bins.at(-1).count,1);assert.equal(data.total,3);
});
test('pie, rule and monthly totals agree with actual analyzed data',()=>{
  const analysis=E.analyze(E.sample().rows),rows=analysis.results;
  assert.equal(C.prioritySeries(rows).reduce((n,x)=>n+x.value,0),rows.length);
  assert.equal(C.categorySeries(rows).reduce((n,x)=>n+x.value,0),rows.length);
  assert.equal(C.monthlySeries(rows).reduce((n,x)=>n+x.total,0),analysis.summary.total);
  for(const item of C.ruleSeries(rows))assert.equal(C.filterRows(rows,{ruleFilter:item.id}).length,item.value);
});
test('monthly trend fills missing months and preserves cross-year ordering',()=>{
  const rows=[{...row(10),claim_date:'2024-12-01'},{...row(30),claim_date:'2025-02-10'}];
  const months=C.monthlySeries(rows);assert.deepEqual(months.map(x=>x.month),['2024-12','2025-01','2025-02']);assert.equal(months[1].count,0);
  assert.match(C.monthlyHTML(rows),/24\.12/);assert.match(C.monthlyHTML(rows),/25\.02/);
});
test('combined chart filters and quantiles match the selected records',()=>{
  const rows=[{...row(100,'높음',80),rules:[{id:'repeat',hit:true}]},{...row(200,'높음',90),claim_date:'2025-02-01',rules:[{id:'repeat',hit:true}]},row(300,'낮음',5)];
  assert.equal(C.filterRows(rows,{priority:'높음',month:'2025-01',ruleFilter:'repeat',amountRange:{min:100,max:200,last:false}}).length,1);
  assert.equal(C.quantile([1,2,3,4],.5),2.5);assert.equal(C.quantile([], .9),null);
});
test('chart markup escapes category text in both content and action attributes',()=>{
  const unsafe='<img src=x onerror="alert(1)">';const html=C.categoriesHTML([{...row(5),insurance_type:unsafe}],'pie');
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/role="button"/);
});
