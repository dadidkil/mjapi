'use strict';
// Pure collector: injectable Discord and bridge clients make recovery testable without an account.
const ID=/^\d{15,22}$/;
const cmp=(a,b)=>a.length-b.length||a.localeCompare(b);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errorCode=e=>e?.status===401?'DISCORD_AUTH_REQUIRED':e?.status===403?'DISCORD_PERMISSION':e?.status===404?'DISCORD_NOT_FOUND':e?.code||'DISCORD_UNAVAILABLE';
function batches(items,maxBytes=240000){
  const out=[];let current=[],size=2;for(const item of items){const n=new TextEncoder().encode(JSON.stringify(item)).length+1;if(n>maxBytes)throw Object.assign(Error('A single item exceeds the batch limit'),{code:'EXPORT_ITEM_SIZE'});if(size+n>maxBytes||current.length===100){out.push(current);current=[];size=2;}current.push(item);size+=n;}if(current.length)out.push(current);return out;
}
class Collector {
  constructor(options){Object.assign(this,{sleep:wait,stopped:false,lastRequest:0,tail:Promise.resolve()},options);}
  stop(){this.stopped=true;}
  check(){if(this.stopped||(this.isEnabled&&!this.isEnabled()))throw Object.assign(Error('Stopped'),{code:'STOPPED'});}
  async get(route,query={}){
    const pending=this.tail.then(()=>this.getSequential(route,query));this.tail=pending.catch(()=>{});return pending;
  }
  async getSequential(route,query={}){
    this.check();
    for(let attempt=0;attempt<4;attempt++){
      const pause=Math.max(0,800-(Date.now()-this.lastRequest));if(pause)await this.sleep(pause);this.check();this.lastRequest=Date.now();
      try{return await this.discord(route,query);}catch(e){
        if([401,403,404].includes(e.status))throw e;
        if(attempt===3)throw e;
        const seconds=Number(e.retryAfter||e.body?.retry_after||0);
        let remaining=Math.max(seconds*1000,1000*2**attempt);
        while(remaining>0){this.check();const step=Math.min(remaining,1000);await this.sleep(step);remaining-=step;}
      }
    }
  }
  async claim(){return this.bridge('claim',{clientId:this.clientId,guildIds:this.guildIds});}
  async send(job,kind,data={}){
    this.check();const packet={jobId:job.id,claim:job.claim,seq:job.seq+1,kind,...data};
    // Retry delivery of exactly this packet; the server commits its cursor and sequence atomically.
    for(let attempt=0;attempt<3;attempt++){
      try{const next=await this.bridge('batch',packet);Object.assign(job,next);return;}catch(e){if(e.status&&e.status<500&&e.status!==429)throw e;if(attempt===2)throw e;await this.sleep(Math.max(1000*2**attempt,Number(e.retryAfter||0)*1000));this.check();}
    }
  }
  async discover(job){
    const guildId=job.guildId;if(!this.guildIds.includes(guildId)||!ID.test(guildId))throw Object.assign(Error('Guild is not selected'),{code:'GUILD_FORBIDDEN'});
    const guild=this.guild(guildId);if(!guild)throw Object.assign(Error('Open the selected guild in Discord'),{code:'GUILD_NOT_LOADED'});
    const raw=await this.get(`/guilds/${guildId}/channels`),roles=await this.get(`/guilds/${guildId}/roles`);
    if(!Array.isArray(raw)||!Array.isArray(roles))throw Object.assign(Error('Invalid guild data'),{code:'DISCORD_FORMAT'});
    const channels=new Map(),issues=[];
    for(const c of raw)if(this.canView(c))channels.set(c.id,{...c,guild_id:guildId});
    const addThreads=threads=>{for(const t of threads||[]){if(!ID.test(t.id)||!channels.has(t.parent_id))continue;channels.set(t.id,{...t,guild_id:guildId});}};
    try{const active=await this.get(`/guilds/${guildId}/threads/active`);if(!Array.isArray(active.threads))throw Error('Invalid threads');addThreads(active.threads);}catch(e){if(![400,403,404].includes(e.status))throw e;issues.push({code:errorCode(e)});}
    const parents=[...channels.values()].filter(c=>[0,5,15,16].includes(c.type)&&(!this.channelIds.length||this.channelIds.includes(c.id)));
    for(const parent of parents){
      const routes=[{path:`/channels/${parent.id}/threads/archived/public`,byId:false}];
      if(parent.type===0)routes.push({path:`/channels/${parent.id}/users/@me/threads/archived/private`,byId:true});
      if(parent.type===0&&this.canManageThreads(parent))routes.push({path:`/channels/${parent.id}/threads/archived/private`,byId:false});
      for(const route of routes){
        let before;
        try{while(true){const result=await this.get(route.path,{limit:100,...(before?{before}:{})});if(!Array.isArray(result.threads))throw Object.assign(Error('Invalid thread page'),{code:'DISCORD_FORMAT'});addThreads(result.threads);if(!result.has_more)break;const last=result.threads.at(-1),next=route.byId?last?.id:last?.thread_metadata?.archive_timestamp;if(!next||next===before)throw Object.assign(Error('Thread pagination stalled'),{code:'THREAD_CURSOR'});before=next;}}
        catch(e){if(![400,403,404].includes(e.status))throw e;issues.push({channelId:parent.id,code:errorCode(e)});}
      }
    }
    await this.send(job,'metadata',{guild:{id:guildId,name:guild.name,description:guild.description||''},roles});
    for(const items of batches([...channels.values()].sort((a,b)=>cmp(a.id,b.id))))await this.send(job,'channels',{items});
    await this.send(job,'metadata_end',{issues});
    return channels;
  }
  async run(){
    this.check();
    const response=await this.claim(),job=response.job;if(!job)return null;
    this.channelIds=response.channelIds||[];
    if(!this.guildIds.includes(job.guildId))throw Object.assign(Error('Unselected guild'),{code:'GUILD_FORBIDDEN'});
    let discovered;
    if(!job.metadataDone)discovered=await this.discover(job);
    while(job.channel){
      this.check();const task=job.channel,channelId=task.channelId;
      if(!ID.test(channelId))throw Object.assign(Error('Invalid channel ID'),{code:'CHANNEL_FORBIDDEN'});
      const known=discovered?.get(channelId)||this.channel(channelId);
      if(known&&!this.canRead(known)){await this.send(job,'channel_error',{channelId,code:'NO_MESSAGE_HISTORY'});continue;}
      try{
        if(!task.historyDone){
          const rows=await this.get(`/channels/${channelId}/messages`,{limit:100,...(task.cursor?{[task.direction==='backfill'?'before':'after']:task.cursor}:{})});
          if(!Array.isArray(rows))throw Object.assign(Error('Invalid message page'),{code:'DISCORD_FORMAT'});
          rows.sort((a,b)=>task.direction==='backfill'?-cmp(a.id,b.id):cmp(a.id,b.id));
          const parts=batches(rows);if(!parts.length)parts.push([]);
          for(let i=0;i<parts.length;i++)await this.send(job,'messages',{channelId,items:parts[i],done:i===parts.length-1&&rows.length<100});
        }else{
          const pins=await this.get(`/channels/${channelId}/messages/pins`,{limit:50,...(task.pinCursor?{before:task.pinCursor}:{})});
          if(!Array.isArray(pins.items))throw Object.assign(Error('Invalid pin page'),{code:'DISCORD_FORMAT'});
          const parts=batches(pins.items);if(!parts.length)parts.push([]);
          for(let i=0;i<parts.length;i++)await this.send(job,'pins',{channelId,items:parts[i],done:i===parts.length-1&&!pins.has_more});
        }
      }catch(e){if(![403,404].includes(e.status))throw e;await this.send(job,'channel_error',{channelId,code:errorCode(e)});}
    }
    await this.send(job,'finish');return {id:job.id,state:job.state};
  }
}
module.exports={Collector,batches,errorCode};
