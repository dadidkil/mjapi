'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const {config}=require('./helpers'),{Store}=require('../src/store'),{DiscordBridge,message}=require('../src/discord-bridge');
const G='1317165120128028773',C='888888888888888888',M='999999999999999999';
const raw=(i=0,content='Archive text '.repeat(100))=>({id:String(BigInt(M)-BigInt(i)),channel_id:C,content,timestamp:'2026-11-24T00:00:00Z',author:{id:'777777777777777777',username:'test'},embeds:[{title:'Source',description:'Original wording'}],attachments:[]});
function setup(dir){
  const cfg=config({guildIds:[G],discordMode:'vencord',backupCount:0,...(dir?{dataDir:dir}:{})});
  const store=new Store(cfg,dir?path.join(dir,'workspace.sqlite'):':memory:'),bridge=new DiscordBridge(store,cfg);
  bridge.request(G,{full:false});const job=bridge.claim({clientId:'compression-test',guildIds:[G]}).job;
  const send=(kind,data={})=>Object.assign(job,bridge.apply({jobId:job.id,claim:job.claim,seq:job.seq+1,kind,...data}));
  send('metadata',{guild:{id:G,name:'Test'},roles:[]});send('channels',{items:[{id:C,guild_id:G,name:'test',type:0}]});send('metadata_end',{issues:[]});
  return {cfg,store,bridge,job,send};
}
function folder(){const root=path.resolve('.runtime/cloud-tests');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'compression-'));return {dir,remove(){assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(root)+path.sep));fs.rmSync(dir,{recursive:true});}};}
function legacyBodies(store){
  const {decodeBody}=require('../src/discord-body');
  for(const row of store.db.prepare('SELECT id,body FROM discord_messages').all())store.db.prepare('UPDATE discord_messages SET body=? WHERE id=?').run(decodeBody(row.body),row.id);
  for(const row of store.db.prepare('SELECT message_row,version,body FROM discord_message_versions').all())store.db.prepare('UPDATE discord_message_versions SET body=? WHERE message_row=? AND version=?').run(decodeBody(row.body),row.message_row,row.version);
  store.setState('discordBodyCompressionV1',0);
}

test('large message bodies are compressed while API text, search, edits and history stay exact',()=>{
  const {store,bridge,send}=setup();try{
    const source=raw(0,'Порядок\u0000\u001b[31m редакция\n'.repeat(300));send('messages',{channelId:C,items:[source],done:false});
    const row=store.db.prepare('SELECT *,typeof(body) storage_type FROM discord_messages').get();
    assert.equal(row.storage_type,'blob');assert.ok(row.body.byteLength<Buffer.byteLength(JSON.stringify(message(source,C)))/2);
    assert.equal(bridge.messages(G,C).items[0].content,source.content);assert.equal(bridge.search({guildId:G,q:'Порядок'}).items[0].content,source.content);
    const edited={...source,content:'Новая редакция '.repeat(200),edited_timestamp:'2026-11-24T01:00:00Z'};
    bridge.events({guildId:G,channelId:C,items:[{type:'upsert',message:edited}]});
    const history=bridge.history(G,C,source.id,{limit:1});assert.equal(history.items[0].message.content,edited.content);assert.equal(history.nextOffset,1);
    assert.equal(bridge.history(G,C,source.id,{offset:1}).items[0].message.content,source.content);
    bridge.events({guildId:G,channelId:C,items:[{type:'upsert',message:edited}]});assert.equal(bridge.history(G,C,source.id).items.length,2);
    bridge.events({guildId:G,channelId:C,items:[{type:'delete',id:source.id}]});assert.equal(bridge.messages(G,C).items.length,0);assert.equal(bridge.messages(G,C,{includeDeleted:true}).items[0].content,edited.content);
  }finally{store.close();}
});

test('unchanged full-scan messages do not rewrite the FTS index',()=>{
  const {store,bridge,send}=setup();try{
    const source=raw();send('messages',{channelId:C,items:[source],done:false});
    const before=store.db.prepare('SELECT id,block FROM discord_messages_fts_data ORDER BY id').all();
    bridge.events({guildId:G,channelId:C,items:[{type:'upsert',message:source}]});
    assert.deepEqual(store.db.prepare('SELECT id,block FROM discord_messages_fts_data ORDER BY id').all(),before);
  }finally{store.close();}
});

