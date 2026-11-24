'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {memory}=require('./helpers');
const {DiscordBridge}=require('../src/discord-bridge');
const G='1317165120128028773', C='888888888888888888', M='999999999999999999';

function fixture(){
  const {store,cfg}=memory({discordMode:'vencord',guildIds:[G],channelIds:[]});
  const bridge=new DiscordBridge(store,cfg);
  bridge.request(G,{full:false});
  const job=bridge.claim({clientId:'text-test',guildIds:[G]}).job;
  const send=(kind,data={})=>Object.assign(job,bridge.apply({jobId:job.id,claim:job.claim,seq:job.seq+1,kind,...data}));
  send('metadata',{guild:{id:G,name:'EMS'},roles:[]});
  send('channels',{items:[{id:C,guild_id:G,name:'archive',type:0}]});
  send('metadata_end',{issues:[]});
  return {store,bridge,job,send};
}
function message(content){return {id:M,channel_id:C,content,timestamp:'2026-11-24T00:00:00Z',author:{username:'reader'},embeds:[],attachments:[]};}

test('Discord source text preserves ANSI escapes and control characters without stopping a history page',()=>{
  const {store,bridge,send}=fixture();
  try{
    const content='```ansi\n\u001b[1;31mКрасный текст\u001b[0m\n```\nДо\u0000после';
    const value=message(content);
    value.embeds=[{title:'Архив\u0001',description:'Описание\u001b[0m',fields:[{name:'Поле',value:'Значение\u0002'}]}];
    value.attachments=[{id:'777777777777777777',filename:'file.txt',url:'https://example.test/file',description:'Подпись\u0003'}];
    send('messages',{channelId:C,items:[value],done:true});
    send('pins',{channelId:C,items:[],done:true});
    send('finish');
    const saved=bridge.messages(G,C).items[0];
    assert.equal(saved.content,content);
    assert.equal(saved.embeds[0].description,value.embeds[0].description);
    assert.equal(saved.embeds[0].fields[0].value,value.embeds[0].fields[0].value);
    assert.equal(saved.attachments[0].description,value.attachments[0].description);
    assert.equal(bridge.status(G).historyComplete,true);
    assert.equal(bridge.search({guildId:G,q:'Красный'}).items.length,1);
  }finally{store.close();}
});

test('rejected pages remain visible behind a queued full scan and resume from their acknowledged cursor',()=>{
  const {store,bridge,job,send}=fixture();
  try{
    bridge.request(G,{full:true});
    assert.throws(()=>send('messages',{channelId:C,items:[message({unexpected:'object'})],done:true}),{code:'INVALID_TEXT'});
    const failed=bridge.status(G);
    assert.equal(failed.job.state,'queued');
    assert.equal(failed.activeJob.id,job.id);
    assert.equal(failed.activeJob.error,'INVALID_TEXT');
    assert.equal(failed.messageCount,0);
    assert.equal(bridge.next(job.id).channel.cursor,null);
    send('messages',{channelId:C,items:[message('Сохранённый текст')],done:true});
    const resumed=bridge.status(G);
    assert.equal(resumed.activeJob.error,null);
    assert.equal(resumed.messageCount,1);
    assert.ok(resumed.lastDataAt);
  }finally{store.close();}
});

test('oversized Discord source text is still rejected without advancing the cursor',()=>{
  const {store,bridge,job,send}=fixture();
  try{
    assert.throws(()=>send('messages',{channelId:C,items:[message('x'.repeat(40001))],done:true}),{code:'INVALID_TEXT'});
    assert.equal(bridge.next(job.id).channel.cursor,null);
    assert.equal(bridge.status(G).messageCount,0);
  }finally{store.close();}
});
