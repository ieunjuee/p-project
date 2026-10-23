import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {explainClaim} from './llm.mjs';
import {explainPerson,assistPerson} from './person-llm.mjs';
import engine from './dist/engine.js';
import personEngine from './dist/person-engine.js';

const folder=path.dirname(fileURLToPath(import.meta.url));
try{process.loadEnvFile(path.join(folder,'.env'));}catch(error){if(error.code!=='ENOENT')console.warn('.env 파일을 확인하세요.');}
const root=path.join(folder,'dist'),port=Number(process.env.PORT||4177);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.wasm':'application/wasm','.db':'application/octet-stream'};
function send(res,status,body,type='application/json; charset=utf-8'){res.writeHead(status,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(Buffer.isBuffer(body)?body:typeof body==='object'?JSON.stringify(body):body);}
const server=http.createServer(async(req,res)=>{
  try{
    const base=`http://localhost:${port}`,url=new URL(req.url,base);
    if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`){send(res,403,{error:'다른 출처의 요청은 허용하지 않습니다.'});return;}
    if(url.pathname==='/api/status'&&req.method==='GET'){send(res,200,{connected:!!process.env.OPENAI_API_KEY,personLlm:{mode:process.env.LLM_MODE==='demo'?'demo':'local',model:process.env.LLM_MODEL||'qwen3:14b',baseUrl:process.env.LLM_BASE_URL||'http://localhost:11434/v1'}});return;}
    if(url.pathname==='/runtime.js'&&req.method==='GET'){send(res,200,'window.INSURELENS_SERVER = true;','text/javascript; charset=utf-8');return;}
    if(url.pathname==='/api/explain'&&req.method==='POST'){
      if(!req.headers['content-type']?.startsWith('application/json')){send(res,415,{error:'JSON 요청이 필요합니다.'});return;}
      let body='';for await(const chunk of req){body+=chunk;if(body.length>32000){send(res,413,{error:'요청이 너무 큽니다.'});return;}}
      const input=JSON.parse(body);let result;
      try{result=await explainClaim(input.evidence,input.question||'');}
      catch(error){if(/형식|수치|범위|근거|질문|점수/.test(error.message)){send(res,400,{error:error.message});return;}result={...engine.demoExplain(input.evidence,input.question||''),reason:'API 연결 실패'};}
      send(res,200,result);return;
    }
    if(url.pathname==='/api/explain-person'&&req.method==='POST'){
      if(!req.headers['content-type']?.startsWith('application/json')){send(res,415,{error:'JSON 요청이 필요합니다.'});return;}
      let body='';for await(const chunk of req){body+=chunk;if(body.length>64000){send(res,413,{error:'요청이 너무 큽니다.'});return;}}
      const input=JSON.parse(body);let result;
      try{result=await explainPerson(input.evidence);}
      catch(error){if(/형식|수치|범위|근거|지표|위험도|점수|크기/.test(error.message)){send(res,400,{error:error.message});return;}result={...personEngine.demoExplain(input.evidence),reason:'API 연결 실패'};}
      send(res,200,result);return;
    }
    if(url.pathname==='/api/person-assist'&&req.method==='POST'){
      if(!req.headers['content-type']?.startsWith('application/json')){send(res,415,{error:'JSON 요청이 필요합니다.'});return;}
      let body='';for await(const chunk of req){body+=chunk;if(body.length>64000){send(res,413,{error:'요청이 너무 큽니다.'});return;}}
      const input=JSON.parse(body);let result;
      try{result=await assistPerson(input.kind,input.evidence,input.question);}
      catch(error){if(/형식|수치|범위|근거|지표|위험도|점수|크기|종류/.test(error.message)){send(res,400,{error:error.message});return;}result={...personEngine['demo'+({ask:'Ask',request:'Request',gap:'Gap'}[input.kind]||'Explain')](input.evidence,input.question||''),reason:'API 연결 실패'};}
      send(res,200,result);return;
    }
    if(req.method!=='GET'&&req.method!=='HEAD'){send(res,405,{error:'허용하지 않는 요청입니다.'});return;}
    const filename=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!filename.startsWith(root+path.sep)){send(res,403,{error:'허용하지 않는 경로입니다.'});return;}
    const content=await readFile(filename);send(res,200,req.method==='HEAD'?'':content,mime[path.extname(filename)]||'application/octet-stream');
  }catch(error){send(res,error.code==='ENOENT'?404:400,{error:error.code==='ENOENT'?'페이지를 찾을 수 없습니다.':'요청을 처리할 수 없습니다.'});}
});
server.listen(port,'127.0.0.1',()=>console.log(`InsureLens: http://localhost:${port}\n사람 화면 LLM: ${process.env.LLM_MODE==='demo'?'데모 설명(LLM_MODE=demo)':`로컬 ${process.env.LLM_MODEL||'qwen3:14b'} @ ${process.env.LLM_BASE_URL||'http://localhost:11434/v1'} (연결 실패 시 데모 설명)`}\n청구 단위 화면 LLM: ${process.env.OPENAI_API_KEY?'API connected':'Demo explanations (no API key)'}\nStop: Ctrl+C`));
