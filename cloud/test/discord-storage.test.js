'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {config}=require('./helpers'),{Store}=require('../src/store'),{DiscordBridge}=require('../src/discord-bridge');
const G='1317165120128028773',C='888888888888888888',M='999999999999999999';
const msg=(id=M,content='Initial wording',edit)=>({id,channel_id:C,content,timestamp:'2026-11-24T00:00:00Z',...(edit?{edited_timestamp:edit}:{})});
function fixture(extra={},filename=':memory:'){
  const cfg=config({guildIds:[G],discordMode:'vencord',...extra}),store=new Store(cfg,filename),bridge=new DiscordBridge(store,cfg);
  bridge.request(G,{full:false});const job=bridge.claim({clientId:'storage-test',guildIds:[G]}).job;
  const send=(kind,data={})=>Object.assign(job,bridge.apply({jobId:job.id,claim:job.claim,seq:job.seq+1,kind,...data}));
  send('metadata',{guild:{id:G,name:'Storage test'},roles:[]});
  send('channels',{items:[{id:C,guild_id:G,name:'test',type:0}]});send('metadata_end',{issues:[]});
  return {cfg,store,bridge,job,send};
}
function duplicateCurrent(store){store.db.exec('INSERT OR REPLACE INTO discord_message_versions SELECT id,version,body,changed_at FROM discord_messages');}
function temporary(){const root=path.resolve('.runtime/cloud-tests');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'discord-storage-'));return {dir,cleanup(){assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(root)+path.sep));fs.rmSync(dir,{recursive:true});}};}

test('real SQLite quota preserves its cause and rolls back the complete rejected page',()=>{
  const {store,bridge,job,send}=fixture();try{
    store.db.exec('PRAGMA max_page_count=512');let accepted=0,rejected=false;
    for(let page=0;page<40;page++){
      const items=Array.from({length:10},(_,i)=>msg(String(BigInt(M)-BigInt(page*10+i)),'sample '.repeat(1400)));
      const before=bridge.next(job.id);
      try{send('messages',{channelId:C,items,done:false});accepted+=items.length;}
      catch(error){
        rejected=true;assert.equal(error.code,'EXPORT_QUOTA');assert.equal(error.status,507);
        const after=bridge.next(job.id),status=bridge.status(G);
        assert.equal(after.seq,before.seq);assert.equal(after.channel.cursor,before.channel.cursor);
        assert.equal(status.messageCount,accepted);assert.ok(accepted>0);
        assert.equal(status.job.state,'failed');assert.equal(status.job.error,'EXPORT_QUOTA');assert.equal(status.historyComplete,false);
        assert.equal(store.db.isTransaction,false);assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
        assert.doesNotThrow(()=>store.transaction(()=>store.db.exec('DELETE FROM cache')));break;
      }
    }
    assert.equal(rejected,true,'the real page quota must be reached');
  }finally{store.close();}
});

test('current message is stored once and history keeps exact previous edits with pagination',()=>{
  const {store,bridge,send}=fixture({historyVersions:3});try{
    send('messages',{channelId:C,items:[msg()],done:true});
    assert.equal(store.db.prepare('SELECT count(*) n FROM discord_message_versions').get().n,0);
    assert.equal(bridge.history(G,C,M).items[0].message.content,'Initial wording');
    for(let i=1;i<=4;i++)bridge.events({guildId:G,channelId:C,items:[{type:'upsert',message:msg(M,'Edition '+i,`2026-11-24T0${i}:00:00Z`)}]});
    const history=bridge.history(G,C,M);assert.deepEqual(history.items.map(x=>x.version),[5,4,3]);
    assert.deepEqual(history.items.map(x=>x.message.content),['Edition 4','Edition 3','Edition 2']);
    assert.equal(store.db.prepare('SELECT count(*) n FROM discord_message_versions').get().n,2);
    assert.equal(bridge.history(G,C,M,{limit:1}).nextOffset,1);
    assert.equal(bridge.history(G,C,M,{limit:1,offset:1}).items[0].version,4);
    assert.equal(bridge.search({guildId:G,q:'Edition 4'}).items.length,1);
    bridge.events({guildId:G,channelId:C,items:[{type:'upsert',message:msg(M,'Edition 4','2026-11-24T04:00:00Z')}]});
    assert.equal(bridge.history(G,C,M).items.length,3);
  }finally{store.close();}
});

test('legacy duplicate compaction makes a verified backup and preserves messages, edits and cursors',async()=>{
  const temp=temporary(),{store,bridge,send,job}=fixture({dataDir:temp.dir,backupCount:0},path.join(temp.dir,'workspace.sqlite'));
  try{
    send('messages',{channelId:C,items:[msg()],done:false});
    bridge.events({guildId:G,channelId:C,items:[{type:'upsert',message:msg(M,'Edited wording','2026-11-24T01:00:00Z')}]});
    duplicateCurrent(store);const before=bridge.history(G,C,M),cursor=bridge.next(job.id);
    const result=await bridge.prepareStorage();assert.equal(result.removedCopies,1);assert.ok(result.backup);
    const backup=new DatabaseSync(result.backup,{readOnly:true});try{
      assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check,'ok');
      assert.equal(backup.prepare('SELECT count(*) n FROM discord_message_versions').get().n,2);
    }finally{backup.close();}
    assert.deepEqual(bridge.history(G,C,M),before);assert.deepEqual(bridge.next(job.id),cursor);
    assert.equal(bridge.messages(G,C).items[0].content,'Edited wording');
    assert.equal(store.db.prepare('SELECT count(*) n FROM discord_message_versions').get().n,1);
    assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
    assert.deepEqual(await bridge.prepareStorage(),{removedCopies:0,backup:null});
    send('messages',{channelId:C,items:[msg(String(BigInt(M)-1n),'Next page')],done:false});
    assert.equal(bridge.status(G).messageCount,2);assert.equal(bridge.next(job.id).seq,cursor.seq+1);
    const storage=bridge.status(G).storage;assert.ok(storage.dbBytes>0);assert.equal(storage.maxDbBytes,store.cfg.maxDbBytes);assert.ok(storage.reusableBytes>=0);
  }finally{store.close();temp.cleanup();}
});

test('compaction leaves every nonidentical revision intact',async()=>{
  const {store,bridge,send}=fixture();try{
    send('messages',{channelId:C,items:[msg()],done:false});
    const current=store.db.prepare('SELECT * FROM discord_messages').get();
    store.db.prepare('INSERT INTO discord_message_versions VALUES(?,?,?,?)').run(current.id,current.version,current.body,'2026-11-23T00:00:00.000Z');
    const before=bridge.history(G,C,M);assert.deepEqual(await bridge.prepareStorage(),{removedCopies:0,backup:null});
    assert.deepEqual(bridge.history(G,C,M),before);assert.equal(before.items.length,2);
  }finally{store.close();}
});

test('startup refuses compaction if its backup fails',async()=>{
  const {cfg,store,send}=fixture();send('messages',{channelId:C,items:[msg()],done:false});duplicateCurrent(store);
  const {createApp}=require('../src/server'),app=createApp({cfg,store,httpClient:{close(){}}});
  const error=Object.assign(Error('Synthetic backup failure'),{code:'BACKUP_TEST'});store.backup=async()=>{throw error;};
  try{
    await assert.rejects(app.start(),error);assert.equal(app.server.listening,false);
    assert.equal(store.db.prepare('SELECT count(*) n FROM discord_message_versions').get().n,1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM discord_messages').get().n,1);
  }finally{await app.close();}
});
