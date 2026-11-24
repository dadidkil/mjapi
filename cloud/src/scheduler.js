'use strict';
const {fail}=require('./util');
class Scheduler {
  constructor(store,cfg,knowledge,discord,{now=Date.now,random=Math.random}={}) {
    Object.assign(this,{store,cfg,knowledge,discord,now,random});this.tasks=new Map();this.active=new Map();this.stopped=false;
    for(const source of cfg.sources.filter(x=>x.enabled!==false))this.add(source.id,source.intervalMs,()=>knowledge.sync(source));
    for(const id of cfg.guildIds)this.add('discord:'+id,cfg.discordInterval,()=>discord.sync(id));
    this.add('maintenance',3600000,async()=>{store.maintain();const last=store.getState('lastBackup',0);if(this.now()-last>=86400000){await store.backup();store.setState('lastBackup',this.now());}return store.stats();});
  }
  add(id,interval,run){this.tasks.set(id,{interval,run});this.store.db.prepare('INSERT OR IGNORE INTO jobs(id) VALUES(?)').run(id);}
  start(){if(this.timer)return;this.stopped=false;this.timer=setInterval(()=>{this.tick().catch(()=>{});},1000);this.timer.unref();}
  status(){return {running:this.active.size,jobs:this.store.db.prepare('SELECT * FROM jobs ORDER BY id').all().filter(x=>this.tasks.has(x.id)).map(x=>({...x,result:x.result?JSON.parse(x.result):null})),scheduled:this.cfg.schedulerEnabled};}
  async run(id) {
    const task=this.tasks.get(id);if(!task)fail(404,'SYNC_NOT_FOUND','Unknown sync source');
    if(this.active.has(id))return {id,state:'already_running'};
    if(this.stopped)fail(503,'SHUTTING_DOWN','Scheduler is stopping');
    if(this.active.size>=this.cfg.concurrency)fail(429,'SYNC_BUSY','Sync concurrency limit reached',{retryAfterMs:1000});
    const execute=async()=>{
      const started=new Date(this.now()).toISOString();this.store.db.prepare("UPDATE jobs SET state='running',last_at=?,error=NULL WHERE id=?").run(started,id);
      try {
        const result=await task.run();this.store.db.prepare("UPDATE jobs SET state='ok',next_at=?,failures=0,last_success=?,result=?,error=NULL WHERE id=?").run(this.now()+task.interval,new Date(this.now()).toISOString(),JSON.stringify(result),id);
        this.store.audit('sync','scheduler',id);return {id,state:'ok',result};
      }catch(e){
        const failures=this.store.db.prepare('SELECT failures FROM jobs WHERE id=?').get(id).failures+1;
        const delay=Math.max(Math.min(3600000,30000*2**Math.min(failures-1,7))*(1+this.random()*0.2),e.retryAfterMs||0);
        const code=/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'SYNC_FAILED';
        this.store.db.prepare("UPDATE jobs SET state='error',next_at=?,failures=?,error=? WHERE id=?").run(this.now()+Math.ceil(delay),failures,code,id);
        this.store.audit('sync','scheduler',id,code);return {id,state:'error',code,retryAfterMs:Math.ceil(delay)};
      }
    };
    // Reserve the slot before calling task.run (which can synchronously trigger another run).
    const promise=Promise.resolve().then(execute);this.active.set(id,promise);
    try{return await promise;}finally{this.active.delete(id);}
  }
  async tick(){if(this.stopped)return;const rows=this.store.db.prepare('SELECT id FROM jobs WHERE next_at<=? ORDER BY next_at,id').all(this.now());for(const row of rows){if(this.active.size>=this.cfg.concurrency)break;if(this.tasks.has(row.id)&&!this.active.has(row.id))this.run(row.id).catch(()=>{});}}
  trigger(id){const ids=id?[id]:[...this.tasks.keys()].filter(x=>x!=='maintenance');for(const key of ids){if(!this.tasks.has(key))fail(404,'SYNC_NOT_FOUND','Unknown source');this.store.db.prepare('UPDATE jobs SET next_at=0 WHERE id=?').run(key);}this.tick().catch(()=>{});return {queued:ids};}
  async stop(){this.stopped=true;clearInterval(this.timer);this.timer=null;await Promise.allSettled([...this.active.values()]);}
}
module.exports={Scheduler};
