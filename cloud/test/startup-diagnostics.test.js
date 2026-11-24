'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {startupFailure}=require('../src/server');
test('startup diagnostics identify SQLite failures without exposing configured credentials',()=>{
  const cfg={readToken:'private-read-value',writeToken:'private-write-value',executorToken:'private-executor-value',discordBridgeToken:'private-bridge-value',discordToken:'private-discord-value',oauthSecret:'private-oauth-value',ownerPassword:'private-password-value'};
  const error=Object.assign(Error('cannot VACUUM - SQL statements in progress '+Object.values(cfg).join(' ')),{code:'ERR_SQLITE_ERROR',errcode:1,errstr:'SQL logic error',startupStage:'archive.compact'});
  const result=startupFailure(error,cfg),text=JSON.stringify(result);
  assert.equal(result.event,'startup_failed');assert.equal(result.code,'ERR_SQLITE_ERROR');assert.equal(result.stage,'archive.compact');assert.equal(result.sqliteCode,1);assert.match(result.message,/cannot VACUUM - SQL statements in progress/);
  for(const secret of Object.values(cfg))assert.ok(!text.includes(secret));
});
test('startup diagnostics retain actual SQLite FULL and avoid dumping arbitrary exception data',()=>{
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:');let error;
  try{db.exec('PRAGMA max_page_count=8; CREATE TABLE sample(body BLOB)');db.prepare('INSERT INTO sample VALUES(?)').run(Buffer.alloc(100000));}catch(e){error=e;}finally{db.close();}
  assert.ok(error);const result=startupFailure(error,{});assert.equal(result.sqliteCode,13);assert.match(result.message,/database or disk is full/i);
  const other=startupFailure(Object.assign(Error('private arbitrary failure'),{code:'EIO',stack:'private stack',request:{authorization:'private header'}}),{});
  assert.equal(other.code,'EIO');assert.ok(!JSON.stringify(other).includes('private'));
});
