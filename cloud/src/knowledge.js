'use strict';
const laws=require('../../tools/laws-sync');
const {fail,hash,integer}=require('./util');
const {requireOk,challenge}=require('./http-client');
function category(title) {
  for(const [pattern,value] of [[/конституц/i,'constitution'],[/уголовн/i,'criminal_code'],[/административн.*кодекс/i,'administrative_code'],[/процессуальн/i,'procedural_code'],[/устав/i,'charter'],[/должностн/i,'job_description'],[/регламент/i,'regulation'],[/правила/i,'government_rules']])if(pattern.test(title))return value;
  return 'state_law';
}
class Knowledge {
  constructor(store,cfg,http,forum) {Object.assign(this,{store,cfg,http,forum});this.controller=new AbortController();}
  close(){this.controller.abort();}
  async page(url,state={}) {
    const headers={};if(state.etag)headers['if-none-match']=state.etag;if(state.modified)headers['if-modified-since']=state.modified;
    const r=await this.http.request(url,{headers});if(r.status===304)return {notModified:true,state};
    if(r.status===403||challenge(r.body))fail(503,'SOURCE_PROTECTED','Source requires an authorized local browser; protection is not bypassed');
    requireOk(r);return {body:r.body,state:{etag:r.headers.etag||null,modified:r.headers['last-modified']||null}};
  }
  async sync(source) {
    if(source.type==='docossum')return this.docossum(source);
    if(source.type==='forum_thread')return this.thread(source);
    return this.html(source);
  }
  async html(source) {
    const key='source:'+source.id,previous=this.store.getState(key,{}),r=await this.page(source.url,previous);
    if(r.notModified){this.store.db.prepare('UPDATE documents SET checked_at=? WHERE source_id=?').run(new Date().toISOString(),source.id);return {unchanged:true};}
    const $=this.forum.parser().load(r.body);$('script,style,noscript,form').remove();
    const element=$(source.selector||'main').first();if(!element.length)fail(502,'SOURCE_PARSE','Configured document element not found');
    const body=laws.htmlToLines($.html(element)).join('\n');
    const result=this.store.upsertDocument({id:'source:'+source.id,sourceId:source.id,title:source.title||$('h1').first().text().trim()||source.id,category:source.category||'information',server:source.server,organization:source.organization,source:'http',url:source.url,body});
    this.store.setState(key,r.state);return result;
  }
  async thread(source) {
    const max=integer(source.maxPages,5,1,20),parts=[];let title,publication;
    // A complete page set is required before replacing a legal document. An error leaves the prior version intact.
    for(let p=1;p<=max;p++) {
      let data;
      for(let attempt=0;attempt<3;attempt++){
        try{data=await this.forum.read('thread',{id:source.threadId,page:p});break;}
        catch(e){if(!['FORUM_COOLDOWN','FORUM_BUSY'].includes(e.code)||attempt===2)throw e;await require('./util').sleep(Math.min(e.retryAfterMs||30000,30000),this.controller.signal);}
      }
      if(data.parserWarning||!data.posts?.length)fail(502,'SOURCE_PARSE','No posts found; previous document retained');
      title||=data.title;publication||=data.posts[0]?.date;
      const selected=source.postIds?data.posts.filter(x=>source.postIds.map(String).includes(String(x.id))):data.posts;
      for(const post of selected)parts.push(post.content);
      if(!data.pagination?.hasNext)break;
      if(p===max)fail(422,'SOURCE_PAGINATION','Thread exceeds configured maxPages; previous document retained');
    }
    return this.store.upsertDocument({id:'source:'+source.id,sourceId:source.id,title:source.title||title,category:source.category||'information',server:source.server,organization:source.organization,source:'forum',url:`https://forum.majestic-rp.ru/threads/${source.threadId}/`,body:parts.join('\n\n'),publishedAt:publication});
  }
  async docossum(source) {
    const key='source:'+source.id,previous=this.store.getState(key,{}),url=`https://docossum.com/legal/${source.server}`,r=await this.page(url,previous.http||{});
    if(r.notModified){this.store.db.prepare('UPDATE documents SET checked_at=? WHERE source_id=?').run(new Date().toISOString(),source.id);return {unchanged:true};}
    const list=laws.parseServerList(r.body,source.server);if(!list.documents.length)fail(502,'SOURCE_PARSE','No laws recognized; previous documents retained');
    const revisions={...(previous.revisions||{})};let fetched=0,changed=0;const errors=[];
    for(const doc of list.documents) {
      if(this.controller.signal.aborted)fail(503,'SHUTTING_DOWN','Synchronization cancelled');
      const id=`docossum:${source.server}:${doc.id}`,old=this.store.db.prepare('SELECT id FROM documents WHERE id=?').get(id),checked=this.store.getState('checked:'+id,{});
      if(old&&doc.versionId&&revisions[doc.id]===doc.versionId){this.store.db.prepare('UPDATE documents SET checked_at=? WHERE id=?').run(new Date().toISOString(),id);continue;}
      try {
        const docUrl=`${url}/document/${doc.id}`,content=await this.page(docUrl,checked);
        if(content.notModified){this.store.db.prepare('UPDATE documents SET checked_at=? WHERE id=?').run(new Date().toISOString(),id);continue;}
        const parsed=laws.parseDocument(content.body,{id:doc.id});
        const result=this.store.upsertDocument({id,sourceId:source.id,title:doc.title,category:source.category||category(doc.title),server:source.server,organization:source.organization,source:'docossum',url:docUrl,body:parsed.lines.join('\n'),publishedAt:parsed.datePublished||doc.createdAt,sourceVersion:parsed.versionId||doc.versionId});
        fetched++;if(result.changed)changed++;revisions[doc.id]=doc.versionId;this.store.setState('checked:'+id,content.state);
      }catch(e){errors.push({id,code:e.code||'FETCH_ERROR'});}
      // No parallel requests; normal public access only.
      if(!this.http.noDelay)await require('./util').sleep(1500,this.controller.signal);
    }
    this.store.setState(key,{http:errors.length?{}:r.state,revisions});
    if(errors.length)fail(502,'SOURCE_PARTIAL','Some documents could not be checked; correct versions retained',{details:{fetched,changed,errors}});
    return {documents:list.documents.length,fetched,changed,listingHash:hash(r.body)};
  }
}
module.exports={Knowledge,category};