test('body codec preserves Unicode and control characters and bounds invalid compressed input',()=>{
  const {encodeBody,decodeBody,MAX_BODY_BYTES,MAGIC}=require('../src/discord-body');
  const text=JSON.stringify({content:'🙂\u0000\u001b[31m текст\n'.repeat(1000)}),encoded=encodeBody(text);
  assert.ok(encoded instanceof Uint8Array);assert.equal(decodeBody(encoded),text);assert.equal(decodeBody(text),text);assert.equal(decodeBody(encodeBody('{}')),'{}');
  assert.throws(()=>decodeBody(Buffer.from('unknown format')),{code:'ARCHIVE_FORMAT'});
  assert.throws(()=>decodeBody(Buffer.concat([MAGIC,Buffer.from('broken deflate') ])),{code:'ARCHIVE_FORMAT'});
  const bomb=require('node:zlib').deflateRawSync(Buffer.alloc(MAX_BODY_BYTES+1,65));
  assert.throws(()=>decodeBody(Buffer.concat([MAGIC,bomb])),{code:'ARCHIVE_FORMAT'});
});

test('legacy migration backs up text, compresses current and previous bodies, and preserves exact API results and cursor',async()=>{
  const temp=folder(),{store,bridge,job,send}=setup(temp.dir);try{
    send('messages',{channelId:C,items:[raw()],done:false});
    bridge.events({guildId:G,channelId:C,items:[{type:'upsert',message:{...raw(),content:'Edited archive '.repeat(300),edited_timestamp:'2026-11-24T01:00:00Z'}}]});
    legacyBodies(store);store.db.exec('INSERT INTO discord_message_versions SELECT id,version,body,changed_at FROM discord_messages');
    const before=bridge.messages(G,C),history=bridge.history(G,C,M),cursor=bridge.next(job.id),fts=store.db.prepare('SELECT id,block FROM discord_messages_fts_data ORDER BY id').all();
    const result=await bridge.prepareStorage();assert.ok(result.backup);assert.equal(result.removedCopies,1);
    const copy=new DatabaseSync(result.backup,{readOnly:true});try{assert.equal(copy.prepare('SELECT typeof(body) type FROM discord_messages').get().type,'text');assert.equal(copy.prepare('SELECT count(*) n FROM discord_message_versions').get().n,2);assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check,'ok');}finally{copy.close();}
    assert.equal(store.db.prepare('SELECT typeof(body) type FROM discord_messages').get().type,'blob');assert.equal(store.db.prepare('SELECT typeof(body) type FROM discord_message_versions').get().type,'blob');
    assert.deepEqual(bridge.messages(G,C),before);assert.deepEqual(bridge.history(G,C,M),history);assert.deepEqual(bridge.next(job.id),cursor);assert.deepEqual(store.db.prepare('SELECT id,block FROM discord_messages_fts_data ORDER BY id').all(),fts);
    assert.equal(store.getState('discordBodyCompressionV1'),1);assert.deepEqual(await bridge.prepareStorage(),{removedCopies:0,backup:null});
    assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
    assert.doesNotThrow(()=>store.db.exec("INSERT INTO discord_messages_fts(discord_messages_fts,rank) VALUES('integrity-check',1)"));
  }finally{store.close();temp.remove();}
});

test('compression frees reusable pages and resumes new imports without raising a full page quota',async()=>{
  const temp=folder(),{store,bridge,job,send}=setup(temp.dir);try{
    const sources=Array.from({length:240},(_,i)=>raw(i,'History line '.repeat(45)));
    for(let i=0;i<sources.length;i+=100)send('messages',{channelId:C,items:sources.slice(i,i+100),done:false});
    legacyBodies(store);const pages=store.db.prepare('PRAGMA page_count').get().page_count,cursor=bridge.next(job.id);store.db.exec('PRAGMA max_page_count='+pages);
    await bridge.prepareStorage();assert.deepEqual(bridge.next(job.id),cursor);assert.ok(bridge.status(G).storage.dbBytes<pages*4096);assert.equal(store.db.prepare('PRAGMA max_page_count').get().max_page_count,pages);assert.equal(store.db.prepare('PRAGMA temp_store').get().temp_store,2);
    send('messages',{channelId:C,items:Array.from({length:30},(_,i)=>raw(240+i,'Next page '.repeat(45))),done:false});
    assert.equal(bridge.status(G).messageCount,270);assert.ok(store.db.prepare('PRAGMA page_count').get().page_count<=pages);assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  }finally{store.close();temp.remove();}
});

