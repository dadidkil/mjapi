'use strict';
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const { fail, retryAfter } = require('./util');
function publicAddress(address) {
  const ip=address.toLowerCase();
  if(net.isIP(ip)===4) {const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&[0,168].includes(b))||(a===100&&b>=64&&b<=127)||(a===198&&[18,19,51].includes(b))||(a===203&&b===0));}
  // Only globally routed IPv6 unicast, excluding documentation and IPv4 mappings.
  return net.isIP(ip)===6&&/^[23]/.test(ip)&&!ip.startsWith('2001:db8:')&&!ip.startsWith('2001:0:')&&!ip.startsWith('2002:');
}
class HttpClient {
  constructor({allowedHosts,resolve=dns.lookup,timeoutMs=20000,maxBytes=4194304}={}) {Object.assign(this,{allowedHosts,resolve,timeoutMs,maxBytes});this.controller=new AbortController();this.active=new Set();}
  async request(value,options={}) {
    let url=new URL(value);
    for(let redirects=0;redirects<=3;redirects++) {
      if(this.controller.signal.aborted)fail(503,'SHUTTING_DOWN','Service is shutting down');
      if(url.protocol!=='https:'||url.port||url.username||url.password||!this.allowedHosts.includes(url.hostname)||net.isIP(url.hostname))fail(422,'SOURCE_URL','Only allowlisted public HTTPS hosts are allowed');
      const records=await this.resolve(url.hostname,{all:true,verbatim:true});
      if(!records.length||records.some(x=>!publicAddress(x.address)))fail(422,'SSRF_BLOCKED','Source resolves to a non-public address');
      const chosen=records[0];
      const response=await new Promise((resolve,reject)=>{
        const req=https.request(url,{method:options.method||'GET',headers:{'user-agent':'MajesticWorkspaceCloud/2.0','accept-encoding':'identity',...options.headers},signal:this.controller.signal,
          lookup:(_host,opts,cb)=>opts?.all?cb(null,[chosen]):cb(null,chosen.address,chosen.family)},res=>{
          const chunks=[];let size=0;const limit=options.maxBytes||this.maxBytes;
          if(Number(res.headers['content-length'])>limit){res.destroy();reject(Object.assign(new Error('Source exceeds byte limit'),{status:413,code:'SOURCE_SIZE'}));return;}
          res.on('data',chunk=>{size+=chunk.length;if(size>limit)res.destroy(Object.assign(new Error('Source exceeds byte limit'),{status:413,code:'SOURCE_SIZE'}));else chunks.push(chunk);});
          res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8'),url:url.href}));
        });
        this.active.add(req);req.on('close',()=>this.active.delete(req));req.on('error',reject);
        req.setTimeout(this.timeoutMs,()=>req.destroy(Object.assign(new Error('Source timeout'),{status:504,code:'SOURCE_TIMEOUT'})));
        const timer=setTimeout(()=>req.destroy(Object.assign(new Error('Source deadline'),{status:504,code:'SOURCE_TIMEOUT'})),this.timeoutMs);req.once('close',()=>clearTimeout(timer));
        req.end(options.body);
      });
      if([301,302,303,307,308].includes(response.status)) {
        if(options.method&&options.method!=='GET')fail(502,'REDIRECT','Refusing to redirect a write');
        if(!response.headers.location)fail(502,'REDIRECT','Missing redirect location');
        const next=new URL(response.headers.location,url);if(next.origin!==url.origin&&options.headers?.authorization)fail(502,'REDIRECT','Credential redirect refused');url=next;continue;
      }
      return response;
    }
    fail(502,'REDIRECT','Too many redirects');
  }
  close(){this.controller.abort();for(const req of this.active)req.destroy();}
}
function requireOk(response) {
  if(response.status>=200&&response.status<300)return response;
  fail(response.status===429?429:502,`SOURCE_HTTP_${response.status}`,'Source request failed',{retryAfterMs:retryAfter(response.headers['retry-after'])});
}
function challenge(body) {return /captcha|cf-chl-|just a moment|slowAES|vddosw3data|challenge-platform/i.test(String(body).slice(0,100000));}
module.exports={HttpClient,publicAddress,requireOk,challenge};
