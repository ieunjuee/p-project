const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const folder=path.resolve(__dirname,'../dist');
const tick=()=>new Promise(resolve=>setTimeout(resolve,35));
async function openApp(){
  const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(fs.readFileSync(path.join(folder,'legacy.html'),'utf8'),{url:'https://example.test/p-project/dist/legacy.html',runScripts:'outside-only',virtualConsole:console});
  const w=dom.window;w.scrollTo=()=>{};w.print=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.URL.createObjectURL=()=> 'blob:unit-test';w.URL.revokeObjectURL=()=>{};
  for(const file of ['runtime.js','engine.js','charts.js','app.js']){
    const source=fs.readFileSync(path.join(folder,file),'utf8');
    w.eval(source+(file==='app.js'?'\nwindow.__test = {getState:()=>state,setDownload:fn=>{download=fn;}};':''));
  }
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.match(w.document.querySelector('main').textContent,/청구 금액 히스토그램/);
  return {dom,w,d:w.document,errors};
}
function click(w,element){assert.ok(element,'Expected interactive chart control');element.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));}

test('dashboard switches chart modes without changing analysis totals',async()=>{
  const {dom,w,d,errors}=await openApp();
  try{
    const total=d.querySelector('.metric-number').textContent;
    for(const [name,mode] of [['types','pie'],['trend','total']]){
      click(w,d.querySelector(`[data-chart-view="${name}"][data-chart-mode="${mode}"]`));
      assert.equal(d.querySelector(`[data-chart-view="${name}"][aria-pressed="true"]`).dataset.chartMode,mode);
      assert.equal(d.querySelector('.metric-number').textContent,total);
    }
    assert.match(d.querySelector('main').textContent,/로그 간격/);
    assert.equal(d.querySelector('[data-chart-view="priority"]'),null,'우선순위 분포는 도넛만 남긴다');
    assert.equal(d.querySelector('[data-chart-view="amount"]'),null,'금액 히스토그램은 로그 간격만 남긴다');
    assert.ok(d.querySelector('.pie-center'),'도넛 중앙 합계가 표시된다');
    assert.equal(d.querySelectorAll('.subgrid.wide-pair>.panel').length,2,'우선순위 분포와 보험 유형별 청구가 한 줄에 둘');
    assert.equal(d.querySelector('.left-column .subgrid'),null,'두 카드는 왼쪽 열 밖(가로 전체)에 있다');
    assert.deepEqual(errors,[]);
  }finally{dom.window.close();}
});
test('histogram drilldown, filter removal and filtered CSV use the same rows',async()=>{
  const {dom,w,d,errors}=await openApp();
  try{
    const bin=d.querySelector('[data-chart-filter="amountRange"]'),range=JSON.parse(bin.dataset.chartValue);
    const expected=w.LensCharts.filterRows(w.__test.getState().analysis.results,{amountRange:range}).length;
    click(w,bin);await tick();
    assert.match(d.querySelector('.table-foot [role="status"]').textContent,new RegExp(expected.toLocaleString('ko-KR')+'건 중'));
    assert.ok(d.querySelector('[data-clear-filter="amountRange"]'));
    w.__test.setDownload((name,text)=>{w.__csvRows=w.InsureLens.parseCSV(text).length;});
    click(w,d.querySelector('[data-action="export"]'));assert.equal(w.__csvRows,expected);
    click(w,d.querySelector('[data-clear-filter="amountRange"]'));
    assert.match(d.querySelector('.table-foot [role="status"]').textContent,/2,000건 중/);assert.deepEqual(errors,[]);
  }finally{dom.window.close();}
});
test('pie selection and keyboard chart actions route to exact priority filters',async()=>{
  const {dom,w,d,errors}=await openApp();
  try{
    const button=[...d.querySelectorAll('.pie-legend-item')].find(el=>JSON.parse(el.dataset.chartValue)==='높음');
    const high=w.__test.getState().analysis.summary.high;click(w,button);await tick();
    assert.equal(d.querySelector('#priority-filter').value,'높음');
    assert.match(d.querySelector('.table-foot [role="status"]').textContent,new RegExp(high+'건 중'));
    click(w,d.querySelector('[data-reset-filters]'));
    const point=d.querySelector('.chart-hit[data-select]');point.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();
    assert.match(d.querySelector('main').textContent,/AI 검토 어시스턴트/);assert.deepEqual(errors,[]);
  }finally{dom.window.close();}
});
test('all pages render after visual filters and settings still recalculate',async()=>{
  const {dom,w,d,errors}=await openApp();
  try{
    for(const page of ['review','detail','report','about','dashboard']){w.location.hash=page;await tick();assert.ok(d.querySelector('main h1'));}
    click(w,d.querySelector('[data-action="settings"]'));d.querySelector('[name="repeatCount"]').value='2';
    d.querySelector('#settings-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(w.__test.getState().analysis.config.repeatCount,2);assert.ok(d.querySelector('[data-action="close-change"]'),'기준 변경 띠가 보여야 함');
    click(w,d.querySelector('[data-action="close-change"]'));
    assert.equal(d.querySelector('[data-action="close-change"]'),null);assert.ok(d.querySelector('[data-action="open-change"]'),'닫으면 다시 보기 버튼이 있어야 함');
    click(w,d.querySelector('[data-action="open-change"]'));
    assert.ok(d.querySelector('[data-action="close-change"]'),'다시 열면 띠가 돌아와야 함');assert.deepEqual(errors,[]);
  }finally{dom.window.close();}
});
