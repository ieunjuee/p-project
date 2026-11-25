(function (root) {
  'use strict';
  const DAY = 86400000;
  const defaults = Object.freeze({windowDays:30,repeatCount:4,amountRatio:2.5,hospitalCount:3,shortGap:2,minPeers:15,ruleWeight:0.6,high:70,medium:40,contamination:0.08,seed:42});
  const columns = ['claim_id','customer_id','claim_date','amount','insurance_type','hospital_id','treatment_type'];
  const median = a => { const b=a.filter(Number.isFinite).sort((x,y)=>x-y); return b.length ? (b[Math.floor((b.length-1)/2)]+b[Math.floor(b.length/2)])/2 : null; };
  const rng = seed => () => {let t=seed+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};
  const money = n => Math.round(n).toLocaleString('ko-KR')+'원';
  function sample(n=2000,seed=42) {
    const random=rng(seed), types=['외래','검사','입원','수술'], base=[90000,230000,850000,2100000],rows=[],labels={};
    for(let i=0;i<n;i++) {
      const p=random(),t=p<.55?0:p<.8?1:p<.95?2:3;
      const z=Math.sqrt(-2*Math.log(Math.max(random(),1e-9)))*Math.cos(2*Math.PI*random());
      let amount=Math.max(1000,Math.round(base[t]*Math.exp(.35*z)/1000)*1000);
      let day=Math.floor(random()*365),customer='C'+String(Math.floor(random()*Math.max(100,n/5))).padStart(4,'0');
      let hospital='H'+String(1+Math.floor(random()*30)).padStart(3,'0'),pattern='일반';
      if(i%50<5) {customer='R'+Math.floor(i/50);day=25+(Math.floor(i/50)*7)%325+i%50;hospital='H'+String(10+i%50);pattern='반복·다기관';}
      if(i%37===3) {amount*=4;pattern=pattern==='일반'?'고액':'복합';}
      if(i%101===8) {amount*=5;pattern='특이 정상';}
      const id='CL'+String(i+1).padStart(6,'0');
      rows.push({claim_id:id,customer_id:customer,claim_date:new Date(Date.UTC(2025,0,1)+day*DAY).toISOString().slice(0,10),amount,insurance_type:['실손','건강','상해'][Math.floor(random()*3)],hospital_id:hospital,treatment_type:types[t]});
      labels[id]={pattern,anomaly:!['일반','특이 정상'].includes(pattern)};
    }
    return {rows,labels};
  }
  function parseCSV(text) {
    const rows=[];let row=[],field='',quoted=false;
    text=text.replace(/^\uFEFF/,'');
    for(let i=0;i<text.length;i++) {
      const ch=text[i];
      if(ch==='"') {if(quoted&&text[i+1]==='"'){field+='"';i++;}else if(quoted||field==='')quoted=!quoted;else throw Error('따옴표 형식을 확인하세요.');}
      else if(ch===','&&!quoted){row.push(field);field='';}
      else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field='';}
      else field+=ch;
    }
    if(quoted)throw Error('닫히지 않은 따옴표가 있습니다.');
    row.push(field);if(row.some(x=>x.trim()))rows.push(row);
    if(!rows.length)throw Error('CSV 파일이 비어 있습니다.');
    const headers=rows.shift().map(x=>x.trim());
    if(new Set(headers).size!==headers.length)throw Error('중복된 열 이름이 있습니다.');
    const missing=columns.filter(x=>!headers.includes(x));if(missing.length)throw Error('필수 열이 없습니다: '+missing.join(', '));
    return rows.map((values,i)=>({...Object.fromEntries(headers.map((h,j)=>[h,values[j]??''])),_row:i+2,_malformed:values.length!==headers.length}));
  }
  function preprocess(raw) {
    const clean=[],rejected=[],seen=new Set();
    raw.forEach((r,i)=>{
      const row=Object.fromEntries(columns.map(k=>[k,String(r[k]??'').trim()]));const errors=[];
      if(columns.some(k=>!row[k]))errors.push('필수값 누락');
      if(r._malformed)errors.push('열 개수 불일치');
      if(columns.some(k=>row[k].length>120))errors.push('필드 길이 초과');
      const time=Date.parse(row.claim_date+'T00:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(row.claim_date)||!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==row.claim_date)errors.push('날짜 형식 오류 (YYYY-MM-DD)');
      row.amount=Number(row.amount);
      if(!Number.isFinite(row.amount)||row.amount<=0)errors.push('금액은 유한한 양수여야 함');
      if(seen.has(row.claim_id))errors.push('중복 청구 ID');
      if(!errors.length){seen.add(row.claim_id);clean.push({...row,time});}
      else rejected.push({row:r._row??i+2,claim_id:row.claim_id,reason:errors.join(' · ')});
    });
    clean.sort((a,b)=>a.time-b.time||a.claim_id.localeCompare(b.claim_id));
    return {raw,clean,rejected,inputCount:raw.length};
  }
  function insert(a,x) {let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m]<x)lo=m+1;else hi=m;}a.splice(lo,0,x);}
  function features(rows,cfg) {
    const histories=new Map(),peers=new Map(),result=[];
    for(let start=0;start<rows.length;) {
      let end=start+1;while(end<rows.length&&rows[end].time===rows[start].time)end++;
      for(let i=start;i<end;i++) {
        const r=rows[i],hist=histories.get(r.customer_id)||[],prior=hist.filter(x=>(r.time-x.time)/DAY<=cfg.windowDays),compare=peers.get(r.treatment_type)||[];
        const peerMedian=compare.length>=cfg.minPeers?(compare[Math.floor((compare.length-1)/2)]+compare[Math.floor(compare.length/2)])/2:null;
        result.push({...r,recentCount:prior.length+1,recentHospitals:new Set([...prior.map(x=>x.hospital_id),r.hospital_id]).size,gapDays:hist.length?(r.time-hist[hist.length-1].time)/DAY:null,priorClaims:hist.length,peerCount:compare.length,peerMedian,amountRatio:peerMedian?r.amount/peerMedian:null});
      }
      for(let i=start;i<end;i++){const r=rows[i];if(!histories.has(r.customer_id))histories.set(r.customer_id,[]);histories.get(r.customer_id).push(r);if(!peers.has(r.treatment_type))peers.set(r.treatment_type,[]);insert(peers.get(r.treatment_type),r.amount);}
      start=end;
    }
    return result;
  }
  const c = n => {if(n<=1)return 0;let h=0;for(let i=1;i<n;i++)h+=1/i;return 2*h-2*(n-1)/n;};
  class IsolationForest {
    constructor(seed=42,trees=48,size=128){this.random=rng(seed);this.count=trees;this.maxSize=size;}
    build(data,depth,maxDepth){if(data.length<=1||depth>=maxDepth)return {size:data.length};const dims=[];for(let j=0;j<data[0].length;j++){const values=data.map(x=>x[j]);const min=Math.min(...values),max=Math.max(...values);if(max>min)dims.push({j,min,max});}if(!dims.length)return {size:data.length};const d=dims[Math.floor(this.random()*dims.length)],split=d.min+this.random()*(d.max-d.min);return {feature:d.j,split,left:this.build(data.filter(x=>x[d.j]<split),depth+1,maxDepth),right:this.build(data.filter(x=>x[d.j]>=split),depth+1,maxDepth)};}
    fit(data){this.size=Math.min(this.maxSize,data.length);this.trees=[];for(let i=0;i<this.count;i++){const copy=data.slice();for(let j=copy.length-1;j>0;j--){const k=Math.floor(this.random()*(j+1));[copy[j],copy[k]]=[copy[k],copy[j]];}this.trees.push(this.build(copy.slice(0,this.size),0,Math.ceil(Math.log2(this.size))));}return this;}
    path(row,node,depth=0){return 'size' in node?depth+c(node.size):this.path(row,row[node.feature]<node.split?node.left:node.right,depth+1);}
    score(row){return 2**(-this.trees.reduce((s,t)=>s+this.path(row,t),0)/this.count/c(this.size));}
  }
  const numeric=r=>[r.amount,r.recentCount,r.recentHospitals,r.gapDays,r.amountRatio,r.priorClaims];
  function ruleResults(r,cfg){const rule=(id,name,observed,threshold,hit,available=true)=>({id,name,observed,threshold,hit:!!hit,available});const rules=[rule('repeat','반복 청구',r.recentCount,cfg.repeatCount,r.recentCount>=cfg.repeatCount),rule('amount','동일 진료 대비 고액',r.amountRatio,cfg.amountRatio,r.amountRatio!==null&&r.amountRatio>=cfg.amountRatio,r.amountRatio!==null),rule('hospital','여러 의료기관 이용',r.recentHospitals,cfg.hospitalCount,r.recentHospitals>=cfg.hospitalCount),rule('gap','짧은 청구 간격',r.gapDays,cfg.shortGap,r.gapDays!==null&&r.gapDays<=cfg.shortGap,r.gapDays!==null)];const hits=rules.filter(x=>x.hit).length;rules.push(rule('combined','복수 이상징후',hits,2,hits>=2));return rules;}
  function validateConfig(cfg){if(!(cfg.windowDays>0&&cfg.repeatCount>=2&&cfg.amountRatio>1&&cfg.hospitalCount>=2&&cfg.minPeers>=1&&cfg.ruleWeight>=0&&cfg.ruleWeight<=1&&cfg.high>cfg.medium&&cfg.high<=100&&cfg.medium>=0&&cfg.contamination>0&&cfg.contamination<.5))throw Error('분석 기준을 확인하세요.');}
  function analyze(raw,settings={}) {
    const cfg={...defaults,...settings};validateConfig(cfg);const quality=preprocess(raw);
    if(!quality.clean.length)throw Object.assign(Error('분석 가능한 청구가 없습니다. 날짜·금액·필수 열을 확인하세요.'),{quality});
    const rows=features(quality.clean,cfg),cutoff=rows[Math.floor(rows.length*.7)]?.time,train=rows.filter(x=>x.time<cutoff),canFit=train.length>=20;
    let model=null,calibration=[],fill=[],threshold=null;
    if(canFit){fill=numeric(train[0]).map((_,i)=>median(train.map(x=>numeric(x)[i]))??0);const trainX=train.map(r=>numeric(r).map((x,i)=>x===null?fill[i]:x));model=new IsolationForest(cfg.seed).fit(trainX);calibration=trainX.map(r=>model.score(r)).sort((a,b)=>a-b);threshold=calibration[Math.min(calibration.length-1,Math.floor((1-cfg.contamination)*calibration.length))];}
    const results=rows.map(r=>{
      const rules=ruleResults(r,cfg),ruleScore=rules.filter(x=>x.hit).length/5*100;
      const rawScore=model?model.score(numeric(r).map((x,i)=>x===null?fill[i]:x)):null;
      let lower=0,upper=0;
      while(lower<calibration.length&&calibration[lower]<rawScore)lower++;
      upper=lower;while(upper<calibration.length&&calibration[upper]===rawScore)upper++;
      const degenerate=calibration[0]===calibration.at(-1);
      const mlScore=model?(degenerate?0:(lower+upper)/2/calibration.length*100):null;
      const score=Math.round((model?ruleScore*cfg.ruleWeight+mlScore*(1-cfg.ruleWeight):ruleScore)*10)/10;
      return {...r,rules,ruleScore,mlRaw:rawScore,mlScore,mlFlag:model?!degenerate&&rawScore>threshold:false,score,priority:score>=cfg.high?'높음':score>=cfg.medium?'보통':'낮음',partition:model?(r.time<cutoff?'학습':'평가'):'규칙만',reasons:rules.filter(x=>x.hit).map(x=>x.name)};
    });
    return {results,quality,config:cfg,modelInfo:{enabled:canFit,trainCount:canFit?train.length:0,testCount:canFit?rows.length-train.length:0,cutoff:canFit?new Date(cutoff).toISOString().slice(0,10):null,trees:48,seed:cfg.seed},summary:summarize(results)};
  }
  function summarize(rows){const monthly={},types={};for(const r of rows){const month=r.claim_date.slice(0,7);monthly[month]=(monthly[month]||0)+1;types[r.insurance_type]=(types[r.insurance_type]||0)+1;}return {count:rows.length,total:rows.reduce((a,r)=>a+r.amount,0),high:rows.filter(r=>r.priority==='높음').length,medium:rows.filter(r=>r.priority==='보통').length,low:rows.filter(r=>r.priority==='낮음').length,ruleHits:rows.filter(r=>r.reasons.length).length,monthly,types};}
  function evidence(row,analysis){return {claim_id:row.claim_id,claim_date:row.claim_date,amount:row.amount,treatment_type:row.treatment_type,insurance_type:row.insurance_type,score:row.score,priority:row.priority,rule_score:row.ruleScore,ml_score:row.mlScore,model_partition:row.partition,features:{recent_count:row.recentCount,recent_hospitals:row.recentHospitals,gap_days:row.gapDays,prior_claims:row.priorClaims,peer_count:row.peerCount,peer_median:row.peerMedian,amount_ratio:row.amountRatio},rules:row.rules,config:analysis.config,model:analysis.modelInfo,limitations:['점수는 검토 우선순위이며 사기 확률이 아닙니다.','모델 점수에 대한 개별 특징의 인과적 기여도는 계산하지 않았습니다.','기준과 가중치는 실험 설정입니다.']};}
  function demoExplain(e,question=''){const hits=e.rules.filter(x=>x.hit),basis=hits.length?hits.map(x=>`${x.name}: 관측 ${x.observed===null?'없음':Number(x.observed.toFixed(2))} / 기준 ${x.id==='gap'?'이하':'이상'} ${x.threshold}`):['설정된 규칙에서 탐지된 이상징후가 없습니다.'];basis.push(e.features.peer_median?`동일 진료의 이전 ${e.features.peer_count}건 중앙값 ${money(e.features.peer_median)} 대비 ${e.features.amount_ratio.toFixed(2)}배입니다.`:`동일 진료의 이전 표본 ${e.features.peer_count}건으로 비교 근거가 충분하지 않습니다.`);const result={provider:'demo',summary:`청구 ${e.claim_id}의 검토 우선순위는 ${e.priority}, 점수는 ${e.score.toFixed(1)}/100입니다. ${hits.length?hits.map(x=>x.name).join(', ')+' 패턴을 확인했습니다.':'현재 설정에서 뚜렷한 규칙 패턴은 없습니다.'}`,basis,checks:['청구 서류와 실제 진료 내역의 일치 여부를 확인하세요.','반복 진료 또는 기관 변경의 사유를 확인하세요.','담당자가 근거와 업무 맥락을 함께 검토하세요.'],answer:null};if(question){if(/금액|중앙|비교/.test(question))result.answer=`청구 금액은 ${money(e.amount)}입니다. ${basis[basis.length-1]}`;else if(/점수|모델|우선/.test(question))result.answer=`규칙 점수 ${e.rule_score.toFixed(1)}, 모델 특이도 ${e.ml_score===null?'미산출':e.ml_score.toFixed(1)}를 설정된 가중치로 결합했습니다. 사기 확률로 해석할 수 없습니다.`;else if(/왜|이유|근거/.test(question))result.answer=basis.join(' ');else if(/사기|확정|거절/.test(question))result.answer='제공된 분석만으로 보험사기 여부나 지급 결정을 확정할 수 없습니다. 담당자의 추가 확인이 필요합니다.';else result.answer='현재 검증된 근거는 다음과 같습니다. '+basis.join(' ');}return result;}
  function evaluate(analysis,labels){const test=analysis.results.filter(r=>r.partition==='평가'&&labels[r.claim_id]);if(!test.length)return [];return ['rule','ml','combined'].map(name=>{let tp=0,fp=0,fn=0,tn=0;for(const r of test){const pred=name==='rule'?r.reasons.length>0:name==='ml'?r.mlFlag:r.priority==='높음',actual=labels[r.claim_id].anomaly;if(pred&&actual)tp++;else if(pred)fp++;else if(actual)fn++;else tn++;}const precision=tp/(tp+fp)||0,recall=tp/(tp+fn)||0;return {name,n:test.length,tp,fp,fn,tn,precision,recall,f1:precision+recall?2*precision*recall/(precision+recall):0};});}
  function csv(rows,fields=columns){const quote=x=>{let value=String(x??'');if(typeof x==='string'&&/^[\s]*[=+@-]/.test(value))value="'"+value;return '"'+value.replace(/"/g,'""')+'"';};return '\uFEFF'+[fields,...rows.map(r=>fields.map(f=>r[f]))].map(r=>r.map(quote).join(',')).join('\r\n');}
  const api={defaults,columns,sample,parseCSV,preprocess,features,analyze,evidence,demoExplain,evaluate,csv,IsolationForest,median,money};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;root.InsureLens=api;
})(typeof window!=='undefined'?window:globalThis);
