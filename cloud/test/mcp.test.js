'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');const{memory,doc}=require('./helpers');const{createApp}=require('../src/server');
let available=false;try{require.resolve('@modelcontextprotocol/server');require.resolve('zod/v4');available=true;}catch{}
test('official SDK v2: Streamable HTTP initialize, tools/list and tools/call in process',{skip:available?false:'npm registry unavailable in this environment; install dependencies with npm ci'},async()=>{
  const{createMcpHandler}=require('@modelcontextprotocol/server'),{createMcp}=require('../src/mcp'),{cfg,store}=memory();
  const app=createApp({cfg,store,httpClient:{close(){}},relay:{online:()=>false,close(){}}});store.upsertDocument(doc());
  const principal={id:'test',scopes:['read']},handler=createMcpHandler(()=>createMcp(app.service,principal),{responseMode:'json'});
  const rpc=async(method,params={},id=1)=>{const response=await handler.fetch(new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})}));assert.equal(response.status,200);return response.json();};
  try{const init=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.ok(init.result.serverInfo);const list=await rpc('tools/list');assert.ok(list.result.tools.some(x=>x.name==='knowledge_search'));assert.ok(!list.result.tools.some(x=>x.name==='forum_confirm_reply'));const result=await rpc('tools/call',{name:'knowledge_search',arguments:{article:'1.1',server:'houston'}});assert.equal(result.result.structuredContent.data.items[0].article,'1.1');const invalid=await rpc('tools/call',{name:'knowledge_read',arguments:{id:'missing'}});assert.equal(invalid.result.isError,true);}finally{await handler.close();await app.close();}
});
