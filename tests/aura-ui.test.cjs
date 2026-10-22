const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
test('AURA offline hosting shows connection setup without fabricated statistics',async()=>{
 const dom=new JSDOM(fs.readFileSync('dist/index.html','utf8'),{url:'https://example.test/',runScripts:'outside-only'});
 dom.window.fetch=async()=>{throw Error('offline');};
 dom.window.eval(fs.readFileSync('dist/aura.js','utf8'));
 await new Promise(r=>setTimeout(r,20));
 assert.match(dom.window.document.querySelector('main').textContent,/백엔드 주소/);
 assert.equal(dom.window.document.querySelectorAll('.metric').length,0);
 dom.window.close();
});
test('AURA control center renders API counts and escapes review data',async()=>{
 const dom=new JSDOM(fs.readFileSync('dist/index.html','utf8'),{url:'https://example.test/',runScripts:'outside-only'});
 const responses={'/api/health':{dataset:{people:500},llm_configured:false,spec_note:'실험용'},'/api/control':{total:12,closed_auto:8,needs_review:4,automation_rate:2/3,running:0,errors:0,safety_blocks:0,average_ms:3},'/api/investigations?queue=true':[{person_id:'<script>bad</script>',route:'detailed_review',scores:{S_overall:80},reasons:['check'],status:'needs_review'}]};
 dom.window.fetch=async path=>({ok:true,json:async()=>responses[path]});
 dom.window.eval(fs.readFileSync('dist/aura.js','utf8'));
 await new Promise(r=>setTimeout(r,20));
 assert.equal(dom.window.document.querySelector('.number').textContent,'12');
 assert.match(dom.window.document.querySelector('#connection').textContent,/규칙/);
 assert.equal(dom.window.document.querySelectorAll('main script').length,0);
 dom.window.close();
});

test('deployed API address is used and connection settings remain accessible',async()=>{
 const dom=new JSDOM(fs.readFileSync('dist/index.html','utf8'),{url:'https://example.test/',runScripts:'outside-only'});
 const seen=[];
 dom.window.AURA_CONFIG={apiBase:'https://api.example.test'};
 dom.window.fetch=async path=>{seen.push(path);return {ok:true,json:async()=>path.endsWith('/api/health')?{dataset:null,llm_configured:false}:path.includes('/api/investigations')?[]:{total:0,closed_auto:0,needs_review:0,running:0,errors:0,safety_blocks:0}};};
 dom.window.eval(fs.readFileSync('dist/aura.js','utf8'));
 await new Promise(r=>setTimeout(r,20));
 assert.ok(seen.includes('https://api.example.test/api/health'));
 dom.window.document.querySelector('#connection-settings').click();
 assert.equal(dom.window.document.querySelector('#api-base').value,'https://api.example.test');
 assert.ok(dom.window.document.querySelector('#admin-token'));
 dom.window.close();
});
