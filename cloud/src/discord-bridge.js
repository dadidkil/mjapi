'use strict';
// Persistent, paginated imports. The host never authenticates to Discord in this transport.
const {fail,hash,token,equal,snowflake,text,integer,page,envelope}=require('./util');
const {encodeBody,decodeBody}=require('./discord-body');
const MESSAGE_TYPES=new Set([0,2,5,10,11,12,13]);
const COMPRESSION_STATE='discordBodyCompressionV1';
const PACKED_STATE='discordBodyPackedV1';
const UPDATE_TRIGGER="CREATE TRIGGER IF NOT EXISTS dm_au AFTER UPDATE OF text ON discord_messages WHEN old.text IS NOT new.text BEGIN INSERT INTO discord_messages_fts(discord_messages_fts,rowid,text) VALUES('delete',old.id,old.text); INSERT INTO discord_messages_fts(rowid,text) VALUES(new.id,new.text); END;";
const compare=(a,b)=>a.length-b.length||a.localeCompare(b);
const stamp=()=>new Date().toISOString();
function list(value,max=100){if(!Array.isArray(value)||value.length>max)fail(422,'EXPORT_FORMAT','Invalid batch size');return value;}
function str(value,max=200){return text(value??'',max)||'';}
// Imported message bodies are JSON data; preserve source characters, including ANSI escapes.
function sourceText(value,max){const raw=value??'';if(typeof raw!=='string'||raw.length>max)fail(422,'INVALID_TEXT','Invalid or oversized source text');return raw;}
function message(m,channelId){
  if(!m||m.channel_id!==channelId)fail(422,'CHANNEL_MISMATCH','Message belongs to another channel');
  const id=snowflake(m.id);if(!Number.isFinite(Date.parse(m.timestamp)))fail(422,'EXPORT_FORMAT','Message timestamp required');
  const result={id,channelId,content:sourceText(m.content,40000),timestamp:m.timestamp,editedAt:m.edited_timestamp||null,type:Number(m.type)||0,
    author:{id:m.author?.id?snowflake(m.author.id):null,name:sourceText(m.author?.global_name||m.author?.username,200)},
    embeds:list(m.embeds||[],25).map(e=>({title:sourceText(e.title,2000),description:sourceText(e.description,20000),url:str(e.url,4000),fields:list(e.fields||[],30).map(f=>({name:sourceText(f.name,2000),value:sourceText(f.value,20000)}))})),
    attachments:list(m.attachments||[],25).map(a=>({id:snowflake(a.id),filename:sourceText(a.filename,1000),url:str(a.url,8000),description:sourceText(a.description,4000),size:Number(a.size)||0,contentType:str(a.content_type,200)})),
    reference:m.message_reference?{messageId:m.message_reference.message_id||null,channelId:m.message_reference.channel_id||null,guildId:m.message_reference.guild_id||null}:null};
  if(result.editedAt&&!Number.isFinite(Date.parse(result.editedAt)))fail(422,'EXPORT_FORMAT','Invalid edit timestamp');
  return result;
}
function searchable(m){return [m.content,...m.embeds.flatMap(e=>[e.title,e.description,...e.fields.flatMap(f=>[f.name,f.value])]),...m.attachments.map(a=>a.filename+' '+a.description)].join('\n').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,' ');}
class DiscordBridge {
  constructor(store,cfg){
    Object.assign(this,{store,cfg});
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS discord_exports(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,client TEXT,claim TEXT,lease_until INTEGER NOT NULL DEFAULT 0,seq INTEGER NOT NULL DEFAULT 0,packet_hash TEXT,metadata TEXT,metadata_done INTEGER NOT NULL DEFAULT 0,issues TEXT NOT NULL DEFAULT '[]',error TEXT);
      CREATE INDEX IF NOT EXISTS discord_exports_guild ON discord_exports(guild_id,state);
      CREATE TABLE IF NOT EXISTS discord_channels(guild_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,seen_run TEXT NOT NULL,present INTEGER NOT NULL DEFAULT 1,history_complete INTEGER NOT NULL DEFAULT 0,history_before TEXT,latest_id TEXT,checked_at TEXT,error TEXT,PRIMARY KEY(guild_id,id));
      CREATE TABLE IF NOT EXISTS discord_export_channels(job_id TEXT NOT NULL REFERENCES discord_exports(id) ON DELETE CASCADE,channel_id TEXT NOT NULL,direction TEXT NOT NULL,cursor TEXT,history_done INTEGER NOT NULL DEFAULT 0,pin_cursor TEXT,pins_started INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',error TEXT,PRIMARY KEY(job_id,channel_id));
      CREATE TABLE IF NOT EXISTS discord_messages(id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,body TEXT NOT NULL,text TEXT NOT NULL,hash TEXT NOT NULL,version INTEGER NOT NULL,checked_at TEXT NOT NULL,changed_at TEXT NOT NULL,source_at TEXT NOT NULL,seen_run TEXT NOT NULL DEFAULT '',pin_run TEXT NOT NULL DEFAULT '',pinned INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,UNIQUE(guild_id,channel_id,message_id));
      CREATE INDEX IF NOT EXISTS discord_messages_channel ON discord_messages(guild_id,channel_id,message_id);
      CREATE TABLE IF NOT EXISTS discord_message_versions(message_row INTEGER NOT NULL REFERENCES discord_messages(id) ON DELETE CASCADE,version INTEGER NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(message_row,version));
      CREATE VIRTUAL TABLE IF NOT EXISTS discord_messages_fts USING fts5(text,content=discord_messages,content_rowid=id,tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS dm_ai AFTER INSERT ON discord_messages BEGIN INSERT INTO discord_messages_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS dm_ad AFTER DELETE ON discord_messages BEGIN INSERT INTO discord_messages_fts(discord_messages_fts,rowid,text) VALUES('delete',old.id,old.text); END;
      ${UPDATE_TRIGGER}
    `);
  }
  async prepareStorage(){
    let stage='archive.inspect';
    try{
    // Retain an independently verified backup before changing existing archive bodies.
    const duplicate='EXISTS (SELECT 1 FROM discord_messages m WHERE m.id=v.message_row AND m.version=v.version AND m.body=v.body AND m.changed_at=v.at)';
    const copies=!!this.store.db.prepare(`SELECT 1 FROM discord_message_versions v WHERE ${duplicate} LIMIT 1`).get();
    const initialized=this.store.getState(COMPRESSION_STATE,0)===1;
    const legacy=!initialized&&(this.store.db.prepare("SELECT 1 FROM discord_messages WHERE typeof(body)='text' LIMIT 1").get()||this.store.db.prepare("SELECT 1 FROM discord_message_versions WHERE typeof(body)='text' LIMIT 1").get());
    if(!copies&&!legacy){
      if(!initialized){stage='archive.initialize';this.store.transaction(()=>{this.store.db.exec('DROP TRIGGER IF EXISTS dm_au;'+UPDATE_TRIGGER+' PRAGMA user_version=2;');this.store.setState(COMPRESSION_STATE,1);this.store.setState(PACKED_STATE,1);});}
      else if(this.store.getState(PACKED_STATE,0)!==1){stage='archive.compact';this.store.compact();stage='archive.mark';this.store.setState(PACKED_STATE,1);}
      return {removedCopies:0,backup:null};
    }
    stage='archive.backup';const backup=await this.store.backup({force:true});
    if(this.store.filename!==':memory:'&&!backup)fail(500,'BACKUP_REQUIRED','Archive migration requires a verified backup');
    stage='archive.compress';const removedCopies=this.store.transaction(()=>{
      const removed=this.store.db.prepare(`DELETE FROM discord_message_versions AS v WHERE ${duplicate}`).run().changes;
      if(!initialized){
        this.store.db.exec('DROP TRIGGER IF EXISTS dm_au;'+UPDATE_TRIGGER);
        const current=this.store.db.prepare("SELECT id,body FROM discord_messages WHERE id>? AND typeof(body)='text' ORDER BY id LIMIT 20"),update=this.store.db.prepare('UPDATE discord_messages SET body=? WHERE id=?');
        let id=0,rows;while((rows=current.all(id)).length){for(const row of rows){const encoded=encodeBody(row.body);if(typeof encoded!=='string')update.run(encoded,row.id);}id=rows.at(-1).id;}
        const previous=this.store.db.prepare("SELECT message_row,version,body FROM discord_message_versions WHERE (message_row>? OR (message_row=? AND version>?)) AND typeof(body)='text' ORDER BY message_row,version LIMIT 20"),updatePrevious=this.store.db.prepare('UPDATE discord_message_versions SET body=? WHERE message_row=? AND version=?');
        let messageRow=0,version=0;while((rows=previous.all(messageRow,messageRow,version)).length){for(const row of rows){const encoded=encodeBody(row.body);if(typeof encoded!=='string')updatePrevious.run(encoded,row.message_row,row.version);}const last=rows.at(-1);messageRow=last.message_row;version=last.version;}
        this.store.db.exec('PRAGMA user_version=2;');this.store.setState(COMPRESSION_STATE,1);
      }
      this.store.setState(PACKED_STATE,0);
      return removed;
    });
    stage='archive.compact';this.store.compact();stage='archive.mark';this.store.setState(PACKED_STATE,1);
    return {removedCopies,backup};
    }catch(e){if(e&&typeof e==='object')e.startupStage=stage;throw e;}
  }
  checkGuild(id){snowflake(id);if(!this.cfg.guildIds.includes(id))fail(403,'GUILD_FORBIDDEN','Guild is not selected');}
  enabled(){if(this.cfg.discordMode!=='vencord')fail(409,'DISCORD_TRANSPORT','Select DISCORD_AUTH_MODE=vencord');}
  authenticate(req){const bearer=/^Bearer ([^\s]+)$/.exec(req.headers.authorization||'')?.[1];if(!equal(bearer,this.cfg.discordBridgeToken))fail(401,'UNAUTHORIZED','Discord bridge credential required');}
  online(){return Date.now()-this.store.getState('discordBridgeSeen',0)<45000;}
  request(guildId,{full=true}={}){
    this.enabled();this.checkGuild(guildId);
    const active=this.store.db.prepare("SELECT id,mode,state FROM discord_exports WHERE guild_id=? AND state IN ('queued','running') ORDER BY created_at").all(guildId);
    const same=active.find(j=>!full||j.mode==='full');if(same)return {...same,guildId,duplicate:true,bridgeOnline:this.online()};
    const id=token(),now=stamp();this.store.db.prepare('INSERT INTO discord_exports(id,guild_id,mode,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,guildId,full?'full':'update','queued',now,now);
    this.store.audit('discord.export','owner',guildId,full?'full':'update');
    return {id,guildId,mode:full?'full':'update',state:'queued',bridgeOnline:this.online()};
  }
  claim({clientId,guildIds}){
    this.enabled();str(clientId,100);if(!/^[a-zA-Z0-9_-]{4,100}$/.test(clientId))fail(422,'EXPORT_FORMAT','Invalid client ID');
    const allowed=list(guildIds,100).map(snowflake).filter(id=>this.cfg.guildIds.includes(id));
    this.store.setState('discordBridgeSeen',Date.now());
    const candidates=this.store.db.prepare("SELECT * FROM discord_exports WHERE state IN ('queued','running') ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,created_at,id").all();
    const row=candidates.find(r=>allowed.includes(r.guild_id)&&(r.client===clientId||r.lease_until<Date.now()));
    if(!row)return {job:null,guildIds:allowed,channelIds:this.cfg.channelIds,intervalSeconds:this.cfg.discordInterval/1000};
    // A second queued job for a guild cannot overtake an in-progress job.
    if(row.state==='queued'&&candidates.some(r=>r.guild_id===row.guild_id&&r.state==='running'))return {job:null,guildIds:allowed,channelIds:this.cfg.channelIds};
    const claim=row.client===clientId&&row.claim?row.claim:token();
    this.store.db.prepare("UPDATE discord_exports SET state='running',client=?,claim=?,lease_until=?,updated_at=? WHERE id=?").run(clientId,claim,Date.now()+60000,stamp(),row.id);
    return {job:{...this.next(row.id),claim},guildIds:allowed,channelIds:this.cfg.channelIds};
  }
  next(id){
    const j=this.store.db.prepare('SELECT * FROM discord_exports WHERE id=?').get(id);if(!j)fail(404,'EXPORT_NOT_FOUND','Export not found');this.checkGuild(j.guild_id);
    const c=this.store.db.prepare("SELECT * FROM discord_export_channels WHERE job_id=? AND state='pending' ORDER BY channel_id LIMIT 1").get(id);
    return {id:j.id,guildId:j.guild_id,mode:j.mode,state:j.state,seq:j.seq,metadataDone:!!j.metadata_done,channel:c?{channelId:c.channel_id,direction:c.direction,cursor:c.cursor,historyDone:!!c.history_done,pinCursor:c.pin_cursor,pinsStarted:!!c.pins_started}:null};
  }
  selected(c){if(!this.cfg.channelIds.length)return true;return this.cfg.channelIds.includes(c.id)||this.cfg.channelIds.includes(c.parent_id);}
  channel(guildId,channelId){this.checkGuild(guildId);snowflake(channelId);const c=this.store.db.prepare('SELECT * FROM discord_channels WHERE guild_id=? AND id=? AND present=1').get(guildId,channelId);if(!c||!this.selected(JSON.parse(c.body)))fail(403,'CHANNEL_FORBIDDEN','Channel is not selected or no longer visible');return c;}
  apply(p){
    if(!p||typeof p!=='object')fail(422,'EXPORT_FORMAT','Invalid packet');
    const j=this.store.db.prepare('SELECT * FROM discord_exports WHERE id=?').get(str(p.jobId,100));
    if(!j||!equal(p.claim,j.claim))fail(404,'EXPORT_NOT_FOUND','Export claim not found');this.checkGuild(j.guild_id);
    const seq=integer(p.seq,undefined,1,Number.MAX_SAFE_INTEGER),digest=hash(JSON.stringify(p));
    if(seq===j.seq&&digest===j.packet_hash)return {seq,duplicate:true,...this.next(j.id)};
    if(j.state!=='running'||seq!==j.seq+1)fail(409,'EXPORT_SEQUENCE','Unexpected packet sequence; resume the claimed job');
    try{
      this.store.transaction(()=>{this.accept(j,p);this.store.db.prepare('UPDATE discord_exports SET seq=?,packet_hash=?,updated_at=?,lease_until=?,error=NULL WHERE id=?').run(seq,digest,stamp(),Date.now()+60000,j.id);});
    }catch(e){
      if(e.errcode===13||/database or disk is full|SQLITE_FULL/i.test(e.message||'')){this.store.db.prepare("UPDATE discord_exports SET state='failed',error='EXPORT_QUOTA' WHERE id=?").run(j.id);fail(507,'EXPORT_QUOTA','Storage quota reached; retained pages are incomplete');}
      const code=/^[A-Z0-9_]{1,80}$/.test(e.code||'')?e.code:'EXPORT_FAILED';
      this.store.db.prepare('UPDATE discord_exports SET error=? WHERE id=?').run(code,j.id);throw e;
    }
    this.store.setState('discordBridgeSeen',Date.now());return this.next(j.id);
  }
  accept(j,p){
    const db=this.store.db,now=stamp();
    if(p.kind==='metadata'){
      if(j.metadata_done)fail(409,'EXPORT_PHASE','Metadata already complete');
      if(p.guild?.id!==j.guild_id)fail(403,'GUILD_FORBIDDEN','Guild metadata mismatch');
      const roles=list(p.roles||[],1000).map(r=>({id:snowflake(r.id),name:str(r.name,200),position:Number(r.position)||0,permissions:str(String(r.permissions??'0'),100),managed:!!r.managed,color:Number(r.color)||0,hoist:!!r.hoist}));
      db.prepare('UPDATE discord_exports SET metadata=? WHERE id=?').run(JSON.stringify({guild:{id:j.guild_id,name:str(p.guild.name,200),description:str(p.guild.description,10000)},roles}),j.id);return;
    }
    if(p.kind==='channels'){
      if(!j.metadata||j.metadata_done)fail(409,'EXPORT_PHASE','Start guild metadata first');
      for(const c of list(p.items,100)){
        if(c.guild_id!==j.guild_id)fail(403,'GUILD_FORBIDDEN','Channel belongs to another guild');
        const body={id:snowflake(c.id),guild_id:j.guild_id,name:str(c.name,200),type:integer(c.type,undefined,0,100),parent_id:c.parent_id?snowflake(c.parent_id):null,position:Number(c.position)||0,topic:str(c.topic,10000),permission_overwrites:list(c.permission_overwrites||[],1000).map(o=>({id:snowflake(o.id),type:Number(o.type)||0,allow:str(String(o.allow??'0'),100),deny:str(String(o.deny??'0'),100)})),thread_metadata:c.thread_metadata?{archived:!!c.thread_metadata.archived,archive_timestamp:c.thread_metadata.archive_timestamp||null,locked:!!c.thread_metadata.locked}:null};
        db.prepare('INSERT INTO discord_channels(guild_id,id,body,seen_run) VALUES(?,?,?,?) ON CONFLICT(guild_id,id) DO UPDATE SET body=excluded.body,seen_run=excluded.seen_run,present=1').run(j.guild_id,c.id,JSON.stringify(body),j.id);
      }return;
    }
    if(p.kind==='metadata_end'){
      if(!j.metadata||j.metadata_done)fail(409,'EXPORT_PHASE','Invalid metadata phase');
      const issues=list(p.issues||[],2000).map(e=>({channelId:e.channelId?snowflake(e.channelId):null,code:/^[A-Z0-9_]{1,80}$/.test(e.code)?e.code:'DISCOVERY_INCOMPLETE'}));
      const channels=db.prepare('SELECT * FROM discord_channels WHERE guild_id=? AND seen_run=?').all(j.guild_id,j.id);
      for(const c of channels){const value=JSON.parse(c.body);if(!MESSAGE_TYPES.has(value.type)||!this.selected(value))continue;const backfill=j.mode==='full'||!c.history_complete;db.prepare('INSERT INTO discord_export_channels(job_id,channel_id,direction,cursor) VALUES(?,?,?,?)').run(j.id,c.id,backfill?'backfill':'forward',j.mode==='full'?null:backfill?c.history_before:c.latest_id);}
      if(!issues.length)db.prepare('UPDATE discord_channels SET present=0 WHERE guild_id=? AND seen_run<>?').run(j.guild_id,j.id);
      const body=JSON.parse(j.metadata),encoded=JSON.stringify({...body,channels:[],information:[]}),checksum=hash(encoded+JSON.stringify(channels.map(c=>c.body).sort()));
      const old=db.prepare('SELECT hash,version FROM discord WHERE guild_id=?').get(j.guild_id),version=old?old.version+(old.hash!==checksum?1:0):1;
      db.prepare('INSERT INTO discord VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET body=excluded.body,hash=excluded.hash,checked_at=excluded.checked_at,changed_at=CASE WHEN hash<>excluded.hash THEN excluded.changed_at ELSE changed_at END,version=excluded.version').run(j.guild_id,encoded,checksum,now,now,version);
      if(old?.hash!==checksum)db.prepare('INSERT INTO changes(kind,entity_id,server,at,detail) VALUES(?,?,?,?,?)').run('discord',j.guild_id,this.cfg.guildServers[j.guild_id]||'',now,JSON.stringify({version,source:'vencord',jobId:j.id}));
      db.prepare('UPDATE discord_exports SET metadata_done=1,issues=? WHERE id=?').run(JSON.stringify(issues),j.id);return;
    }
    if(p.kind==='finish'){
      if(!j.metadata_done||db.prepare("SELECT 1 FROM discord_export_channels WHERE job_id=? AND state='pending'").get(j.id))fail(409,'EXPORT_INCOMPLETE','History or pins are not complete');
      const partial=JSON.parse(j.issues).length||db.prepare("SELECT 1 FROM discord_export_channels WHERE job_id=? AND state='error'").get(j.id);
      db.prepare('UPDATE discord_exports SET state=?,lease_until=0 WHERE id=?').run(partial?'partial':'complete',j.id);return;
    }
    const c=this.channel(j.guild_id,p.channelId),task=db.prepare("SELECT * FROM discord_export_channels WHERE job_id=? AND channel_id=? AND state='pending'").get(j.id,c.id);
    if(!j.metadata_done||!task)fail(409,'EXPORT_PHASE','No pending channel task');
    if(p.kind==='channel_error'){
      const code=/^[A-Z0-9_]{1,80}$/.test(p.code)?p.code:'DISCORD_UNAVAILABLE';db.prepare("UPDATE discord_export_channels SET state='error',error=? WHERE job_id=? AND channel_id=?").run(code,j.id,c.id);db.prepare('UPDATE discord_channels SET error=? WHERE guild_id=? AND id=?').run(code,j.guild_id,c.id);return;
    }
    if(typeof p.done!=='boolean')fail(422,'EXPORT_FORMAT','Explicit page completion required');
    if(p.kind==='messages'){
      if(task.history_done)fail(409,'EXPORT_PHASE','History already complete');
      const items=list(p.items,100).map(m=>message(m,c.id)).sort((a,b)=>compare(a.id,b.id));
      if(!p.done&&!items.length)fail(422,'EXPORT_CURSOR','Empty continuing page');
      const next=items.length?(task.direction==='backfill'?items[0].id:items.at(-1).id):task.cursor;
      if(task.cursor&&items.some(m=>task.direction==='backfill'?compare(m.id,task.cursor)>=0:compare(m.id,task.cursor)<=0))fail(422,'EXPORT_CURSOR','Page did not advance');
      for(let i=0;i<items.length;i++)this.upsert(j.guild_id,c.id,items[i],j.id,j.created_at,!!p.items.find(m=>m.id===items[i].id)?.pinned);
      db.prepare('UPDATE discord_export_channels SET cursor=?,history_done=? WHERE job_id=? AND channel_id=?').run(next,p.done?1:0,j.id,c.id);
      const latest=[c.latest_id,...items.map(m=>m.id)].filter(Boolean).sort(compare).at(-1)||null;
      db.prepare('UPDATE discord_channels SET latest_id=?,history_before=CASE WHEN ? THEN ? ELSE history_before END,history_complete=CASE WHEN ? THEN 1 ELSE history_complete END,checked_at=?,error=NULL WHERE guild_id=? AND id=?').run(latest,task.direction==='backfill'?1:0,next,p.done&&task.direction==='backfill'?1:0,now,j.guild_id,c.id);
      // Only a complete scan from the beginning can infer deletions.
      if(p.done&&j.mode==='full')db.prepare('UPDATE discord_messages SET deleted_at=? WHERE guild_id=? AND channel_id=? AND seen_run<>? AND checked_at<=? AND deleted_at IS NULL').run(now,j.guild_id,c.id,j.id,j.created_at);
      return;
    }
    if(p.kind==='pins'){
      if(!task.history_done)fail(409,'EXPORT_PHASE','History must finish before pins');
      const items=list(p.items,50);for(const pin of items){const m=message(pin.message,c.id);this.upsert(j.guild_id,c.id,m,j.id,j.created_at,true);db.prepare('UPDATE discord_messages SET pinned=1,pin_run=? WHERE guild_id=? AND channel_id=? AND message_id=?').run(j.id,j.guild_id,c.id,m.id);}
      const cursor=items.at(-1)?.pinned_at||task.pin_cursor;
      if(!p.done&&(!cursor||cursor===task.pin_cursor))fail(422,'EXPORT_CURSOR','Pin pagination did not advance');
      db.prepare('UPDATE discord_export_channels SET pin_cursor=?,pins_started=1,state=? WHERE job_id=? AND channel_id=?').run(cursor,p.done?'complete':'pending',j.id,c.id);
      if(p.done)db.prepare('UPDATE discord_messages SET pinned=0 WHERE guild_id=? AND channel_id=? AND pin_run<>?').run(j.guild_id,c.id,j.id);return;
    }
    fail(422,'EXPORT_KIND','Unknown packet kind');
  }
  upsert(guildId,channelId,m,run='',started='',pinned=false){
    const db=this.store.db,now=stamp(),body=JSON.stringify(m),checksum=hash(body),old=db.prepare('SELECT * FROM discord_messages WHERE guild_id=? AND channel_id=? AND message_id=?').get(guildId,channelId,m.id),sourceAt=m.editedAt||m.timestamp;
    if(old&&(Date.parse(old.source_at)>Date.parse(sourceAt)||(old.deleted_at&&started&&old.deleted_at>started))){if(run)db.prepare('UPDATE discord_messages SET seen_run=? WHERE id=?').run(run,old.id);return;}
    const version=old?old.version+(old.hash!==checksum?1:0):1;
    if(old&&old.hash!==checksum)db.prepare('INSERT OR IGNORE INTO discord_message_versions VALUES(?,?,?,?)').run(old.id,old.version,old.body,old.changed_at);
    db.prepare('INSERT INTO discord_messages(guild_id,channel_id,message_id,body,text,hash,version,checked_at,changed_at,source_at,seen_run,pinned) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,channel_id,message_id) DO UPDATE SET body=excluded.body,text=CASE WHEN hash<>excluded.hash THEN excluded.text ELSE text END,hash=excluded.hash,version=excluded.version,checked_at=excluded.checked_at,changed_at=CASE WHEN hash<>excluded.hash THEN excluded.changed_at ELSE changed_at END,source_at=excluded.source_at,seen_run=CASE WHEN excluded.seen_run<>'+"''"+' THEN excluded.seen_run ELSE seen_run END,pinned=excluded.pinned,deleted_at=NULL').run(guildId,channelId,m.id,old?.hash===checksum?old.body:encodeBody(body),searchable(m),checksum,version,now,now,sourceAt,run,pinned?1:0);
    if(old&&old.hash!==checksum)db.prepare('DELETE FROM discord_message_versions WHERE message_row=? AND version<?').run(old.id,version-this.cfg.historyVersions+1);
  }
  events({guildId,channelId,items}){
    this.enabled();this.channel(guildId,channelId);const changes=list(items,100),active=this.store.db.prepare("SELECT id,created_at FROM discord_exports WHERE guild_id=? AND state='running' LIMIT 1").get(guildId);
    this.store.transaction(()=>{for(const e of changes){if(e.type==='upsert'){const m=message(e.message,channelId);this.upsert(guildId,channelId,m,active?.id||'',active?.created_at||'',!!e.message.pinned);if(active&&e.message.pinned)this.store.db.prepare('UPDATE discord_messages SET pin_run=? WHERE guild_id=? AND channel_id=? AND message_id=?').run(active.id,guildId,channelId,m.id);}else if(e.type==='delete'){snowflake(e.id);this.store.db.prepare('UPDATE discord_messages SET deleted_at=?,checked_at=? WHERE guild_id=? AND channel_id=? AND message_id=?').run(stamp(),stamp(),guildId,channelId,e.id);}else fail(422,'EXPORT_KIND','Invalid event');}});this.store.setState('discordBridgeSeen',Date.now());return {accepted:changes.length};
  }
  status(guildId,args={}){
    this.checkGuild(guildId);const {limit,offset}=page(args),job=args.jobId?this.store.db.prepare('SELECT * FROM discord_exports WHERE id=? AND guild_id=?').get(args.jobId,guildId):this.store.db.prepare('SELECT * FROM discord_exports WHERE guild_id=? ORDER BY rowid DESC LIMIT 1').get(guildId);
    const channels=this.store.db.prepare('SELECT id,history_complete,checked_at,error FROM discord_channels WHERE guild_id=? AND present=1 ORDER BY id LIMIT ? OFFSET ?').all(guildId,limit+1,offset);
    const incomplete=this.store.db.prepare('SELECT body,history_complete FROM discord_channels WHERE guild_id=? AND present=1').all(guildId).some(c=>MESSAGE_TYPES.has(JSON.parse(c.body).type)&&this.selected(JSON.parse(c.body))&&!c.history_complete);
    const active=this.store.db.prepare("SELECT id,mode,state,error,updated_at FROM discord_exports WHERE guild_id=? AND state='running' ORDER BY created_at LIMIT 1").get(guildId);
    const lastDataAt=this.store.db.prepare('SELECT max(checked_at) at FROM discord_channels WHERE guild_id=?').get(guildId).at||null;
    const {dbBytes,maxDbBytes}=this.store.stats(),reusableBytes=this.store.db.prepare('PRAGMA freelist_count').get().freelist_count*this.store.db.prepare('PRAGMA page_size').get().page_size;
    return {guildId,bridgeOnline:this.online(),historyComplete:!!job&&job.state==='complete'&&!incomplete,oldEditsVerified:!!job&&job.mode==='full'&&job.state==='complete',job:job?{id:job.id,mode:job.mode,state:job.state,createdAt:job.created_at,updatedAt:job.updated_at,error:job.error,discoveryIssues:JSON.parse(job.issues),channelErrors:this.store.db.prepare("SELECT channel_id,error FROM discord_export_channels WHERE job_id=? AND state='error' LIMIT 50").all(job.id)}:null,activeJob:active?{id:active.id,mode:active.mode,state:active.state,error:active.error,updatedAt:active.updated_at}:null,lastDataAt,storage:{dbBytes,maxDbBytes,reusableBytes,quotaRemainingBytes:Math.max(0,maxDbBytes-dbBytes+reusableBytes),bodyEncoding:'deflate-v1',compressionMigrated:this.store.getState(COMPRESSION_STATE,0)===1&&this.store.getState(PACKED_STATE,0)===1},channels:envelope(channels,offset,limit),messageCount:this.store.db.prepare('SELECT count(*) n FROM discord_messages WHERE guild_id=? AND deleted_at IS NULL').get(guildId).n,untrusted:true};
  }
  structure(guildId,args={}){this.checkGuild(guildId);const {limit,offset}=page(args),row=this.store.db.prepare('SELECT * FROM discord WHERE guild_id=?').get(guildId);if(!row)fail(404,'DISCORD_NOT_SYNCED','No client export yet');return {guild:JSON.parse(row.body).guild,channels:envelope(this.store.db.prepare('SELECT body FROM discord_channels WHERE guild_id=? AND present=1 ORDER BY id LIMIT ? OFFSET ?').all(guildId,limit+1,offset).map(c=>{const x=JSON.parse(c.body);return {...x,parentId:x.parent_id,permissionOverwrites:x.permission_overwrites};}),offset,limit),version:row.version,checkedAt:row.checked_at,untrusted:true};}
  output(row){return {...JSON.parse(decodeBody(row.body)),version:row.version,checkedAt:row.checked_at,changedAt:row.changed_at,pinned:!!row.pinned,deleted:!!row.deleted_at,url:`https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`};}
  messages(guildId,channelId,args={}){
    this.channel(guildId,channelId);const {limit,offset}=page(args),values=[guildId,channelId];let cursor='';
    if(args.beforeId){snowflake(args.beforeId);if(offset)fail(422,'EXPORT_CURSOR','Use beforeId or offset, not both');cursor='AND (length(message_id)<? OR (length(message_id)=? AND message_id<?))';values.push(args.beforeId.length,args.beforeId.length,args.beforeId);}
    const rows=this.store.db.prepare(`SELECT * FROM discord_messages WHERE guild_id=? AND channel_id=? ${cursor} ${args.includeDeleted?'':'AND deleted_at IS NULL'} ${args.pinned?'AND pinned=1':''} ORDER BY length(message_id) DESC,message_id DESC LIMIT ? OFFSET ?`).all(...values,limit+1,offset);
    return {...envelope(rows.map(r=>this.output(r)),offset,limit),nextBeforeId:rows.length>limit?rows[limit-1].message_id:null,untrusted:true};
  }
  search(args){
    this.checkGuild(args.guildId);if(args.channelId)this.channel(args.guildId,args.channelId);
    const terms=str(args.q,200).match(/[\p{L}\p{N}_]+/gu)?.slice(0,12);if(!terms?.length)fail(422,'QUERY','Search requires words');
    const {limit,offset}=page(args),values=[terms.map(s=>'"'+s+'"').join(' AND '),args.guildId];let filter='';
    if(args.channelId){filter+=' AND m.channel_id=?';values.push(args.channelId);}
    if(this.cfg.channelIds.length){const slots=this.cfg.channelIds.map(()=>'?').join(',');filter+=` AND (c.id IN (${slots}) OR json_extract(c.body,'$.parent_id') IN (${slots}))`;values.push(...this.cfg.channelIds,...this.cfg.channelIds);}
    const rows=this.store.db.prepare(`SELECT m.* FROM discord_messages_fts JOIN discord_messages m ON m.id=discord_messages_fts.rowid JOIN discord_channels c ON c.guild_id=m.guild_id AND c.id=m.channel_id WHERE discord_messages_fts MATCH ? AND m.guild_id=? AND m.deleted_at IS NULL AND c.present=1 ${filter} ORDER BY bm25(discord_messages_fts) LIMIT ? OFFSET ?`).all(...values,limit+1,offset);
    return {...envelope(rows.map(r=>this.output(r)),offset,limit),untrusted:true};
  }
  history(guildId,channelId,messageId,args={}){
    this.channel(guildId,channelId);snowflake(messageId);const {limit,offset}=page(args),seen=new Set();
    const rows=this.store.db.prepare('WITH current AS (SELECT * FROM discord_messages WHERE guild_id=? AND channel_id=? AND message_id=?) SELECT v.version,v.body,v.at FROM discord_message_versions v JOIN current m ON m.id=v.message_row UNION ALL SELECT version,body,changed_at AS at FROM current ORDER BY version DESC').all(guildId,channelId,messageId).map(r=>({...r,body:decodeBody(r.body)})).filter(r=>{const key=JSON.stringify([r.version,r.at,r.body]);if(seen.has(key))return false;seen.add(key);return true;});
    return {...envelope(rows.slice(offset,offset+limit+1).map(r=>({version:r.version,at:r.at,message:JSON.parse(r.body)})),offset,limit),untrusted:true};
  }
  maintain(){this.store.db.prepare("DELETE FROM discord_exports WHERE state NOT IN ('queued','running') AND id NOT IN (SELECT id FROM discord_exports ORDER BY created_at DESC LIMIT 100)").run();}
}
module.exports={DiscordBridge,message,searchable,MESSAGE_TYPES};
