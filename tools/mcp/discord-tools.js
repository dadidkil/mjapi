'use strict';
const fs=require('node:fs'),path=require('node:path');
const {tools:definitions}=require('../../cloud/src/tools');
const {ROUTES}=require('../../cloud/src/server');
const tools=definitions.filter(d=>d.name.startsWith('discord_')).map(({permission,_meta,...d})=>({...d,annotations:{...d.annotations,destructiveHint:false}}));
function configuration(){
  const file=path.resolve(__dirname,'../../.env');if(fs.existsSync(file))process.loadEnvFile(file);
  return {origin:process.env.CLOUD_URL||process.env.PUBLIC_URL||'http://127.0.0.1:15377',readToken:process.env.API_READ_TOKEN,writeToken:process.env.API_WRITE_TOKEN};
}
async function proxy(name,args,cfg,request=fetch){
  const def=definitions.find(d=>d.name===name&&d.name.startsWith('discord_'));if(!def)throw Error('Unknown Discord tool');
  const route=ROUTES.find(r=>r[2]===name);if(!route)throw Error('Discord route is not configured');
  const origin=new URL(cfg.origin);if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&origin.hostname==='127.0.0.1')))throw Error('CLOUD_URL must be HTTPS or local http://127.0.0.1:15377');
  const credential=def.permission==='read'?cfg.readToken:cfg.writeToken;if(!credential)throw Error('Set API_READ_TOKEN / API_WRITE_TOKEN in the Workspace .env');
  const remaining={...args},pathname=route[1].replace(/:([A-Za-z]+)/g,(_,key)=>{delete remaining[key];return encodeURIComponent(args[key]);}),url=new URL(pathname,origin);
  if(route[0]==='GET')for(const[k,v]of Object.entries(remaining))url.searchParams.set(k,String(v));
  const response=await request(url,{method:route[0],headers:{authorization:'Bearer '+credential,...(route[0]==='POST'?{'content-type':'application/json'}:{})},body:route[0]==='POST'?JSON.stringify(args):undefined,redirect:'error',signal:AbortSignal.timeout(20000)});
  const body=await response.text();if(Buffer.byteLength(body)>1048576)throw Error('Discord response too large; reduce page size');
  let result;try{result=JSON.parse(body);}catch{throw Error('Workspace returned an invalid response');}
  if(!response.ok||!result.ok)throw Object.assign(Error(result.error?.code||'DISCORD_WORKSPACE_ERROR'),{code:result.error?.code||'DISCORD_WORKSPACE_ERROR'});
  return result.data;
}
async function handle(name,args){return proxy(name,args,configuration());}
module.exports={tools,handle,proxy,configuration};
