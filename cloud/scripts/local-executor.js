'use strict';
// Outbound HTTPS polling only. The existing Zen extension and local forum API stay loopback-only.
const {fail,sleep}=require('../src/util');
function route(job) {
  const a=job.args||{},q=new URLSearchParams();for(const k of ['page','q','fresh'])if(a[k]!==undefined)q.set(k,String(a[k]));
  switch(job.operation){
    case 'sections':return {path:a.sectionId?'/api/forum/'+Number(a.sectionId):'/api/index'};
    case 'thread':if(!/^\d+$/.test(String(a.id)))fail(422,'JOB','Invalid thread ID');return {path:`/api/thread/${a.id}?${q}`};
    case 'search':return {path:'/api/search?'+q};
    case 'latest':return {path:'/api/latest?'+q};
    case 'prepare':return {path:'/api/reply/preview',body:{threadId:String(a.threadId),message:a.message,format:'bbcode'}};
    case 'confirm':if(a.confirm!==true)fail(422,'JOB','Missing confirmation');return {path:'/api/reply',body:{previewId:a.previewId,confirm:true}};
    case 'reply_status':return {path:'/api/reply/status/'+encodeURIComponent(a.previewId)};
    default:fail(422,'JOB','Operation is not allowlisted');
  }
}
async function main(env=process.env){
  const cloud=new URL(env.CLOUD_URL||''),local=new URL(env.LOCAL_FORUM_URL||'http://127.0.0.1:8787'),controller=new AbortController();
  if(cloud.protocol!=='https:'||cloud.username||cloud.password||cloud.pathname!=='/'||cloud.search||cloud.hash||!env.EXECUTOR_TOKEN)fail(500,'CONFIG','Set HTTPS CLOUD_URL and EXECUTOR_TOKEN');
  if(local.protocol!=='http:'||local.hostname!=='127.0.0.1'||local.username||local.password||local.pathname!=='/')fail(500,'CONFIG','Local API must be http://127.0.0.1:PORT');
  for(const s of ['SIGTERM','SIGINT'])process.once(s,()=>controller.abort());
  const remote=async(path,body)=>{const r=await fetch(new URL(path,cloud),{method:'POST',headers:{authorization:'Bearer '+env.EXECUTOR_TOKEN,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});if(!r.ok)fail(502,'CLOUD_REQUEST','Cloud rejected executor request');return r.json();};
  let failures=0;
  while(!controller.signal.aborted){
    try{const job=(await remote('/api/executor/claim',{})).data;if(!job){failures=0;await sleep(2000,controller.signal);continue;}
      let result;
      try{
        if(job.expiresAt<=Date.now())fail(410,'JOB_EXPIRED','Job expired');const target=route(job);
        const response=await fetch(new URL(target.path,local),{method:target.body?'POST':'GET',headers:{...(env.LOCAL_FORUM_TOKEN?{'x-api-token':env.LOCAL_FORUM_TOKEN}:{}),...(target.body?{'content-type':'application/json'}:{})},body:target.body?JSON.stringify(target.body):undefined,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,Math.min(100000,job.expiresAt-Date.now())))])});
        const raw=await response.text();if(Buffer.byteLength(raw)>1048576)fail(413,'LOCAL_SIZE','Local result too large');const data=JSON.parse(raw);
        result=response.ok?{data}:{status:response.status,error:{code:data.code||'LOCAL_ERROR',message:'Local API rejected the operation'}};
      }catch(e){result={status:e.status||502,error:{code:e.code||'LOCAL_UNCERTAIN',message:'Local operation failed; do not repeat a publication'}};}
      // Retry delivery of this same result, never execution of the job.
      for(let delivery=0;delivery<3;delivery++){try{await remote('/api/executor/result',{id:job.id,claim:job.claim,result});break;}catch{if(delivery===2)throw Error('Result delivery failed');await sleep(1000,controller.signal);}}
      failures=0;
    }catch{if(controller.signal.aborted)break;failures++;console.error(JSON.stringify({event:'executor_connection_failed',attempt:failures}));await sleep(Math.min(30000,1000*2**Math.min(failures,5)),controller.signal).catch(()=>{});}
  }
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({event:'executor_failed',code:e.code||'ERROR'}));process.exitCode=1;});
module.exports={route,main};
