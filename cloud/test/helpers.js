'use strict';
const {loadConfig}=require('../src/config');
const {Store}=require('../src/store');
function config(extra={}){return {...loadConfig({SCHEDULER_ENABLED:'0',DISCORD_GUILD_IDS:'',API_READ_TOKEN:'r'.repeat(40),API_WRITE_TOKEN:'w'.repeat(40),EXECUTOR_TOKEN:'e'.repeat(40)}),sources:[],...extra};}
function memory(extra={}){const cfg=config(extra),store=new Store(cfg,':memory:');return {cfg,store};}
const doc=(extra={})=>({id:'docossum:houston:1',sourceId:'laws-houston',title:'Уголовный кодекс',category:'criminal_code',server:'houston',organization:'DOJ',source:'docossum',url:'https://docossum.com/legal/houston/document/1',body:'Преамбула закона\nСтатья 1.1. Право\nПервоначальная формулировка.\nСтатья 2. Гарантии\nТекст гарантии.',sourceVersion:'remote-1',...extra});
async function dispatch(app,{method='GET',url='/health',body,headers={},raw}={}){
  const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
  const value=raw===undefined?(body===undefined?'':JSON.stringify(body)):raw;
  const req=Readable.from(value?[Buffer.from(value)]:[]);Object.assign(req,{method,url,headers:{host:new URL(app.cfg.publicUrl).host,...(body!==undefined?{'content-type':'application/json'}:{}),...headers},socket:{remoteAddress:'127.0.0.1'}});
  const res=new EventEmitter();res.headers={};res.setHeader=(k,v)=>res.headers[k.toLowerCase()]=v;res.writeHead=(status,h={})=>{res.status=status;res.headersSent=true;for(const[k,v]of Object.entries(h))res.setHeader(k,v);};
  const result=new Promise((resolve,reject)=>{res.end=value=>{res.writableEnded=true;res.body=Buffer.isBuffer(value)?value.toString():String(value||'');resolve({status:res.status||200,headers:res.headers,body:res.body,json:()=>JSON.parse(res.body)});};setTimeout(()=>reject(Error('Handler did not finish')),2000).unref();});
  app.handler(req,res);return result;
}
module.exports={config,memory,doc,dispatch};