test('failed compression backup leaves legacy bodies, history and cursor unchanged',async()=>{
  const temp=folder(),{store,bridge,job,send}=setup(temp.dir);try{
    send('messages',{channelId:C,items:[raw()],done:false});legacyBodies(store);
    const before=bridge.messages(G,C),cursor=bridge.next(job.id),failure=Object.assign(Error('Synthetic backup failure'),{code:'BACKUP_TEST'});store.backup=async()=>{throw failure;};
    await assert.rejects(bridge.prepareStorage(),failure);assert.equal(store.db.prepare('SELECT typeof(body) type FROM discord_messages').get().type,'text');assert.deepEqual(bridge.messages(G,C),before);assert.deepEqual(bridge.next(job.id),cursor);assert.equal(store.getState('discordBodyCompressionV1'),0);
  }finally{store.close();temp.remove();}
});

test('a reopened SQLite archive reads compressed messages, previous edits and the saved cursor',async()=>{
  const temp=folder(),context=setup(temp.dir);let {store,bridge}=context;
  try{
    const source=raw();context.send('messages',{channelId:C,items:[source],done:false});
    bridge.events({guildId:G,channelId:C,items:[{type:'upsert',message:{...source,content:'Changed wording '.repeat(100),edited_timestamp:'2026-11-24T01:00:00Z'}}]});
    legacyBodies(store);await bridge.prepareStorage();
    const before=bridge.messages(G,C),history=bridge.history(G,C,M),cursor=bridge.next(context.job.id);store.close();
    store=new Store(context.cfg);bridge=new DiscordBridge(store,context.cfg);await bridge.prepareStorage();
    assert.deepEqual(bridge.messages(G,C),before);assert.deepEqual(bridge.history(G,C,M),history);assert.deepEqual(bridge.next(context.job.id),cursor);
    assert.equal(bridge.search({guildId:G,q:'Changed'}).items[0].content,before.items[0].content);
    assert.equal(bridge.status(G).storage.compressionMigrated,true);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2);
  }finally{store.close();temp.remove();}
});

test('interrupted packing retries without replacing the original precompression backup',async()=>{
  const temp=folder(),{store,bridge,send}=setup(temp.dir);try{
    send('messages',{channelId:C,items:[raw()],done:false});legacyBodies(store);
    const compact=store.compact.bind(store),backup=store.backup.bind(store);let backups=0;
    store.backup=async options=>{backups++;return backup(options);};
    const failure=Object.assign(Error('Synthetic packing failure'),{code:'PACK_TEST'});store.compact=()=>{throw failure;};
    await assert.rejects(bridge.prepareStorage(),failure);assert.equal(store.getState('discordBodyCompressionV1'),1);assert.equal(store.getState('discordBodyPackedV1'),0);assert.equal(bridge.messages(G,C).items[0].content,raw().content);
    store.compact=compact;await bridge.prepareStorage();assert.equal(backups,1);assert.equal(store.getState('discordBodyPackedV1'),1);assert.equal(bridge.status(G).storage.compressionMigrated,true);
    assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  }finally{store.close();temp.remove();}
});

test('a failure halfway through migration rolls back earlier body changes and the migration marker',async()=>{
  const temp=folder(),{store,bridge,job,send}=setup(temp.dir);try{
    send('messages',{channelId:C,items:[raw(),raw(1)],done:false});legacyBodies(store);
    const {MAX_BODY_BYTES}=require('../src/discord-body');store.db.prepare('UPDATE discord_messages SET body=? WHERE message_id=?').run(JSON.stringify({content:'x'.repeat(MAX_BODY_BYTES+100)}),raw(1).id);
    const cursor=bridge.next(job.id);await assert.rejects(bridge.prepareStorage(),{code:'ARCHIVE_SIZE'});
    assert.equal(store.db.prepare("SELECT count(*) n FROM discord_messages WHERE typeof(body)='text'").get().n,2);
    assert.equal(store.getState('discordBodyCompressionV1'),0);assert.deepEqual(bridge.next(job.id),cursor);assert.equal(store.db.isTransaction,false);
    assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  }finally{store.close();temp.remove();}
});
