'use strict';
const {token,fail,sleep}=require('./util');
const OPERATIONS=new Set(['sections','search','thread','latest','prepare','confirm','reply_status']);
class Relay {
  constructor(store,{timeoutMs=110000}={}) {this.store=store;this.timeoutMs=timeoutMs;this.closed=false;this.controllers=new Set();}
  online(){return Date.now()-this.store.getState('executorSeen',0)<45000;}
  async request(operation,args) {
    if(!OPERATIONS.has(operation))fail(422,'RELAY_OPERATION','Unknown executor operation');
    if(!this.online())fail(503,'EXECUTOR_OFFLINE','Start the local executor and open Zen with Majestic Workspace');
    if(this.store.db.prepare("SELECT count(*) n FROM relay WHERE state IN ('pending','claimed')").get().n>=8)fail(429,'RELAY_BUSY','Executor queue is full');
    const id=token(),expires=Date.now()+this.timeoutMs;
    this.store.db.prepare('INSERT INTO relay VALUES(?,?,?,?,?,?,NULL,NULL)').run(id,operation,JSON.stringify(args),'pending',Date.now(),expires);
    const controller=new AbortController();this.controllers.add(controller);
    try {
      while(!this.closed&&Date.now()<expires) {
        const row=this.store.db.prepare('SELECT state,result FROM relay WHERE id=?').get(id);
        if(row.state==='done') {const result=JSON.parse(row.result);if(result.error)fail(result.status||502,result.error.code||'EXECUTOR_ERROR',result.error.message||'Executor failed');return result.data;}
        if(row.state==='uncertain')fail(409,'EXECUTOR_UNCERTAIN','Executor result is uncertain; do not repeat publication');
        await sleep(100,controller.signal);
      }
      this.store.db.prepare("UPDATE relay SET state=CASE WHEN state='claimed' THEN 'uncertain' ELSE 'expired' END WHERE id=? AND state IN ('pending','claimed')").run(id);
      fail(504,'EXECUTOR_TIMEOUT','Executor timed out; inspect reply status before retrying');
    } finally {this.controllers.delete(controller);}
  }
  claim(){
    this.store.setState('executorSeen',Date.now());
    return this.store.transaction(()=>{
      const row=this.store.db.prepare("SELECT * FROM relay WHERE state='pending' AND expires_at>? ORDER BY created_at LIMIT 1").get(Date.now());if(!row)return null;
      const claim=token();this.store.db.prepare("UPDATE relay SET state='claimed',claim=? WHERE id=? AND state='pending'").run(claim,row.id);
      return {id:row.id,claim,operation:row.operation,args:JSON.parse(row.args),expiresAt:row.expires_at};
    });
  }
  complete(args){
    const row=this.store.db.prepare('SELECT claim,state FROM relay WHERE id=?').get(args.id);
    if(!row||row.claim!==args.claim)fail(404,'RELAY_NOT_FOUND','Claim not found');
    if(row.state==='done')return {accepted:true,duplicate:true};
    if(!['claimed','uncertain'].includes(row.state))fail(409,'RELAY_STATE','Claim is no longer active');
    this.store.db.prepare("UPDATE relay SET state='done',result=? WHERE id=?").run(JSON.stringify(args.result),args.id);
    this.store.setState('executorSeen',Date.now());return {accepted:true};
  }
  close(){this.closed=true;for(const c of this.controllers)c.abort();}
}
module.exports={Relay,OPERATIONS};
