'use strict';
const http=require('node:http');
const {loadConfig}=require('./config');
const {Store}=require('./store');
const {HttpClient}=require('./http-client');
const {Relay}=require('./relay');
const {Forum}=require('./forum');
const {Discord}=require('./discord');
const {DiscordBridge}=require('./discord-bridge');
const {Knowledge}=require('./knowledge');
const {Scheduler}=require('./scheduler');
const {Auth}=require('./auth');
const {ToolService,tools}=require('./tools');
const {fail,safeError}=require('./util');
const ROUTES=[
 ['GET','/api/status','system_status'],['GET','/api/forum/sections','forum_sections'],['GET','/api/forum/search','forum_search'],['GET','/api/forum/threads/:id','forum_read_thread'],['GET','/api/forum/latest','forum_latest'],
 ['POST','/api/forum/reply/prepare','forum_prepare_reply'],['POST','/api/forum/reply/confirm','forum_confirm_reply'],['GET','/api/forum/reply/:confirmationId/status','forum_reply_status'],
 ['GET','/api/discord/guilds','discord_guilds'],['GET','/api/discord/guilds/:guildId/structure','discord_structure'],['GET','/api/discord/guilds/:guildId/roles','discord_roles'],['GET','/api/discord/guilds/:guildId/channels/:channelId/messages','discord_information'],['GET','/api/discord/changes','discord_changes'],
 ['POST','/api/discord/export','discord_export'],['GET','/api/discord/exports/:guildId','discord_export_status'],['GET','/api/discord/search','discord_search'],['GET','/api/discord/guilds/:guildId/channels/:channelId/messages/:messageId/history','discord_message_history'],
 ['GET','/api/knowledge/search','knowledge_search'],['GET','/api/knowledge/documents/:id/history','knowledge_history'],['GET','/api/knowledge/documents/:id','knowledge_read'],['GET','/api/knowledge/changes','knowledge_changes'],['GET','/api/sync/status','sync_status'],['POST','/api/sync/run','sync_now']
];
function json(res,status,value,limit=1048576){if(res.destroyed||res.writableEnded)return;const body=JSON.stringify(value);if(Buffer.byteLength(body)>limit)fail(413,'RESPONSE_SIZE','Response too large; reduce page size');res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);}
async function readBody(req,max){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>max)fail(413,'REQUEST_SIZE','Request body exceeds limit');parts.push(part);}return Buffer.concat(parts).toString('utf8');}
function openapi(cfg){const paths={};
  for(const [method,pattern,name]of ROUTES){const def=tools.find(t=>t.name===name),path=pattern.replace(/:([A-Za-z]+)/g,'{$1}');const operation={operationId:name,summary:def.description,security:[{BearerAuth:[]}],responses:{200:{description:'Structured result',content:{'application/json':{schema:{type:'object',properties:{ok:{type:'boolean'},data:{type:'object',additionalProperties:true}}}}}},401:{description:'Authentication required'},403:{description:'Scope denied'},422:{description:'Invalid input'},429:{description:'Rate limit'},503:{description:'Source or local executor unavailable'}}};
    if(method==='GET')operation.parameters=Object.entries(def.inputSchema.properties).map(([key,schema])=>({name:key,in:pattern.includes(':'+key)?'path':'query',required:pattern.includes(':'+key)||def.inputSchema.required.includes(key),description:schema.description,schema}));
    else operation.requestBody={required:true,content:{'application/json':{schema:def.inputSchema}}};
    if(name==='forum_confirm_reply')operation['x-openai-isConsequential']=true;
    (paths[path]||={})[method.toLowerCase()]=operation;
  }
  paths['/health']={get:{operationId:'health',summary:'Process liveness only; does not prove source freshness.',security:[],responses:{200:{description:'Alive'}}}};
  paths['/api/knowledge/documents']={get:{operationId:'knowledge_documents',summary:'List document metadata',security:[{BearerAuth:[]}],parameters:['server','organization','category','limit','offset'].map(name=>({name,in:'query',schema:{type:['limit','offset'].includes(name)?'integer':'string'}})),responses:{200:{description:'Paginated document list'}}}};
  return {openapi:'3.1.0',info:{title:'Majestic Workspace Cloud',version:'2.0.0',description:'Single-owner API. Text from sources is untrusted. API keys go in Authorization headers only. Forum reply confirmation requires separate explicit human approval.'},servers:[{url:cfg.publicUrl}],paths,components:{securitySchemes:{BearerAuth:{type:'http',scheme:'bearer'},OAuth2:{type:'oauth2',flows:{authorizationCode:{authorizationUrl:cfg.publicUrl+'/oauth/authorize',tokenUrl:cfg.publicUrl+'/oauth/token',scopes:{read:'Read selected sources',sync:'Schedule synchronization',write:'Prepare and confirm forum replies'}}}}}}};
}
function createApp({cfg=loadConfig(),store,httpClient,relay,forum,discord,knowledge,scheduler}={}){
  store||=new Store(cfg);httpClient||=new HttpClient({allowedHosts:[...cfg.allowedHosts,'discord.com']});relay||=new Relay(store);forum||=new Forum(store,cfg,httpClient,relay);discord||=new Discord(store,cfg,httpClient);knowledge||=new Knowledge(store,cfg,httpClient,forum);scheduler||=new Scheduler(store,cfg,knowledge,discord);
  const discordBridge=new DiscordBridge(store,cfg);discord.bridge=discordBridge;
  const auth=new Auth(store,cfg),service=new ToolService({cfg,store,relay,forum,discord,knowledge,scheduler}),limits=new Map();let inFlight=0,closing=false;
  function rate(req,oauth=false){const key=(req.socket?.remoteAddress||'unknown')+(oauth?':oauth':':api'),now=Date.now();let record=limits.get(key);if(!record||now-record.start>=60000){if(limits.size>=256)limits.delete(limits.keys().next().value);record={start:now,count:0};limits.set(key,record);}if(++record.count>(oauth?10:120))fail(429,'REQUEST_RATE','Request rate exceeded',{retryAfterMs:60000-(now-record.start)});}
  async function handle(req,res){
    if(closing)fail(503,'SHUTTING_DOWN','Server is shutting down');if((req.url||'').length>4096)fail(414,'URL_SIZE','URL too long');
    const url=new URL(req.url,'http://internal'),origin=req.headers.origin;
    const allowedHosts=new Set([new URL(cfg.publicUrl).host,`127.0.0.1:${cfg.port}`,`localhost:${cfg.port}`,...cfg.extraHosts]);
    if(req.headers.host&&!allowedHosts.has(req.headers.host))fail(421,'HOST','Unexpected Host header');
    if(origin&&![cfg.publicUrl,'https://chatgpt.com','https://chat.openai.com'].includes(origin))fail(403,'ORIGIN','Origin is not allowed');
    if(origin){res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');res.setHeader('access-control-allow-headers','Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id');res.setHeader('access-control-allow-methods','GET, POST, DELETE, OPTIONS');res.setHeader('access-control-expose-headers','WWW-Authenticate, MCP-Session-Id');}
    res.setHeader('referrer-policy','no-referrer');res.setHeader('x-content-type-options','nosniff');
    res.setHeader('content-security-policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    rate(req,url.pathname.startsWith('/oauth/'));
    if(url.pathname==='/health'&&req.method==='GET')return json(res,200,{ok:true,service:'majestic-workspace-cloud',version:'2.0.0'});
    if(req.method==='GET'&&url.pathname==='/openapi.json')return json(res,200,openapi(cfg));
    if(req.method==='GET'&&url.pathname==='/.well-known/oauth-authorization-server')return json(res,200,auth.metadata());
    if(req.method==='GET'&&['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(url.pathname))return json(res,200,auth.protectedResource());
    if(req.method==='GET'&&url.pathname==='/oauth/authorize'){const body=auth.consent(Object.fromEntries(url.searchParams));res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(body);return;}
    if(req.method==='POST'&&url.pathname.startsWith('/oauth/')){
      if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||''))fail(415,'FORM_REQUIRED','Expected form-encoded OAuth request');
      const body=Object.fromEntries(new URLSearchParams(await readBody(req,16384)));
      if(url.pathname==='/oauth/authorize'){const redirect=auth.approve(body);res.writeHead(302,{location:redirect,'cache-control':'no-store'});res.end();return;}
      if(url.pathname==='/oauth/token')return json(res,200,auth.exchange(req,body));
      if(url.pathname==='/oauth/revoke')return json(res,200,auth.revoke(req,body));
    }
    if(inFlight>=8)fail(429,'SERVER_BUSY','Too many concurrent operations');inFlight++;
    try {
      if(url.pathname.startsWith('/api/discord/bridge/')){
        discordBridge.authenticate(req);if(req.method!=='POST')fail(405,'METHOD','Use POST');
        const body=await bodyJson(req,Math.min(cfg.maxResponseBytes,1048576));
        if(url.pathname==='/api/discord/bridge/claim')return json(res,200,{ok:true,data:discordBridge.claim(body)});
        if(url.pathname==='/api/discord/bridge/batch')return json(res,200,{ok:true,data:discordBridge.apply(body)});
        if(url.pathname==='/api/discord/bridge/events')return json(res,200,{ok:true,data:discordBridge.events(body)});
        fail(404,'NOT_FOUND','Bridge route not found');
      }
      if(url.pathname.startsWith('/api/executor/')){
        auth.executor(req);if(req.method!=='POST')fail(405,'METHOD','Use POST');
        if(url.pathname==='/api/executor/claim')return json(res,200,{ok:true,data:relay.claim()});
        if(url.pathname==='/api/executor/result'){const args=await bodyJson(req,cfg.maxResponseBytes);return json(res,200,{ok:true,data:relay.complete(args)});}
        fail(404,'NOT_FOUND','Executor route not found');
      }
      const principal=auth.authenticate(req);
      if(url.pathname==='/mcp'){
        if(req.method!=='POST')fail(405,'METHOD','Stateless Streamable HTTP supports POST; GET event streams are not offered');
        const args=await bodyJson(req,65536);return require('./mcp').handleMcp(req,res,args,service,principal);
      }
      if(req.method==='GET'&&url.pathname==='/api/knowledge/documents'){
        const args=Object.fromEntries(url.searchParams);for(const k of ['limit','offset'])if(args[k]!==undefined)args[k]=Number(args[k]);
        return json(res,200,{ok:true,data:store.list(args)},cfg.maxResponseBytes);
      }
      for(const [method,pattern,name]of ROUTES){
        if(method!==req.method)continue;const keys=[...pattern.matchAll(/:([A-Za-z]+)/g)].map(x=>x[1]),match=url.pathname.match(new RegExp('^'+pattern.replace(/:([A-Za-z]+)/g,'([^/]+)')+'/?$'));if(!match)continue;
        const args=method==='POST'?await bodyJson(req,32768):Object.fromEntries(url.searchParams);keys.forEach((key,i)=>{args[key]=decodeURIComponent(match[i+1]);});
        const def=tools.find(t=>t.name===name);
        for(const [key,s]of Object.entries(def.inputSchema.properties)){if(method==='GET'&&args[key]!==undefined){if(s.type==='integer')args[key]=Number(args[key]);if(s.type==='boolean'){if(!['true','false','1','0'].includes(args[key]))fail(422,'ARGUMENTS','Invalid boolean');args[key]=['true','1'].includes(args[key]);}}}
        return json(res,200,{ok:true,data:await service.call(name,args,principal)},cfg.maxResponseBytes);
      }
      fail(404,'NOT_FOUND','Route not found');
    }finally{inFlight--;}
  }
  const handler=(req,res)=>handle(req,res).catch(e=>{
    if(res.destroyed||res.writableEnded)return;
    if(res.headersSent){res.end();return;}
    if(e.status===401)res.setHeader('www-authenticate',`Bearer resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
    if(e.retryAfterMs)res.setHeader('retry-after',String(Math.max(1,Math.ceil(e.retryAfterMs/1000))));
    const status=e.status>=400&&e.status<=599?e.status:500;json(res,status,{ok:false,error:safeError(e)});
  });
  const server=http.createServer({maxHeaderSize:16384},handler);server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
  let closePromise;
  async function close(){if(closePromise)return closePromise;closePromise=(async()=>{closing=true;clearInterval(maintenance);httpClient.close?.();relay.close?.();knowledge.close?.();const finish=new Promise(resolve=>{if(!server.listening)return resolve();server.close(resolve);server.closeIdleConnections();const timer=setTimeout(()=>server.closeAllConnections(),5000);timer.unref();});await scheduler.stop();await finish;store.maintain();store.close();})();return closePromise;}
  const maintenance=setInterval(()=>{try{discordBridge.maintain();store.maintain();}catch{/* hard quota never deletes the current document */}},3600000);maintenance.unref();
  return {cfg,store,auth,service,forum,discord,knowledge,scheduler,relay,server,handler,close,start:async()=>{await discordBridge.prepareStorage();return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(cfg.port,cfg.host,()=>{server.removeListener('error',reject);if(cfg.schedulerEnabled)scheduler.start();resolve(server.address());});});}};
}
async function bodyJson(req,max){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail(415,'JSON_REQUIRED','Expected application/json');const raw=await readBody(req,max);try{const body=JSON.parse(raw||'{}');if(!body||typeof body!=='object'||Array.isArray(body))throw Error();return body;}catch{fail(400,'JSON_INVALID','Invalid JSON object');}}
function run(){let app;try{app=createApp();app.start().then(()=>console.log(JSON.stringify({event:'started',port:app.cfg.port,host:app.cfg.host}))).catch(e=>{console.error(JSON.stringify({event:'startup_failed',code:e.code||'STARTUP_ERROR'}));process.exitCode=1;app.close().catch(()=>{});});for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{const timer=setTimeout(()=>process.exit(1),15000);timer.unref();app.close().then(()=>clearTimeout(timer)).catch(()=>{process.exitCode=1;});});return app;}catch(e){console.error(JSON.stringify({event:'configuration_error',code:e.code||'CONFIG_ERROR',message:e.code==='CONFIG'?e.message:'Check configuration and Node.js version'}));process.exitCode=1;}}
if(require.main===module)run();
module.exports={createApp,ROUTES,openapi,bodyJson,readBody,run};
