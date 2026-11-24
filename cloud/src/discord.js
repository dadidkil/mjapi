'use strict';
const {hash,normalize,fail,sleep,retryAfter,page,envelope,snowflake}=require('./util');
const {requireOk}=require('./http-client');
const API='https://discord.com/api/v10';
const TYPES={0:'text',2:'voice',4:'category',5:'announcement',10:'announcement_thread',11:'public_thread',12:'private_thread',13:'stage',15:'forum',16:'media'};
function message(value) {
  return {id:value.id,author:{id:value.author?.id,name:value.author?.global_name||value.author?.username||null},content:value.content||'',timestamp:value.timestamp,editedAt:value.edited_timestamp||null,pinned:!!value.pinned,
    embeds:(value.embeds||[]).slice(0,10).map(e=>({title:e.title||'',description:e.description||'',fields:(e.fields||[]).map(f=>({name:f.name,value:f.value})),url:e.url||null})),
    attachments:(value.attachments||[]).map(a=>({id:a.id,filename:a.filename,url:a.url,description:a.description||null})),contentAvailable:!!value.content||!!value.embeds?.length};
}
function diff(before,after,key) {
  const old=new Map((before||[]).map(x=>[x.id,x])),next=new Map((after||[]).map(x=>[x.id,x]));
  return {entity:key,added:[...next.keys()].filter(x=>!old.has(x)),removed:[...old.keys()].filter(x=>!next.has(x)),updated:[...next.keys()].filter(x=>old.has(x)&&hash(JSON.stringify(old.get(x)))!==hash(JSON.stringify(next.get(x))))};
}
class Discord {
  constructor(store,cfg,http) {Object.assign(this,{store,cfg,http});this.tail=Promise.resolve();}
  async get(route) {
    // Serialize all routes: one conservative persisted cooldown handles per-bucket AND global limits without a Gateway.
    const work=this.tail.then(async()=>{
      if(!this.cfg.discordToken)fail(503,'DISCORD_NOT_CONFIGURED','Set DISCORD_TOKEN and guild/channel allowlists');
      for(let attempt=0;attempt<3;attempt++) {
        const until=this.store.getState('discordNotBefore',0),wait=until-Date.now();
        if(wait>10000)fail(429,'DISCORD_RATE_LIMIT','Discord requested a cooldown',{retryAfterMs:wait});if(wait>0)await sleep(wait);
        const r=await this.http.request(API+route,{headers:{authorization:this.cfg.discordMode==='bot'?'Bot '+this.cfg.discordToken:this.cfg.discordToken}});
        let data;try{data=JSON.parse(r.body);}catch{fail(502,'DISCORD_FORMAT','Invalid Discord response');}
        const delay=Math.max(r.status===429?Number(data.retry_after||0)*1000:0,retryAfter(r.headers['retry-after']),r.headers['x-ratelimit-remaining']==='0'?Number(r.headers['x-ratelimit-reset-after']||0)*1000:0,250);
        this.store.setState('discordNotBefore',Date.now()+delay);
        if(r.status===429){if(attempt===2||delay>10000)fail(429,'DISCORD_RATE_LIMIT','Discord rate limit',{retryAfterMs:delay});continue;}
        if([401,403].includes(r.status))fail(403,'DISCORD_PERMISSION','Discord token lacks access to the configured resource');
        requireOk(r);return data;
      }
    });this.tail=work.catch(()=>{});return work;
  }
  async messages(channelId) {
    const out=[];let before;
    while(out.length<this.cfg.messageLimit) {
      const limit=Math.min(100,this.cfg.messageLimit-out.length);const rows=await this.get(`/channels/${channelId}/messages?limit=${limit}${before?'&before='+before:''}`);
      if(!Array.isArray(rows))fail(502,'DISCORD_FORMAT','Expected messages');out.push(...rows.map(message));
      if(rows.length<limit)break;const next=rows.at(-1)?.id;if(!next||next===before)break;before=next;
    }
    return {items:out,selection:'latest-window',limit:this.cfg.messageLimit,truncated:out.length===this.cfg.messageLimit};
  }
  async pins(channelId) {
    const out=[];let before;
    while(out.length<this.cfg.messageLimit) {
      const data=await this.get(`/channels/${channelId}/messages/pins?limit=${Math.min(50,this.cfg.messageLimit-out.length)}${before?'&before='+encodeURIComponent(before):''}`);
      if(!Array.isArray(data.items))fail(502,'DISCORD_FORMAT','Expected pinned messages');
      out.push(...data.items.map(x=>({...message(x.message),pinnedAt:x.pinned_at})));if(!data.has_more)break;
      const next=data.items.at(-1)?.pinned_at;if(!next||next===before)break;before=next;
    }
    return {items:out,truncated:out.length>=this.cfg.messageLimit};
  }
  async sync(guildId) {
    this.checkGuild(guildId);
    if(this.bridge&&this.cfg.discordMode==='vencord')return this.bridge.request(guildId,{full:false});
    const guild=await this.get(`/guilds/${guildId}`),rawChannels=await this.get(`/guilds/${guildId}/channels`),roles=await this.get(`/guilds/${guildId}/roles`);
    if(!Array.isArray(rawChannels)||!Array.isArray(roles))fail(502,'DISCORD_FORMAT','Expected channels and roles');
    const channels=rawChannels.map(c=>({id:c.id,name:c.name,type:c.type,typeName:TYPES[c.type]||'unknown',parentId:c.parent_id||null,position:c.position,topic:c.topic||null,nsfw:!!c.nsfw,permissionOverwrites:c.permission_overwrites||[],availableTags:c.available_tags||[],defaultReaction:c.default_reaction_emoji||null})).sort((a,b)=>(a.position||0)-(b.position||0)||a.id.localeCompare(b.id));
    const information=[];
    for(const c of channels.filter(x=>this.cfg.channelIds.includes(x.id))) {
      if(![0,5,10,11,12].includes(c.type)){information.push({channelId:c.id,notice:'Message reads support text/announcement/thread channels; forum parent structure is included'});continue;}
      // A failed selected-channel request aborts the snapshot, retaining ALL previously correct data.
      information.push({channelId:c.id,messages:await this.messages(c.id),pins:await this.pins(c.id)});
    }
    const body={guild:{id:guildId,name:guild.name,description:guild.description||null,ownerId:guild.owner_id,features:guild.features||[]},channels,roles:roles.map(r=>({id:r.id,name:r.name,position:r.position,permissions:String(r.permissions),managed:!!r.managed,hoist:!!r.hoist,color:r.color})).sort((a,b)=>b.position-a.position||a.id.localeCompare(b.id)),information};
    const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>4*1024*1024)fail(413,'DISCORD_SIZE','Guild snapshot exceeds 4 MB; reduce message selection');
    const checksum=hash(encoded),now=new Date().toISOString(),old=this.store.db.prepare('SELECT * FROM discord WHERE guild_id=?').get(guildId),changed=old?.hash!==checksum,version=old?old.version+(changed?1:0):1;
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO discord VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET body=excluded.body,hash=excluded.hash,checked_at=excluded.checked_at,changed_at=CASE WHEN hash<>excluded.hash THEN excluded.changed_at ELSE changed_at END,version=excluded.version').run(guildId,encoded,checksum,now,now,version);
      if(changed){const prev=old?JSON.parse(old.body):{};const delta={version,channels:diff(prev.channels,channels,'channels'),roles:diff(prev.roles,body.roles,'roles'),informationChanged:hash(JSON.stringify(prev.information||[]))!==hash(JSON.stringify(information))};this.store.db.prepare('INSERT INTO changes(kind,entity_id,server,at,detail) VALUES(?,?,?,?,?)').run('discord',guildId,this.cfg.guildServers[guildId]||'',now,JSON.stringify(delta));}
    });
    for(const info of information)if(info.messages&&this.cfg.guildServers[guildId]) {
      const channel=channels.find(x=>x.id===info.channelId),items=[...new Map([...info.messages.items,...info.pins.items].map(x=>[x.id,x])).values()];
      const text=items.sort((a,b)=>a.id.localeCompare(b.id)).map(m=>`${m.timestamp} | ${m.author.name||m.author.id}\n${m.content}\n${m.embeds.map(e=>[e.title,e.description,...e.fields.map(f=>f.name+'\n'+f.value)].join('\n')).join('\n')}\n${m.attachments.map(a=>a.filename+' '+a.url).join('\n')}`).join('\n\n');
      if(text.trim())this.store.upsertDocument({id:`discord:${guildId}:${info.channelId}`,sourceId:`discord:${guildId}`,title:`${guild.name} / ${channel.name}`,category:'information',server:this.cfg.guildServers[guildId],source:'discord',url:`https://discord.com/channels/${guildId}/${info.channelId}`,body:text,sourceVersion:version});
    }
    return {guildId,changed,version,channels:channels.length,roles:roles.length,informationChannels:information.length};
  }
  checkGuild(id){snowflake(id);if(!this.cfg.guildIds.includes(id))fail(403,'GUILD_FORBIDDEN','Guild is not allowlisted');}
  snapshot(id){this.checkGuild(id);const row=this.store.db.prepare('SELECT * FROM discord WHERE guild_id=?').get(id);if(!row)fail(404,'DISCORD_NOT_SYNCED','Guild has not synced yet');return {body:JSON.parse(row.body),version:row.version,checkedAt:row.checked_at,changedAt:row.changed_at};}
  guilds(args={}){const {limit,offset}=page(args);return envelope(this.cfg.guildIds.slice(offset,offset+limit+1).map(id=>{const row=this.store.db.prepare('SELECT body,checked_at,version FROM discord WHERE guild_id=?').get(id);return {id,name:row?JSON.parse(row.body).guild.name:null,checkedAt:row?.checked_at||null,version:row?.version||null};}),offset,limit);}
  structure(id,args={}){if(this.bridge&&this.cfg.discordMode==='vencord')return this.bridge.structure(id,args);const s=this.snapshot(id),{limit,offset}=page(args);return {guild:s.body.guild,channels:envelope(s.body.channels.slice(offset,offset+limit+1),offset,limit),version:s.version,checkedAt:s.checkedAt,changedAt:s.changedAt,untrusted:true};}
  roles(id,args={}){const s=this.snapshot(id),{limit,offset}=page(args);return {...envelope(s.body.roles.slice(offset,offset+limit+1),offset,limit),version:s.version,checkedAt:s.checkedAt};}
  information(id,channelId,args={}){if(this.bridge&&this.cfg.discordMode==='vencord')return this.bridge.messages(id,channelId,args);if(!this.cfg.channelIds.includes(channelId))fail(403,'CHANNEL_FORBIDDEN','Channel is not allowlisted');const s=this.snapshot(id),info=s.body.information.find(x=>x.channelId===channelId);if(!info)fail(404,'NOT_FOUND','Selected channel not found');const {limit,offset}=page(args),items=args.pinned?info.pins?.items:info.messages?.items;return {...envelope((items||[]).slice(offset,offset+limit+1),offset,limit),checkedAt:s.checkedAt,version:s.version,truncated:info.messages?.truncated||info.pins?.truncated||false,untrusted:true};}
}
module.exports={Discord,message,diff};
