'use strict';
const {equal,hash,token,fail,text}=require('./util');
const {createHash}=require('node:crypto');
const SCOPES=['read','sync','write'];
const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
class Auth {
  constructor(store,cfg){Object.assign(this,{store,cfg});}
  resource(){return this.cfg.publicUrl+'/mcp';}
  metadata(){return {issuer:this.cfg.publicUrl,authorization_endpoint:this.cfg.publicUrl+'/oauth/authorize',token_endpoint:this.cfg.publicUrl+'/oauth/token',revocation_endpoint:this.cfg.publicUrl+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['client_secret_basic','client_secret_post'],scopes_supported:SCOPES};}
  protectedResource(){return {resource:this.resource(),authorization_servers:[this.cfg.publicUrl],scopes_supported:SCOPES,bearer_methods_supported:['header']};}
  authenticate(req,scope='read') {
    const bearer=/^Bearer ([^\s]+)$/.exec(req.headers.authorization||'')?.[1];
    if(equal(bearer,this.cfg.writeToken))return {id:'api-owner',scopes:SCOPES};
    if(equal(bearer,this.cfg.readToken)){if(scope!=='read')fail(403,'SCOPE_REQUIRED','A write-capable credential is required');return {id:'api-owner',scopes:['read']};}
    if(bearer){const row=this.store.db.prepare("SELECT * FROM oauth WHERE hash=? AND kind='access' AND used=0 AND expires_at>?").get(hash(bearer),Date.now());
      if(row&&row.resource===this.resource()){const scopes=row.scope.split(' ');if(!scopes.includes(scope))fail(403,'SCOPE_REQUIRED',`OAuth scope required: ${scope}`);return {id:'oauth:'+row.client,scopes};}}
    fail(401,'UNAUTHORIZED','Authentication required');
  }
  executor(req){const value=/^Bearer ([^\s]+)$/.exec(req.headers.authorization||'')?.[1];if(!equal(value,this.cfg.executorToken))fail(401,'UNAUTHORIZED','Executor authentication required');return {id:'executor',scopes:[]};}
  enabled(){if(!this.cfg.oauthSecret)fail(503,'OAUTH_NOT_CONFIGURED','Configure the static OAuth client and owner password');}
  consent(query) {
    this.enabled();const client=query.client_id,redirect=query.redirect_uri,resource=query.resource||this.resource();
    if(client!==this.cfg.oauthClientId||!this.cfg.redirects.includes(redirect))fail(400,'OAUTH_CLIENT','Unregistered client or redirect');
    if(query.response_type!=='code'||query.code_challenge_method!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge||'')||resource!==this.resource())fail(400,'OAUTH_REQUEST','Authorization code with PKCE S256 and exact MCP resource required');
    text(query.state,512);const scopes=(query.scope||'read').split(' ').filter(Boolean);if(!scopes.length||scopes.some(x=>!SCOPES.includes(x)))fail(400,'OAUTH_SCOPE','Invalid OAuth scope');
    const request=token();this.save(request,'consent',scopes.join(' '),token(),Date.now()+300000,{redirect,challenge:query.code_challenge,state:query.state||''});
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Majestic Workspace</title><body><h1>Подключить Majestic Workspace</h1><p>Клиент: ${escapeHtml(client)}.</p><p>Разрешения: ${escapeHtml(scopes.join(', '))}. Данные выбранных Discord-каналов будут доступны этому клиенту.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${request}"><label>Пароль владельца <input name="password" type="password" autocomplete="current-password" required></label><p><label><input name="approve" value="yes" type="checkbox" required>Разрешаю указанный доступ</label></p><button type="submit">Подключить</button></form></body></html>`;
  }
  approve(body) {
    this.enabled();if(body.approve!=='yes'||!equal(body.password,this.cfg.ownerPassword))fail(403,'OAUTH_DENIED','Access was not approved');
    const key=hash(body.request||''),row=this.store.db.prepare("SELECT * FROM oauth WHERE hash=? AND kind='consent' AND used=0 AND expires_at>?").get(key,Date.now());if(!row)fail(400,'OAUTH_REQUEST','Consent expired or already used');
    const extra=JSON.parse(row.extra),code=token();this.store.transaction(()=>{this.store.db.prepare('UPDATE oauth SET used=1 WHERE hash=?').run(key);this.save(code,'code',row.scope,row.family,Date.now()+120000,extra);});
    const url=new URL(extra.redirect);url.searchParams.set('code',code);if(extra.state)url.searchParams.set('state',extra.state);this.store.audit('oauth.approve','owner',row.client);return url.href;
  }
  save(value,kind,scope,family,expires,extra={}){this.store.db.prepare('INSERT INTO oauth(hash,kind,client,scope,resource,family,expires_at,extra) VALUES(?,?,?,?,?,?,?,?)').run(hash(value),kind,this.cfg.oauthClientId,scope,this.resource(),family,expires,JSON.stringify(extra));}
  client(req,body) {
    this.enabled();let id=body.client_id,secret=body.client_secret;
    const basic=/^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization||'');if(basic){const value=Buffer.from(basic[1],'base64').toString(),at=value.indexOf(':');id=decodeURIComponent(value.slice(0,at));secret=decodeURIComponent(value.slice(at+1));}
    if(id!==this.cfg.oauthClientId||!equal(secret,this.cfg.oauthSecret))fail(401,'OAUTH_CLIENT','Invalid client credentials');
  }
  exchange(req,body) {
    this.client(req,body);const kind=body.grant_type==='authorization_code'?'code':body.grant_type==='refresh_token'?'refresh':null;if(!kind)fail(400,'OAUTH_GRANT','Unsupported grant');
    if(body.resource&&body.resource!==this.resource())fail(400,'OAUTH_RESOURCE','Invalid resource audience');
    const input=kind==='code'?body.code:body.refresh_token,row=this.store.db.prepare('SELECT * FROM oauth WHERE hash=? AND kind=? AND client=?').get(hash(input||''),kind,this.cfg.oauthClientId);
    if(!row||row.expires_at<=Date.now())fail(400,'OAUTH_GRANT','Grant expired or invalid');
    if(row.used){if(kind==='refresh')this.store.db.prepare('UPDATE oauth SET used=1 WHERE family=?').run(row.family);fail(400,'OAUTH_REPLAY','Grant already used');}
    if(kind==='code'){const extra=JSON.parse(row.extra);if(!/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier||'')||body.redirect_uri!==extra.redirect||!equal(createHash('sha256').update(body.code_verifier).digest('base64url'),extra.challenge))fail(400,'OAUTH_PKCE','PKCE or redirect mismatch');}
    const scope=body.scope||row.scope;if(scope.split(' ').some(x=>!row.scope.split(' ').includes(x)))fail(400,'OAUTH_SCOPE','Cannot increase scopes');
    const access=token(),refresh=token();this.store.transaction(()=>{this.store.db.prepare('UPDATE oauth SET used=1 WHERE hash=?').run(row.hash);this.save(access,'access',scope,row.family,Date.now()+3600000);this.save(refresh,'refresh',scope,row.family,Date.now()+30*86400000);});
    return {access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope};
  }
  revoke(req,body){this.client(req,body);const row=this.store.db.prepare('SELECT family FROM oauth WHERE hash=? AND client=?').get(hash(body.token||''),this.cfg.oauthClientId);if(row)this.store.db.prepare('UPDATE oauth SET used=1 WHERE family=?').run(row.family);return {};}
}
module.exports={Auth,SCOPES,escapeHtml};
