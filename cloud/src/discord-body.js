'use strict';
const {deflateRawSync,inflateRawSync}=require('node:zlib');
const {fail}=require('./util');
const MAGIC=Buffer.from('MWD1'),MAX_BODY_BYTES=2*1024*1024;
const utf8=new TextDecoder('utf-8',{fatal:true});
function encodeBody(text){
  if(typeof text!=='string')fail(500,'ARCHIVE_FORMAT','Message body must be JSON text');
  const source=Buffer.from(text,'utf8');
  if(source.length>MAX_BODY_BYTES)fail(413,'ARCHIVE_SIZE','Message body exceeds the archive limit');
  if(source.length<256)return text;
  const packed=deflateRawSync(source,{level:6});
  return packed.length+MAGIC.length+32<source.length?Buffer.concat([MAGIC,packed]):text;
}
function decodeBody(value){
  if(typeof value==='string')return value;
  if(!(value instanceof Uint8Array))fail(500,'ARCHIVE_FORMAT','Unknown message body format');
  const packed=Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  if(packed.length<=MAGIC.length||!packed.subarray(0,MAGIC.length).equals(MAGIC))fail(500,'ARCHIVE_FORMAT','Unknown compressed message format');
  try{return utf8.decode(inflateRawSync(packed.subarray(MAGIC.length),{maxOutputLength:MAX_BODY_BYTES}));}
  catch{fail(500,'ARCHIVE_FORMAT','Compressed message body is invalid or oversized');}
}
module.exports={encodeBody,decodeBody,MAGIC,MAX_BODY_BYTES};
