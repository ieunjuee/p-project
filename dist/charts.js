(function (root) {
  'use strict';
  const colors = {높음:'#c9956c',보통:'#a7bda7',낮음:'#dce9e0'};
  const palette = ['#397b65','#8db6a0','#c1d5c5','#caa779','#829ea9','#b1a4bd','#9aaf89','#d1b7a3'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => Number(value).toLocaleString('ko-KR',{maximumFractionDigits:2});
  const amount = value => {
    if (Math.abs(value)>=1e8) return number(value/1e8)+'억';
    if (Math.abs(value)>=1e4) return number(value/1e4)+'만';
    return number(value);
  };
  const action = (filter,value,label) => `class="chart-hit" role="button" tabindex="0" data-chart-filter="${filter}" data-chart-value="${esc(JSON.stringify(value))}" data-tooltip="${esc(label)}" aria-label="${esc(label+' · 해당 청구 보기')}"`;
  const empty = text => `<div class="chart-empty">${esc(text)}</div>`;
  function quantile(values,q) {
    const sorted=values.filter(Number.isFinite).slice().sort((a,b)=>a-b);
    if (!sorted.length) return null;
    const position=(sorted.length-1)*Math.max(0,Math.min(1,q)),low=Math.floor(position),fraction=position-low;
    return sorted[low]+((sorted[low+1]??sorted[low])-sorted[low])*fraction;
  }
  function inRange(value,range) {
    return !range || (value>=range.min && (range.last?value<=range.max:value<range.max));
  }
  function histogram(rows,{key='amount',count=12,scale='linear',domain=null}={}) {
    const valid=rows.filter(row=>Number.isFinite(row[key])&&(scale!=='log'||row[key]>=0));
    if (!valid.length) return {bins:[],total:0,min:null,max:null,scale};
    const values=valid.map(row=>row[key]),min=domain?domain[0]:Math.min(...values),max=domain?domain[1]:Math.max(...values);
    const size=min===max?1:Math.max(1,Math.min(30,Math.trunc(count)||12));
    const transform=scale==='log'?Math.log1p:x=>x,inverse=scale==='log'?Math.expm1:x=>x;
    const lower=transform(min),span=transform(max)-lower;
    const edges=Array.from({length:size+1},(_,i)=>i===0?min:i===size?max:inverse(lower+span*i/size));
    const bins=Array.from({length:size},(_,i)=>({min:edges[i],max:edges[i+1],last:i===size-1,count:0,priorities:{높음:0,보통:0,낮음:0}}));
    for (const row of valid) {
      const bin=bins.find(bin=>inRange(row[key],bin));
      if (bin) {bin.count++;if(row.priority in bin.priorities)bin.priorities[row.priority]++;}
    }
    return {bins,total:bins.reduce((n,bin)=>n+bin.count,0),min,max,scale};
  }
  function prioritySeries(rows) {
    return ['높음','보통','낮음'].map(label=>({label,value:rows.filter(row=>row.priority===label).length,color:colors[label]}));
  }
  function categorySeries(rows) {
    const groups=new Map();rows.forEach(row=>groups.set(row.insurance_type,(groups.get(row.insurance_type)||0)+1));
    return [...groups].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([label,value],i)=>({label,value,color:palette[i%palette.length]}));
  }
  function ruleSeries(rows) {
    const groups=new Map();
    rows.forEach(row=>row.rules.forEach(rule=>{
      if(!groups.has(rule.id))groups.set(rule.id,{id:rule.id,label:rule.name,value:0});
      if(rule.hit)groups.get(rule.id).value++;
    }));
    return [...groups.values()].sort((a,b)=>b.value-a.value);
  }
  function monthlySeries(rows) {
    const groups=new Map();rows.forEach(row=>{
      const key=row.claim_date.slice(0,7);if(!groups.has(key))groups.set(key,{month:key,count:0,total:0});
      const item=groups.get(key);item.count++;item.total+=row.amount;
    });
    const keys=[...groups.keys()].sort();if(!keys.length)return [];
    const [firstYear,firstMonth]=keys[0].split('-').map(Number),[lastYear,lastMonth]=keys.at(-1).split('-').map(Number);
    const start=firstYear*12+firstMonth-1,end=lastYear*12+lastMonth-1;
    if(end-start<=120)for(let index=start;index<=end;index++){
      const key=String(Math.floor(index/12)).padStart(4,'0')+'-'+String(index%12+1).padStart(2,'0');
      if(!groups.has(key))groups.set(key,{month:key,count:0,total:0});
    }
    return [...groups.values()].sort((a,b)=>a.month.localeCompare(b.month));
  }
  function niceMaximum(value) {
    if(value<=1)return 1;
    const unit=10**Math.floor(Math.log10(value));return Math.ceil(value/unit/0.5)*unit*0.5;
  }
  function dataTable(headers,rows) {
    return `<details class="chart-data"><summary>수치 표로 보기</summary><div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  }
  function priorityLegend() {
    return `<div class="plot-legend">${Object.entries(colors).map(([label,color])=>`<span><i style="background:${color}"></i>${label}</span>`).join('')}</div>`;
  }
  function histogramHTML(rows,{kind='amount',scale='linear',count=12,config={medium:40,high:70}}={}) {
    const isAmount=kind==='amount',data=histogram(rows,{key:isAmount?'amount':'score',count,scale:isAmount?scale:'linear',domain:isAmount?null:[0,100]});
    if(!data.total)return empty('현재 조건에 맞는 청구가 없습니다. 필터를 조정해 주세요.');
    const w=640,h=252,left=48,right=20,top=30,bottom=48,pw=w-left-right,ph=h-top-bottom,max=niceMaximum(Math.max(...data.bins.map(bin=>bin.count)));
    const unit=pw/data.bins.length,barWidth=Math.max(2,unit-5),ticks=[...new Set(Array.from({length:6},(_,i)=>Math.round(i*data.bins.length/5)))];
    const rangeText=bin=>data.min===data.max?number(bin.min)+(isAmount?'원':'점'):`${number(bin.min)}${isAmount?'원':'점'} 이상, ${number(bin.max)}${isAmount?'원':'점'} ${bin.last?'이하':'미만'}`;
    const bars=data.bins.map((bin,i)=>{
      let height=0;const x=left+i*unit+2.5,label=`${rangeText(bin)} · ${number(bin.count)}건 · 높음 ${bin.priorities.높음}건`;
      const segments=['낮음','보통','높음'].map(priority=>{
        const size=bin.priorities[priority]/max*ph,y=top+ph-height-size;height+=size;
        return `<rect class="hist-segment" x="${x}" y="${y}" width="${barWidth}" height="${size}" fill="${colors[priority]}"/>`;
      }).join('');
      return `<g ${bin.count?action(isAmount?'amountRange':'scoreRange',{min:bin.min,max:bin.max,last:bin.last,label:rangeText(bin)},label):''}><rect class="hist-hit-area" x="${left+i*unit}" y="${top}" width="${unit}" height="${ph}" fill="transparent"/>${segments}${bin.count&&bin.count/max>.1?`<text class="bar-count" x="${x+barWidth/2}" y="${top+ph-height-7}" text-anchor="middle">${number(bin.count)}</text>`:''}<title>${esc(label)}</title></g>`;
    }).join('');
    const thresholds=isAmount?'':[['보통',config.medium,'#9aaa8d'],['높음',config.high,'#bd9162']].map(([label,value,color],i)=>`<line x1="${left+value/100*pw}" x2="${left+value/100*pw}" y1="${top}" y2="${top+ph}" stroke="${color}" stroke-dasharray="4 4"/><text x="${left+value/100*pw}" y="${12+i*12}" text-anchor="middle" style="fill:${color}">${label} ${value}점</text>`).join('');
    return `${priorityLegend()}<div class="chart interactive-chart"><svg viewBox="0 0 ${w} ${h}" role="group" aria-label="${isAmount?'청구 금액':'검토 점수'} 히스토그램, 총 ${data.total}건">${[0,.25,.5,.75,1].map(t=>`<line class="grid-line" x1="${left}" x2="${w-right}" y1="${top+ph*t}" y2="${top+ph*t}"/><text x="${left-9}" y="${top+ph*t+3}" text-anchor="end">${number(max*(1-t))}</text>`).join('')}${bars}${thresholds}${ticks.map(i=>`<text x="${left+i*unit}" y="${h-27}" text-anchor="middle">${isAmount?amount(i===data.bins.length?data.max:data.bins[i].min):i*100/data.bins.length}</text>`).join('')}<text x="${left}" y="16">청구 건수</text><text x="${left+pw/2}" y="${h-6}" text-anchor="middle">${isAmount?'청구 금액 (원)'+(scale==='log'?' · 로그 간격':' · 동일 간격'):'검토 우선순위 점수 (0–100)'}</text></svg><div class="chart-tooltip" role="tooltip" hidden></div></div><div class="plot-help">막대에 마우스를 올리면 수치가, 누르면 해당 청구가 표시됩니다.</div>${dataTable([isAmount?'금액 구간':'점수 구간','건수','높음 / 보통 / 낮음'],data.bins.map(bin=>[rangeText(bin),number(bin.count),`${bin.priorities.높음} / ${bin.priorities.보통} / ${bin.priorities.낮음}`]))}`;
  }
  function slicePath(start,end,inner=0) {
    const center=110,outer=86,point=(angle,r)=>[center+Math.cos(angle)*r,center+Math.sin(angle)*r];
    const a=point(start,outer),b=point(end,outer),large=end-start>Math.PI?1:0;
    if(inner){const c=point(end,inner),d=point(start,inner);return `M${a} A${outer} ${outer} 0 ${large} 1 ${b} L${c} A${inner} ${inner} 0 ${large} 0 ${d} Z`;}
    return `M${center} ${center} L${a} A${outer} ${outer} 0 ${large} 1 ${b} Z`;
  }
  function pieHTML(series,{mode='donut',filter='priority',label='구성 비율'}={}) {
    const total=series.reduce((n,item)=>n+item.value,0);if(!total)return empty('표시할 데이터가 없습니다.');
    let angle=-Math.PI/2;
    const slices=series.filter(item=>item.value).map(item=>{
      const start=angle;angle+=item.value/total*Math.PI*2;const tooltip=`${item.label} · ${number(item.value)}건 · ${(item.value/total*100).toFixed(1)}%`;
      const geometry=item.value===total?(mode==='donut'?`<circle cx="110" cy="110" r="73" fill="none" stroke="${item.color}" stroke-width="26"/>`:`<circle cx="110" cy="110" r="86" fill="${item.color}"/>`):`<path d="${slicePath(start,angle,mode==='donut'?60:0)}" fill="${item.color}" stroke="#fff" stroke-width="1.5"/>`;
      return `<g ${action(filter,item.label,tooltip)}>${geometry}<title>${esc(tooltip)}</title></g>`;
    }).join('');
    return `<div class="pie-layout"><div class="pie-visual interactive-chart"><svg viewBox="0 0 220 220" role="group" aria-label="${esc(label)}, 전체 ${number(total)}건">${slices}</svg>${mode==='donut'?`<div class="pie-center"><strong>${number(total)}</strong><span>전체 청구</span></div>`:''}<div class="chart-tooltip" role="tooltip" hidden></div></div><div class="pie-legend">${series.map(item=>`<button class="pie-legend-item" ${item.value?`data-chart-filter="${filter}" data-chart-value="${esc(JSON.stringify(item.label))}"`:'disabled'} aria-label="${esc(item.label)} ${item.value}건 보기"><i style="background:${item.color}"></i><span class="pie-label">${esc(item.label)}</span><span class="pie-value">${number(item.value)}<small>건</small></span><span class="pie-percent">${(item.value/total*100).toFixed(1)}%</span></button>`).join('')}</div></div><div class="plot-help">조각 또는 범례를 눌러 해당 청구를 볼 수 있습니다.</div>`;
  }
  function categoriesHTML(rows,mode='bar') {
    const series=categorySeries(rows);if(mode==='pie')return pieHTML(series,{mode:'pie',filter:'type',label:'보험 유형별 청구 비중'});
    if(!series.length)return empty('표시할 데이터가 없습니다.');
    const max=Math.max(...series.map(item=>item.value));
    return `<div class="category-bars">${series.map(item=>`<button class="category-bar" data-chart-filter="type" data-chart-value="${esc(JSON.stringify(item.label))}" aria-label="${esc(item.label)} ${item.value}건 보기"><span class="category-label">${esc(item.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${item.value/max*100}%;background:${item.color}"></span></span><span class="category-value">${number(item.value)}<small>${(item.value/rows.length*100).toFixed(1)}%</small></span></button>`).join('')}</div><div class="plot-help">막대를 눌러 선택한 보험 유형의 청구를 확인하세요.</div>`;
  }
  function rulesHTML(rows) {
    const series=ruleSeries(rows);if(!rows.length)return empty('현재 필터 조건에 맞는 청구가 없습니다.');
    return `<div class="rule-bars">${series.map(item=>`<button class="rule-bar" data-chart-filter="ruleFilter" data-chart-value="${esc(JSON.stringify(item.id))}" ${!item.value?'disabled':''}><span class="rule-bar-label">${esc(item.label)}</span><span class="rule-bar-value">${number(item.value)}건<small>${(item.value/rows.length*100).toFixed(1)}%</small></span><span class="bar-track"><span class="bar-fill" style="width:${item.value/rows.length*100}%"></span></span></button>`).join('')}</div><div class="plot-help">규칙은 중복 탐지될 수 있어 비율의 합은 100%를 넘을 수 있습니다.</div>${dataTable(['탐지 패턴','청구 건수','현재 데이터 대비'],series.map(item=>[item.label,number(item.value),(item.value/rows.length*100).toFixed(1)+'%']))}`;
  }
  function monthlyHTML(rows,metric='count') {
    const series=monthlySeries(rows);if(!series.length)return empty('표시할 데이터가 없습니다.');
    const isAmount=metric==='total',w=640,h=226,left=55,right=20,top=26,bottom=35,pw=w-left-right,ph=h-top-bottom,max=niceMaximum(Math.max(...series.map(item=>item[metric])));
    const coords=series.map((item,i)=>[left+(series.length===1?.5:i/(series.length-1))*pw,top+ph*(1-item[metric]/max)]),points=coords.map(p=>p.join(',')).join(' ');
    const stride=Math.max(1,Math.ceil(series.length/10)),multiYear=series[0].month.slice(0,4)!==series.at(-1).month.slice(0,4);
    return `<div class="chart interactive-chart"><svg viewBox="0 0 ${w} ${h}" role="group" aria-label="월별 ${isAmount?'청구 금액':'청구 건수'} 추이">${[0,.25,.5,.75,1].map(t=>`<line class="grid-line" x1="${left}" x2="${w-right}" y1="${top+ph*t}" y2="${top+ph*t}"/><text x="${left-10}" y="${top+ph*t+3}" text-anchor="end">${isAmount?amount(max*(1-t)):number(max*(1-t))}</text>`).join('')}<path class="area" d="M${coords[0][0]} ${top+ph} L${coords.map(p=>p.join(' ')).join(' L')} L${coords.at(-1)[0]} ${top+ph} Z"/><polyline class="line" points="${points}"/>${coords.map((p,i)=>{const item=series[i],tooltip=`${item.month} · ${number(item.count)}건 · ${number(item.total)}원`;return `<g ${item.count?action('month',item.month,tooltip):''}><circle class="point" cx="${p[0]}" cy="${p[1]}" r="3.5"/><circle cx="${p[0]}" cy="${p[1]}" r="11" fill="transparent"/><title>${esc(tooltip)}</title></g>${i%stride===0||i===series.length-1?`<text x="${p[0]}" y="${h-12}" text-anchor="middle">${multiYear?item.month.slice(2).replace('-','.'):Number(item.month.slice(5))+'월'}</text>`:''}`;}).join('')}<text x="${left}" y="13">${isAmount?'청구 금액 (원)':'청구 건수'}</text></svg><div class="chart-tooltip" role="tooltip" hidden></div></div>${dataTable(['청구 월','건수','청구 금액'],series.map(item=>[item.month,number(item.count),number(item.total)+'원']))}`;
  }
  function filterRows(rows,filters={}) {
    const query=(filters.search||'').toLowerCase();
    return rows.filter(row=>(!filters.type||filters.type==='all'||row.insurance_type===filters.type)
      &&(!filters.priority||filters.priority==='all'||row.priority===filters.priority)
      &&(!query||row.claim_id.toLowerCase().includes(query)||row.customer_id.toLowerCase().includes(query))
      &&(!filters.month||row.claim_date.startsWith(filters.month))
      &&inRange(row.amount,filters.amountRange)&&inRange(row.score,filters.scoreRange)
      &&(!filters.ruleFilter||row.rules.some(rule=>rule.id===filters.ruleFilter&&rule.hit)));
  }
  const api={colors,quantile,inRange,histogram,prioritySeries,categorySeries,ruleSeries,monthlySeries,filterRows,histogramHTML,pieHTML,categoriesHTML,rulesHTML,monthlyHTML,amount};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;root.LensCharts=api;
})(typeof window!=='undefined'?window:globalThis);
