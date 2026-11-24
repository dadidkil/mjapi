'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { integer, fail, snowflake } = require('./util');
const ROOT = path.resolve(__dirname, '../..');
const CATEGORIES = ['project_rules','server_rules','government_rules','state_law','criminal_code','administrative_code','procedural_code','constitution','charter','regulation','job_description','information'];
const csv = value => String(value || '').split(',').map(x => x.trim()).filter(Boolean);
function loadConfig(env = process.env) {
  const selectedFile=path.join(ROOT,'cloud/config/discord-guilds.json');
  const selected=fs.existsSync(selectedFile)?JSON.parse(fs.readFileSync(selectedFile,'utf8')):{guildIds:[]};
  const port = integer(env.PORT, 15377, 1, 65535);
  const publicUrl = String(env.PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');
  const u = new URL(publicUrl);
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1','localhost'].includes(u.hostname)))) fail(500, 'CONFIG', 'PUBLIC_URL must be an HTTPS origin (loopback HTTP allowed for development)');
  const cfg = {
    port, host: '0.0.0.0', publicUrl, dataDir: path.resolve(env.DATA_DIR || path.join(ROOT,'cloud/data')),
    readToken: env.API_READ_TOKEN || '', writeToken: env.API_WRITE_TOKEN || '', executorToken: env.EXECUTOR_TOKEN || '',
    extraHosts: csv(env.ALLOWED_HOSTS),
    oauthClientId: env.OAUTH_CLIENT_ID || '', oauthSecret: env.OAUTH_CLIENT_SECRET || '', ownerPassword: env.OWNER_PASSWORD || '', redirects: csv(env.OAUTH_REDIRECT_URIS),
    allowedHosts: [...new Set(['docossum.com','forum.majestic-rp.ru',...csv(env.SOURCE_ALLOWED_HOSTS)])],
    discordToken: env.DISCORD_TOKEN || '', discordMode: env.DISCORD_AUTH_MODE || 'vencord', discordBridgeToken: env.DISCORD_BRIDGE_TOKEN || '', guildIds: env.DISCORD_GUILD_IDS===undefined?selected.guildIds.map(snowflake):csv(env.DISCORD_GUILD_IDS), channelIds: csv(env.DISCORD_CHANNEL_IDS),
    guildServers: JSON.parse(env.DISCORD_GUILD_SERVERS || '{}'),
    messageLimit: integer(env.DISCORD_MESSAGE_LIMIT,100,1,1000), discordInterval: integer(env.DISCORD_INTERVAL_SECONDS,900,60,86400)*1000,
    knowledgeInterval: integer(env.KNOWLEDGE_INTERVAL_SECONDS,900,60,86400)*1000, concurrency: integer(env.SYNC_CONCURRENCY,1,1,2),
    schedulerEnabled: env.SCHEDULER_ENABLED !== '0', forumMode: env.FORUM_MODE || 'auto', writesEnabled: env.FORUM_WRITES_ENABLED === '1',
    forumCacheSeconds: integer(env.FORUM_CACHE_SECONDS,60,30,3600), maxDbBytes: integer(env.MAX_DB_MB,160,8,200)*1024*1024,
    maxDocumentBytes: integer(env.MAX_DOCUMENT_BYTES,1048576,1024,2097152), maxResponseBytes: integer(env.MAX_RESPONSE_BYTES,1048576,16384,4194304),
    historyVersions: integer(env.HISTORY_VERSIONS,8,1,20), historyDays: integer(env.HISTORY_DAYS,30,1,365), auditRows: integer(env.AUDIT_ROWS,1000,100,10000), backupCount: integer(env.BACKUP_COUNT,1,0,2)
  };
  if (!['vencord','bot','user'].includes(cfg.discordMode) || !['auto','public','executor'].includes(cfg.forumMode)) fail(500,'CONFIG','Invalid Discord/Forum mode');
  [...cfg.guildIds,...cfg.channelIds].forEach(snowflake);
  for (const [id,server] of Object.entries(cfg.guildServers)) if (!cfg.guildIds.includes(id)||!/^[a-z0-9_-]{1,40}$/.test(server)) fail(500,'CONFIG','Invalid DISCORD_GUILD_SERVERS mapping');
  const secrets = [cfg.readToken,cfg.writeToken,cfg.executorToken,cfg.oauthSecret,cfg.discordBridgeToken].filter(Boolean);
  if (secrets.some(x => x.length < 32) || new Set(secrets).size !== secrets.length) fail(500,'CONFIG','Secrets must be distinct and at least 32 characters');
  if (cfg.oauthSecret && (cfg.ownerPassword.length < 16 || !cfg.oauthClientId || !cfg.redirects.length)) fail(500,'CONFIG','OAuth needs a client ID, redirect allowlist and OWNER_PASSWORD (16+ characters)');
  for (const redirect of cfg.redirects) { const r = new URL(redirect); if (r.protocol !== 'https:' || r.username || r.password || r.hash) fail(500,'CONFIG','OAuth redirect must be HTTPS'); }
  const file = path.resolve(env.SOURCES_FILE || path.join(ROOT,'cloud/config/sources.json'));
  cfg.sources = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : [{id:'laws-houston',type:'docossum',server:'houston'},{id:'laws-miami',type:'docossum',server:'miami'}];
  if (!Array.isArray(cfg.sources) || cfg.sources.length > 100) fail(500,'CONFIG','Expected at most 100 sources');
  const seen = new Set();
  for (const source of cfg.sources) {
    if (!source || !/^[a-z0-9_-]{1,80}$/.test(source.id || '') || seen.has(source.id) || !['http','docossum','forum_thread'].includes(source.type) || !/^[a-z0-9_-]{1,40}$/.test(source.server || '') || (source.category && !CATEGORIES.includes(source.category))) fail(500,'CONFIG','Invalid or duplicate knowledge source');
    if (source.type === 'docossum' && !['houston','miami'].includes(source.server)) fail(500,'CONFIG','Existing Docossum parser supports Houston and Miami only');
    if (source.type === 'http' && !source.url) fail(500,'CONFIG','HTTP source needs a URL');
    if (source.type === 'forum_thread') integer(source.threadId,undefined,1,Number.MAX_SAFE_INTEGER);
    source.intervalMs = integer(source.intervalSeconds, cfg.knowledgeInterval/1000,60,86400)*1000;
    seen.add(source.id);
  }
  return cfg;
}
module.exports = { loadConfig, ROOT, CATEGORIES };
