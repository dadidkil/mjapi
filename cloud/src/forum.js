'use strict';
const {hash,token,fail,integer,page,envelope,text}=require('./util');
const {requireOk,challenge}=require('./http-client');
const BASE='https://forum.majestic-rp.ru';
class Forum {
  constructor(store,cfg,http,relay,{now=Date.now}={}) {Object.assign(this,{store,cfg,http,relay,now});this.active=false;this.parse=null;}
  parser(){return this.parse||=require('../../majestic-forum-api/lib/parse');}
  async gated(action) {
    // One persisted gate for all cloud forum sources/read endpoints. The local executor uses the existing local gate instead.
    if(this.active)fail(429,'FORUM_BUSY','One forum request is already running',{retryAfterMs:30000});
    const state=this.store.getState('forumGate',{lastAt:0,inFlight:false});const wait=Math.max(state.lastAt+30000+(state.inFlight?120000:0)-this.now(),0);
    if(wait>0)fail(429,'FORUM_COOLDOWN','Forum request interval is 30 seconds',{retryAfterMs:wait});
    this.active=true;this.store.setState('forumGate',{lastAt:this.now(),inFlight:true});
    try{return await action();}finally{this.store.setState('forumGate',{lastAt:this.now(),inFlight:false});this.active=false;}
  }
  executor(){return this.cfg.forumMode==='executor'||(this.cfg.forumMode==='auto'&&this.relay.online());}
  async read(operation,args={}) {
    if(!['sections','search','thread','latest'].includes(operation))fail(422,'FORUM_OPERATION','Unknown forum read');
    const pg=integer(args.page,1,1,10000);if(operation==='thread')integer(args.id,undefined,1,Number.MAX_SAFE_INTEGER);
    if(operation==='search')text(args.q,200,true);
    const key='forum:'+hash(JSON.stringify([operation,{...args,fresh:undefined}]));const saved=this.store.db.prepare('SELECT body,at FROM cache WHERE key=?').get(key);
    if(!args.fresh&&saved&&this.now()-saved.at<this.cfg.forumCacheSeconds*1000)return {...JSON.parse(saved.body),cached:true};
    let data;
    if(this.executor())data=await this.relay.request(operation,{...args,page:pg});
    else {
      if(operation==='search')fail(503,'EXECUTOR_REQUIRED','Live forum search needs the local authenticated executor');
      const url=BASE+(operation==='sections'?(args.sectionId?`/forums/${integer(args.sectionId,undefined,1,Number.MAX_SAFE_INTEGER)}/`:'/'):operation==='thread'?`/threads/${args.id}/${pg>1?'page-'+pg:''}`:`/whats-new/latest-activity${pg>1?'?page='+pg:''}`);
      data=await this.gated(async()=>{
        const response=await this.http.request(url);
        if(response.status===403||challenge(response.body))fail(503,'FORUM_PROTECTED','Forum requires Zen Bridge; protection is not bypassed');
        requireOk(response);const parser=this.parser(),$=parser.load(response.body);
        const parsed=operation==='sections'?(args.sectionId?parser.parseForum($,response.url||url):parser.parseIndex($,response.url||url)):operation==='thread'?parser.parseThread($,response.url||url):parser.parseFeed($,response.url||url);
        if(parsed.parserWarning)fail(502,'FORUM_PARSE','Forum markup was not recognized');
        return {...parsed,via:'public',fetchedAt:new Date().toISOString()};
      });
    }
    data.untrusted=true;
    if(Buffer.byteLength(JSON.stringify(data))<this.cfg.maxResponseBytes)this.store.db.prepare('INSERT INTO cache VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,at=excluded.at').run(key,JSON.stringify(data),this.now());
    return data;
  }
  bounded(data,args={}) {
    const {limit,offset}=page(args);const result={...data};
    for(const key of ['posts','items','results','threads','subforums','categories'])if(Array.isArray(result[key])){
      const p=envelope(result[key].slice(offset,offset+limit+1),offset,limit);result[key]=p.items.map(item=>{
        const out={...item};delete out.contentHtml;
        if(typeof out.content==='string'){const max=integer(args.maxChars,4000,100,12000),start=integer(args.contentOffset,0,0,10000000);out.content=out.content.slice(start,start+max);out.contentOffset=start;out.nextContentOffset=start+max<item.content.length?start+max:null;}
        // Never label generated Markdown as original BBCode.
        if(out.bbcode===undefined&&key==='posts')out.bbcode=null;
        if(Array.isArray(out.forums)&&out.forums.length>100){out.forums=out.forums.slice(0,100);out.forumsTruncated=true;}
        return out;
      });result[key+'Page']={offset,limit,nextOffset:p.nextOffset};
    }
    return result;
  }
  async prepare(args,owner) {
    if(this.store.db.prepare('SELECT count(*) n FROM confirmations').get().n>=5000)fail(507,'CONFIRMATION_QUOTA','Confirmation journal is full; inspect uncertain sends before archival');
    const id=String(integer(args.threadId,undefined,1,Number.MAX_SAFE_INTEGER));text(args.message,20000,true);
    const fingerprint=hash(id+'\n'+args.message);
    const old=this.store.db.prepare("SELECT id,state FROM confirmations WHERE fingerprint=? AND state IN ('sending','uncertain','sent') LIMIT 1").get(fingerprint);
    if(old)fail(409,'DUPLICATE_BLOCKED','A matching reply was already attempted; inspect its status',{confirmationId:old.id});
    if(!this.relay.online())fail(503,'EXECUTOR_OFFLINE','Reply preparation requires the local executor');
    const preview=await this.relay.request('prepare',{threadId:id,message:args.message,format:'bbcode'});
    if(!preview.ready||!preview.previewId)return {...preview,confirmationId:null};
    const confirmationId=token(),expiresAt=Math.min(Date.parse(preview.expiresAt)||this.now()+300000,this.now()+300000);
    this.store.db.prepare('INSERT INTO confirmations VALUES(?,?,?,?,?,?,?,NULL,?)').run(confirmationId,owner,id,args.message,fingerprint,expiresAt,'ready',preview.previewId);
    this.store.audit('forum.prepare',owner,confirmationId);
    return {confirmationId,expiresAt:new Date(expiresAt).toISOString(),thread:preview.thread,account:preview.account,message:args.message,format:'bbcode',requiresExplicitUserConfirmation:true,publishingEnabled:this.cfg.writesEnabled};
  }
  async confirm(args,owner) {
    if(args.confirm!==true)fail(422,'CONFIRMATION_REQUIRED','User must explicitly approve this exact prepared reply');
    if(!this.cfg.writesEnabled)fail(403,'WRITES_DISABLED','Forum publishing is disabled');
    const row=this.store.db.prepare('SELECT * FROM confirmations WHERE id=? AND owner=?').get(args.confirmationId,owner);
    if(!row)fail(404,'CONFIRMATION_NOT_FOUND','Prepared reply not found for this identity');
    if(row.state!=='ready')fail(409,'CONFIRMATION_USED','Confirmation is single-use; inspect status');
    if(row.expires_at<=this.now())fail(410,'CONFIRMATION_EXPIRED','Prepare a new reply and ask for approval again');
    if(!this.relay.online())fail(503,'EXECUTOR_OFFLINE','Start the local executor');
    const changed=this.store.db.prepare("UPDATE confirmations SET state='sending' WHERE id=? AND state='ready'").run(row.id);
    if(changed.changes!==1)fail(409,'CONFIRMATION_USED','Confirmation already consumed');
    this.store.audit('forum.confirm',owner,row.id);
    try {
      const result=await this.relay.request('confirm',{previewId:row.local_preview,confirm:true});
      const state=['sent','rejected'].includes(result.state)?result.state:'uncertain';
      this.store.db.prepare('UPDATE confirmations SET state=?,result=? WHERE id=?').run(state,JSON.stringify(result),row.id);
      this.store.audit('forum.result',owner,row.id,state);return {confirmationId:row.id,state,result};
    }catch(e){this.store.db.prepare("UPDATE confirmations SET state='uncertain' WHERE id=?").run(row.id);this.store.audit('forum.result',owner,row.id,'uncertain');throw e;}
  }
  async status(id,owner) {
    const row=this.store.db.prepare('SELECT * FROM confirmations WHERE id=? AND owner=?').get(id,owner);if(!row)fail(404,'NOT_FOUND','Confirmation not found');
    if(row.state==='uncertain'&&this.relay.online()) {
      const result=await this.relay.request('reply_status',{previewId:row.local_preview});
      if(['sent','rejected'].includes(result.state)){this.store.db.prepare('UPDATE confirmations SET state=?,result=? WHERE id=?').run(result.state,JSON.stringify(result),id);row.state=result.state;row.result=JSON.stringify(result);}
    }
    return {confirmationId:id,state:row.state,result:row.result?JSON.parse(row.result):null,threadId:row.thread_id};
  }
}
module.exports={Forum,BASE};
