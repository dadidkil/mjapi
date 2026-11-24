'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { splitArticles } = require('../../tools/laws');
const { hash, normalize, fail, page, envelope, integer } = require('./util');
const DOC_FIELDS = 'id,title,category,server,organization,source,source_url,published_at,checked_at,changed_at,hash,version,source_version';
class Store {
  constructor(cfg, filename = path.join(cfg.dataDir,'workspace.sqlite')) {
    this.cfg = cfg; this.filename = filename;
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA cache_size=-4096; PRAGMA temp_store=MEMORY; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304;');
    this.migrate();
    this.db.exec(`PRAGMA max_page_count=${Math.floor(this.cfg.maxDbBytes/4096)};`);
    // Claimed writes are ambiguous after a process crash. Never replay them.
    this.db.exec("UPDATE relay SET state='uncertain' WHERE state='claimed'; UPDATE confirmations SET state='uncertain' WHERE state='sending'; UPDATE jobs SET state='interrupted',next_at=0 WHERE state='running';");
  }
  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) fail(500,'DB_VERSION','Database was created by a newer application');
    if (version >= 1) return;
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,title TEXT NOT NULL,category TEXT NOT NULL,server TEXT NOT NULL,organization TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,source_url TEXT NOT NULL,body TEXT NOT NULL,published_at TEXT,checked_at TEXT NOT NULL,changed_at TEXT NOT NULL,hash TEXT NOT NULL,version INTEGER NOT NULL,source_version TEXT);
      CREATE INDEX documents_scope ON documents(server,organization,category);
      CREATE TABLE versions(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,version INTEGER NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,changed_at TEXT NOT NULL,source_version TEXT,title TEXT NOT NULL,PRIMARY KEY(document_id,version));
      CREATE TABLE chunks(id INTEGER PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,article TEXT,title TEXT NOT NULL,body TEXT NOT NULL,ordinal INTEGER NOT NULL);
      CREATE INDEX chunks_doc ON chunks(document_id,article);
      CREATE VIRTUAL TABLE chunks_fts USING fts5(title,body,content=chunks,content_rowid=id,tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,title,body) VALUES(new.id,new.title,new.body); END;
      CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body); END;
      CREATE TABLE changes(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,entity_id TEXT NOT NULL,server TEXT NOT NULL DEFAULT '',at TEXT NOT NULL,detail TEXT NOT NULL);
      CREATE TABLE audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,event TEXT NOT NULL,actor TEXT NOT NULL,entity_id TEXT NOT NULL DEFAULT '',outcome TEXT NOT NULL);
      CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'idle',next_at INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,last_at TEXT,last_success TEXT,error TEXT,result TEXT);
      CREATE TABLE discord(guild_id TEXT PRIMARY KEY,body TEXT NOT NULL,hash TEXT NOT NULL,checked_at TEXT NOT NULL,changed_at TEXT NOT NULL,version INTEGER NOT NULL);
      CREATE TABLE cache(key TEXT PRIMARY KEY,body TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE confirmations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,thread_id TEXT NOT NULL,message TEXT NOT NULL,fingerprint TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,result TEXT,local_preview TEXT);
      CREATE INDEX confirmations_fingerprint ON confirmations(fingerprint,state);
      CREATE TABLE relay(id TEXT PRIMARY KEY,operation TEXT NOT NULL,args TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,claim TEXT,result TEXT);
      CREATE TABLE oauth(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,client TEXT NOT NULL,scope TEXT NOT NULL,resource TEXT NOT NULL,family TEXT NOT NULL,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,extra TEXT NOT NULL DEFAULT '{}');
      PRAGMA user_version=1; COMMIT;`);
    this.db.exec(`PRAGMA max_page_count=${Math.floor(this.cfg.maxDbBytes/4096)};`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch(e) {
      // SQLITE_FULL can roll back automatically. Never hide its cause with a second rollback.
      try { if(this.db.isTransaction)this.db.exec('ROLLBACK'); } catch { /* Preserve the original write error. */ }
      throw e;
    }
  }
  getState(key, fallback = null) { const v = this.db.prepare('SELECT value FROM state WHERE key=?').get(key); return v ? JSON.parse(v.value) : fallback; }
  setState(key, value) { this.db.prepare('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  audit(event,actor,entity='',outcome='ok') { this.db.prepare('INSERT INTO audit(at,event,actor,entity_id,outcome) VALUES(?,?,?,?,?)').run(new Date().toISOString(),event,actor,entity,outcome); }
  upsertDocument(input) {
    if (!input.body?.trim() || Buffer.byteLength(input.body)>this.cfg.maxDocumentBytes) fail(422,'DOCUMENT_SIZE','Empty or oversized document; previous version retained');
    const now = new Date().toISOString(); const contentHash = hash(normalize(input.body));
    const old = this.db.prepare('SELECT hash,version,server,source_id FROM documents WHERE id=?').get(input.id);
    if(old&&(old.server!==input.server||old.source_id!==input.sourceId))fail(409,'DOCUMENT_SCOPE','A document ID cannot move between sources or servers');
    const changed = !old || old.hash !== contentHash;
    const version = old ? old.version + (changed ? 1 : 0) : 1;
    this.transaction(()=>{
      this.db.prepare(`INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,category=excluded.category,organization=excluded.organization,source_url=excluded.source_url,body=CASE WHEN hash<>excluded.hash THEN excluded.body ELSE body END,checked_at=excluded.checked_at,changed_at=CASE WHEN hash<>excluded.hash THEN excluded.changed_at ELSE changed_at END,hash=excluded.hash,version=excluded.version,source_version=excluded.source_version`).run(input.id,input.sourceId,input.title,input.category,input.server,input.organization||'',input.source,input.url,input.body,input.publishedAt||null,now,now,contentHash,version,input.sourceVersion ? String(input.sourceVersion) : null);
      if (!changed) return;
      this.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)').run(input.id,version,input.body,contentHash,now,input.sourceVersion ? String(input.sourceVersion) : null,input.title);
      this.db.prepare('DELETE FROM chunks WHERE document_id=?').run(input.id);
      const lines = input.body.replace(/\r\n?/g,'\n').split('\n');
      const articles = splitArticles(lines);
      const parts = [];let consumed=0;
      // Index every line, including preambles and chapter headings between articles.
      for(const a of articles){if(a.startLine-1>consumed)parts.push({number:null,text:lines.slice(consumed,a.startLine-1).join('\n')});parts.push({number:a.number,text:lines.slice(a.startLine-1,a.endLine).join('\n')});consumed=a.endLine;}
      if(consumed<lines.length)parts.push({number:null,text:lines.slice(consumed).join('\n')});
      const insert = this.db.prepare('INSERT INTO chunks(document_id,article,title,body,ordinal) VALUES(?,?,?,?,?)');
      let ordinal = 0;
      for (const part of parts) for (let i=0;i<part.text.length;i+=6000) insert.run(input.id,part.number,input.title,part.text.slice(i,i+6000),ordinal++);
      this.db.prepare('INSERT INTO changes(kind,entity_id,server,at,detail) VALUES(?,?,?,?,?)').run('knowledge',input.id,input.server,now,JSON.stringify({version,hash:contentHash,previousHash:old?.hash||null}));
      this.db.prepare('DELETE FROM versions WHERE document_id=? AND version<?').run(input.id,version-this.cfg.historyVersions+1);
    });
    return {id:input.id,changed,version,hash:contentHash};
  }
  list(args={}) {
    const {limit,offset}=page(args); const where=[]; const values=[];
    for (const [key,column] of [['server','server'],['organization','organization'],['category','category']]) if(args[key]) {where.push(`${column}=?`);values.push(args[key]);}
    const items=this.db.prepare(`SELECT ${DOC_FIELDS} FROM documents ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id LIMIT ? OFFSET ?`).all(...values,limit+1,offset);
    return envelope(items,offset,limit);
  }
  read(id,args={}) {
    const doc=this.db.prepare(`SELECT ${DOC_FIELDS} FROM documents WHERE id=?`).get(id); if(!doc)fail(404,'NOT_FOUND','Document not found');
    const offset=integer(args.offset,0,0,10000000),max=integer(args.maxChars,6000,100,12000);
    let body;
    if(args.article) body=this.db.prepare('SELECT body FROM chunks WHERE document_id=? AND article=? ORDER BY ordinal').all(id,args.article).map(x=>x.body).join('');
    else body=this.db.prepare('SELECT body FROM documents WHERE id=?').get(id).body;
    if(args.article&&!body)fail(404,'ARTICLE_NOT_FOUND','Article not found');
    return {...doc,article:args.article||null,text:body.slice(offset,offset+max),offset,nextOffset:offset+max<body.length?offset+max:null,totalChars:body.length,untrusted:true};
  }
  search(args={}) {
    const {limit,offset}=page(args); const where=[],values=[]; let from='chunks c JOIN documents d ON d.id=c.document_id'; let excerpt="substr(c.body,1,500)",order='d.id,c.ordinal';
    if(args.q?.trim()) {
      const tokens=args.q.match(/[\p{L}\p{N}_]+/gu)?.slice(0,12)||[]; if(!tokens.length)fail(422,'QUERY','Search requires words');
      from='chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN documents d ON d.id=c.document_id';where.push('chunks_fts MATCH ?');values.push(tokens.map(x=>'"'+x+'"').join(' AND '));excerpt="snippet(chunks_fts,1,'[',']','…',48)";order='bm25(chunks_fts),d.id,c.ordinal';
    } else if(!args.article)fail(422,'QUERY','Provide q or article');
    for(const key of ['server','organization','category'])if(args[key]){where.push(`d.${key}=?`);values.push(args[key]);}
    if(args.article){where.push('c.article=?');values.push(args.article);}
    const rows=this.db.prepare(`SELECT d.id,d.title,d.server,d.organization,d.category,d.source,d.source_url,d.version,d.source_version,d.checked_at,d.changed_at,d.hash,c.article,${excerpt} AS excerpt FROM ${from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values,limit+1,offset);
    return {...envelope(rows,offset,limit),untrusted:true};
  }
  history(id,args={}) { if(!this.db.prepare('SELECT 1 FROM documents WHERE id=?').get(id))fail(404,'NOT_FOUND','Document not found');const {limit,offset}=page(args);return envelope(this.db.prepare('SELECT document_id,version,hash,changed_at,source_version,title FROM versions WHERE document_id=? ORDER BY version DESC LIMIT ? OFFSET ?').all(id,limit+1,offset),offset,limit); }
  changes(kind,args={}) { const {limit,offset}=page(args);const where=['kind=?'],values=[kind];if(args.server){where.push('server=?');values.push(args.server);}if(args.since){if(!Number.isFinite(Date.parse(args.since)))fail(422,'DATE','Invalid since date');where.push('at>?');values.push(new Date(args.since).toISOString());}return envelope(this.db.prepare(`SELECT * FROM changes WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...values,limit+1,offset).map(x=>({...x,detail:JSON.parse(x.detail)})),offset,limit); }
  maintain() {
    const now=Date.now(),cutoff=new Date(now-this.cfg.historyDays*86400000).toISOString();
    this.db.prepare('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT ?)').run(this.cfg.auditRows);
    this.db.prepare('DELETE FROM changes WHERE at<? OR id NOT IN (SELECT id FROM changes ORDER BY id DESC LIMIT 3000)').run(cutoff);
    this.db.prepare('DELETE FROM versions WHERE changed_at<? AND version<(SELECT version FROM documents WHERE id=document_id)').run(cutoff);
    this.db.prepare('DELETE FROM cache WHERE at<?').run(now-3600000);
    this.db.exec('DELETE FROM cache WHERE key NOT IN (SELECT key FROM cache ORDER BY at DESC LIMIT 64)');
    this.db.prepare("DELETE FROM confirmations WHERE expires_at<? AND state='ready'").run(now-86400000);
    // Keep replay fingerprints, but bound them by age; local Workspace retains its own send journal.
    this.db.prepare("DELETE FROM confirmations WHERE expires_at<? AND state IN ('sent','rejected')").run(now-30*86400000);
    this.db.prepare('DELETE FROM relay WHERE expires_at<?').run(now-7*86400000);
    this.db.prepare('DELETE FROM oauth WHERE expires_at<?').run(now-86400000);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;');
  }
  stats() { return {documents:this.db.prepare('SELECT count(*) n FROM documents').get().n,versions:this.db.prepare('SELECT count(*) n FROM versions').get().n,dbBytes:this.db.prepare('PRAGMA page_count').get().page_count*this.db.prepare('PRAGMA page_size').get().page_size,maxDbBytes:this.cfg.maxDbBytes}; }
  async backup({force=false}={}) {
    if((!force&&!this.cfg.backupCount)||this.filename===':memory:')return null;
    const directory=path.join(this.cfg.dataDir,'backups');fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const target=path.join(directory,`workspace-${Date.now()}.sqlite`);await backup(this.db,target);
    const check=new DatabaseSync(target,{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')fail(500,'BACKUP_CHECK','Backup integrity check failed');}finally{check.close();}
    const files=fs.readdirSync(directory).filter(x=>/^workspace-\d+\.sqlite$/.test(x)).sort().reverse();for(const f of files.slice(Math.max(1,this.cfg.backupCount)))fs.unlinkSync(path.join(directory,f));return target;
  }
  compact() {
    // Repack free space inside leaf pages as well as released overflow pages.
    // Keep VACUUM's temporary database off the process's memory budget.
    const temp=this.db.prepare('PRAGMA temp_store').get().temp_store,limit=this.db.prepare('PRAGMA max_page_count').get().max_page_count;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA temp_store=FILE;');
    try { this.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);'); }
    finally { this.db.exec(`PRAGMA temp_store=${temp}; PRAGMA max_page_count=${limit};`); }
  }
  close() {this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close();}
}
module.exports={Store};
