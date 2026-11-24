#!/usr/bin/env node
'use strict';

// Локальные кодексы majestic/laws/<server>/*.txt: точная статья, оглавление и поиск
// с указанием статьи. Отдаёт ровно нужный фрагмент вместо окон по сотне строк.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LAWS = process.env.MAJESTIC_LAWS ? path.resolve(process.env.MAJESTIC_LAWS) : path.join(ROOT, 'majestic', 'laws');
const SERVERS = ['houston', 'miami'];
const ARTICLE = /^\s*Статья\s+(\d+(?:\.\d+)*)\.?\s*(.*)$/;
const DIVISION = /^\s*(Раздел|Глава)\s+[IVXLC\d]/i;
const MAX_ARTICLE_CHARS = 20000;
const cache = new Map();

const short = (text, max = 90) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);
const label = (item) => `ст. ${item.number}${item.title ? ' — ' + short(item.title) : ''}`;
// Невидимые символы и неразрывные пробелы — через \u-escape: буквально в исходнике их не видно и легко потерять.
const clean = (text) => String(text).replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '').replace(/[\u00a0\u202f]/g, ' ').replace(/\r\n?/g, '\n');
const normalize = (text) => clean(text).toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');

function checkServer(server) {
  if (!SERVERS.includes(server)) throw new Error(`Сервер: ${SERVERS.join(' или ')}`);
  return server;
}

function files(server) {
  return (server ? [checkServer(server)] : SERVERS).flatMap((name) => {
    const dir = path.join(LAWS, name);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((file) => /^[a-z0-9_-]+\.txt$/i.test(file)).sort().map((file) => {
      const fullPath = path.join(dir, file);
      return { server: name, code: file.slice(0, -4), fullPath, modifiedAt: fs.statSync(fullPath).mtime.toISOString() };
    });
  });
}

function load(server, code) {
  if (!/^[a-z0-9_-]+$/i.test(String(code || ''))) throw new Error('Недопустимое имя кодекса');
  const list = files(server);
  const wanted = String(code).toLowerCase();
  const item = list.find((file) => file.code.toLowerCase() === wanted) || (() => {
    const partial = list.filter((file) => file.code.toLowerCase().includes(wanted));
    return partial.length === 1 ? partial[0] : null;
  })();
  if (!item) throw new Error(`Кодекс «${code}» не найден у ${server}. Есть: ${list.map((file) => file.code).join(', ')}`);
  const stat = fs.statSync(item.fullPath);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(item.fullPath);
  if (cached && cached.stamp === stamp) return cached.value;
  const lines = clean(fs.readFileSync(item.fullPath, 'utf8')).split('\n');
  const value = { ...item, title: (lines.find((line) => line.trim()) || item.code).trim().slice(0, 160), lines, articles: splitArticles(lines) };
  cache.set(item.fullPath, { stamp, value });
  return value;
}

function splitArticles(lines) {
  const articles = [];
  let current = null;
  let division = null;
  const close = (endLine) => { if (current) { current.endLine = endLine; articles.push(current); current = null; } };
  lines.forEach((line, index) => {
    const match = line.match(ARTICLE);
    if (match) {
      close(index);
      current = { number: match[1], title: match[2].trim(), startLine: index + 1, division };
      return;
    }
    if (DIVISION.test(line) && line.trim()) {
      close(index);
      division = line.trim().slice(0, 160);
    }
  });
  close(lines.length);
  return articles;
}

function articleNumber(value) {
  const number = String(value || '').replace(/^\s*(ст(атья)?\.?)\s*/i, '').replace(/\s+/g, '').replace(/\.$/, '');
  if (!/^\d+(?:\.\d+)*$/.test(number)) throw new Error('Номер статьи вида 32 или 15.6');
  return number;
}

function articleText(doc, article) {
  const text = doc.lines.slice(article.startLine - 1, article.endLine).join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > MAX_ARTICLE_CHARS ? { text: text.slice(0, MAX_ARTICLE_CHARS), truncated: true } : { text, truncated: false };
}

function article(server, code, number) {
  const doc = load(server, code);
  const wanted = articleNumber(number);
  const found = doc.articles.filter((item) => item.number === wanted);
  if (!found.length) {
    const head = wanted.split('.')[0];
    const near = doc.articles.filter((item) => item.number === head || item.number.startsWith(head + '.')).map((item) => item.number);
    const error = new Error(`Статья ${wanted} не найдена в ${server}/${doc.code}.${near.length ? ' Есть: ' + near.slice(0, 15).join(', ') : ' Смотри law_toc.'}`);
    error.code = 'ARTICLE_NOT_FOUND';
    throw error;
  }
  const [first, ...others] = found;
  return {
    source: 'local-copy', currentEditionVerified: false, server, code: doc.code, document: doc.title, modifiedAt: doc.modifiedAt,
    number: first.number, title: first.title, division: first.division, lines: `${first.startLine}-${first.endLine}`,
    ...articleText(doc, first),
    ...(others.length ? { sameNumberElsewhere: others.map((item) => ({ lines: `${item.startLine}-${item.endLine}`, title: item.title, division: item.division })) } : {}),
  };
}

function toc(server, code, prefix) {
  const doc = load(server, code);
  const head = prefix ? articleNumber(prefix) : null;
  const items = doc.articles.filter((item) => !head || item.number === head || item.number.startsWith(head + '.'));
  const out = [];
  let division;
  for (const item of items) {
    if (item.division && item.division !== division) { division = item.division; out.push(`## ${division}`); }
    out.push(`${label(item)} (стр. ${item.startLine})`);
  }
  return { source: 'local-copy', server, code: doc.code, document: doc.title, modifiedAt: doc.modifiedAt, articles: items.length, toc: out.join('\n') };
}

function locate(doc, lineNumber) {
  let found = null;
  for (const item of doc.articles) {
    if (item.startLine > lineNumber) break;
    if (lineNumber <= item.endLine) found = item;
  }
  return found;
}

function snippet(line, needle) {
  const text = line.trim();
  if (text.length <= 360) return text;
  const at = Math.max(0, normalize(text).indexOf(needle));
  const from = Math.max(0, at - 150);
  return (from ? '…' : '') + text.slice(from, from + 360) + (from + 360 < text.length ? '…' : '');
}

function search(server, query, { code, limit = 10, context = 0 } = {}) {
  const words = normalize(query).trim().split(' ').filter(Boolean);
  if (!words.length) throw new Error('Пустой запрос');
  const docs = code ? [load(server, code)] : files(server).map((item) => load(server, item.code));
  const matches = [];
  let totalMatches = 0;
  for (const doc of docs) {
    doc.lines.forEach((line, index) => {
      const value = normalize(line);
      if (!words.every((word) => value.includes(word))) return;
      totalMatches++;
      if (matches.length >= limit) return;
      const found = locate(doc, index + 1);
      const match = { server, code: doc.code, line: index + 1, article: found ? label(found) : null, text: snippet(line, words[0]) };
      if (context > 0) match.context = doc.lines.slice(Math.max(0, index - context), index + context + 1).map((item) => item.trim()).filter(Boolean).join('\n');
      matches.push(match);
    });
  }
  return { source: 'local-copy', currentEditionVerified: false, server, query, totalMatches, shown: matches.length, matches, ...(totalMatches > matches.length ? { hint: 'Уточни запрос или code; полный текст нормы — law_article' } : {}) };
}

function readRange(server, code, startLine = 1, lineCount = 40) {
  const doc = load(server, code);
  return {
    source: 'local-copy', currentEditionVerified: false, server, code: doc.code, modifiedAt: doc.modifiedAt, totalLines: doc.lines.length,
    lines: doc.lines.slice(startLine - 1, startLine - 1 + lineCount).map((text, i) => ({ line: startLine + i, text })),
  };
}

function list(server) {
  return {
    source: 'local-copy', currentEditionVerified: false,
    items: files(server).map(({ fullPath, ...item }) => {
      const entry = manifestEntry(item.server, item.code);
      return { ...item, ...(entry ? { title: entry.title, ...(entry.removed ? { removed: true } : {}) } : {}), file: fullPath };
    }),
  };
}

// ---------------------------------------------------------------- manifest и история (tools/laws-sync.js)

const jsonCache = new Map();

function readJson(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = jsonCache.get(file);
  if (cached && cached.stamp === stamp) return cached.value;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
  jsonCache.set(file, { stamp, value });
  return value;
}

function manifest(server) {
  const value = readJson(path.join(LAWS, checkServer(server), 'manifest.json'));
  return value && Array.isArray(value.documents) ? value : null;
}

function manifestEntry(server, code) {
  const value = manifest(server);
  return value ? value.documents.find((item) => item.code === code) || null : null;
}

function changesData(server) {
  const value = readJson(path.join(LAWS, checkServer(server), 'changes.json'));
  return value && Array.isArray(value.versions) ? value : null;
}

// ISO → «05.11.2026 15:20 МСК» (форум и сайт живут по Москве).
function msk(iso, withTime = true) {
  const time = Date.parse(iso);
  if (!iso || Number.isNaN(time)) return null;
  const date = new Date(time + 3 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
  return withTime ? `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} МСК` : day;
}

function versionsCount(server, code) {
  const dir = path.join(LAWS, server, '.versions');
  try { return fs.readdirSync(dir).filter((file) => file.startsWith(`${code}@`) && file.endsWith('.txt')).length; } catch { return 0; }
}

// Документы сервера: названия и статус из manifest плюс локальные файлы вне manifest.
function docs(server) {
  checkServer(server);
  const data = manifest(server);
  const present = new Map(files(server).map((item) => [item.code, item]));
  const items = [];
  for (const entry of data ? data.documents : []) {
    const file = present.get(entry.code);
    present.delete(entry.code);
    if (!file && entry.localOnly) continue;
    const archived = versionsCount(server, entry.code);
    items.push({
      code: entry.code, title: entry.title, ...(entry.lines ? { lines: entry.lines } : {}), ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
      ...(entry.supplementary ? { supplementary: true } : {}), ...(entry.removed ? { removed: true, removedAt: entry.removedAt || null } : {}),
      ...(entry.localOnly ? { localOnly: true } : {}), ...(file ? {} : { missingFile: true }), ...(entry.url ? { url: entry.url } : {}),
      ...(entry.stale ? { stale: true } : {}),
      ...(archived ? { versions: archived } : {}),
    });
  }
  for (const file of present.values()) items.push({ code: file.code, title: load(server, file.code).title, localOnly: true });
  return {
    server, source: data ? data.source : 'local-copy', synced: Boolean(data),
    syncedAt: data ? data.syncedAt : null, siteUpdatedAt: data ? data.siteUpdatedAt : null, items,
  };
}

// since: 2026-11-01, 01.11.2026 или 7d (дни назад). Даты — с полуночи МСК.
function sinceTime(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  let m = text.match(/^(\d{1,3})\s*(d|д|дн|дней|day|days)?$/i);
  if (m) return now - Number(m[1]) * 86400000;
  m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/) || text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) {
    const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
    const time = Date.UTC(Number(y), Number(mo) - 1, Number(d)) - 3 * 3600 * 1000;
    if (!Number.isNaN(time)) return time;
  }
  throw new Error('since: дата 2026-11-01, 01.11.2026 или число дней (7d)');
}

const ACTION_LABEL = { added: '+ добавлен', removed: '− снят с сайта', changed: '~ изменён' };
const clip = (text, max) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);

// Статья правки: ближайший заголовок «Статья N» в контексте перед правкой, иначе заголовок
// в самой правке (правится заголовок статьи). Заголовки ПОСЛЕ правки — уже следующая статья.
function hunkArticle(hunk) {
  const lines = (hunk.lines || []).filter((line) => typeof line === 'string');
  const firstChange = lines.findIndex((line) => line[0] === '-' || line[0] === '+');
  const end = firstChange < 0 ? lines.length : firstChange;
  for (let i = end - 1; i >= 0; i--) { if (lines[i][0] !== ' ') continue; const m = lines[i].slice(1).match(ARTICLE); if (m) return m[1]; }
  const changed = [];
  for (let i = end; i < lines.length && lines[i][0] !== ' '; i++) changed.push(lines[i]);
  for (const sign of ['+', '-']) for (const line of changed) { if (line[0] !== sign) continue; const m = line.slice(1).match(ARTICLE); if (m) return m[1]; }
  return null;
}

// Изменения законов из changes.json: дата, действие, документ, правки «- было / + стало» с номерами строк файла.
function changes(server, { since, code, limit = 5, maxChars = 12000, now } = {}) {
  checkServer(server);
  const data = changesData(server);
  if (!data) {
    const error = new Error(`Нет сохранённой истории изменений ${server}: выполни law_sync (node tools/laws-sync.js ${server})`);
    error.code = 'NO_HISTORY';
    throw error;
  }
  const meta = manifest(server);
  const offset = Number.isSafeInteger(data.headerLines) ? data.headerLines : 1;
  const codeByGuid = new Map((meta ? meta.documents : []).filter((item) => item.guid).map((item) => [String(item.guid), item.code]));
  const from = sinceTime(since, now);
  const wanted = code ? normalize(code).trim() : null;
  const actionCode = (action) => (action.guid && codeByGuid.get(String(action.guid))) || action.code || null;
  const matches = (action) => {
    if (!wanted) return true;
    const value = actionCode(action);
    return (value && value.toLowerCase() === wanted) || String(action.guid || '') === wanted || (/[а-я]/.test(wanted) && normalize(action.title || '').includes(wanted));
  };
  const selected = [];
  for (const version of data.versions) {
    if (from !== null && !(Date.parse(version.date) >= from)) continue;
    const actions = (version.actions || []).filter(matches);
    if (actions.length) selected.push({ ...version, actions });
  }
  const total = selected.length;
  const shownVersions = selected.slice(0, Math.max(1, Math.min(60, limit)));
  const latestByGuid = new Map();
  for (const version of data.versions) for (const action of version.actions || []) if (action.guid && !latestByGuid.has(action.guid)) latestByGuid.set(action.guid, version.version);
  const fileIsCurrent = (version, action) => meta && action.guid && latestByGuid.get(action.guid) === version.version && Date.parse(meta.syncedAt) >= Date.parse(version.date);

  const overview = shownVersions.map((version) => `${msk(version.date) || version.date}: ${version.actions.map((action) => `${(ACTION_LABEL[action.action] || action.action)[0]}${actionCode(action) || '«' + clip(action.title || '?', 40) + '»'}`).join(', ')}`);
  const out = [];
  let used = overview.join('\n').length;
  let detailVersions = 0;
  let truncated = false;
  for (const version of shownVersions) {
    const block = [`## ${msk(version.date) || version.date}`];
    for (const action of version.actions) {
      const value = actionCode(action);
      const hunks = Array.isArray(action.hunks) ? action.hunks : [];
      block.push(`${ACTION_LABEL[action.action] || action.action}: «${action.title || '?'}»${value ? ` [${value}]` : ''}${hunks.length ? ` — правок: ${hunks.length}` : ''}${action.truncated ? ' (diff на сайте обрезан)' : ''}`);
      let doc = null;
      if (value && fileIsCurrent(version, action)) { try { doc = load(server, value); } catch { doc = null; } }
      for (const hunk of hunks) {
        let oldLine = hunk.oldStart + offset;
        let newLine = hunk.newStart + offset;
        let article = hunkArticle(hunk);
        if (!article && doc) { const found = locate(doc, newLine); if (found) article = found.number; }
        block.push(`@@ ${article ? `ст. ${article} · ` : ''}стр. ${newLine}`);
        for (const raw of hunk.lines) {
          const sign = raw[0];
          const text = raw.slice(1).trim();
          if (sign === '-') { block.push(`- ${oldLine} ${clip(text, 2000)}`); oldLine++; }
          else if (sign === '+') { block.push(`+ ${newLine} ${clip(text, 2000)}`); newLine++; }
          else if (sign === ' ') { block.push(`  ${newLine} ${clip(text, 200)}`); oldLine++; newLine++; }
        }
      }
    }
    const text = block.join('\n');
    if (out.length && used + text.length > maxChars) { truncated = true; break; }
    if (!out.length && text.length > maxChars) { out.push(clip(text, maxChars)); truncated = true; detailVersions++; break; }
    out.push(text);
    used += text.length;
    detailVersions++;
  }
  const hints = [];
  if (total > shownVersions.length) hints.push(`показано ${shownVersions.length} из ${total} версий — увеличь limit или сузь since`);
  if (truncated) hints.push(`подробно — ${detailVersions} из ${shownVersions.length} версий (лимит объёма); сузь code или since`);
  return {
    server, source: data.source, syncedAt: data.syncedAt, siteUpdatedAt: meta ? meta.siteUpdatedAt : null,
    stored: data.versions.length, oldest: data.versions.length ? data.versions[data.versions.length - 1].date : null,
    total, shown: shownVersions.length, overview: overview.join('\n'), text: out.join('\n\n'),
    ...(hints.length ? { hint: hints.join('; ') } : {}),
  };
}

function cli(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); if (i < 0) return undefined; const value = rest[i + 1]; rest.splice(i, 2); return value; };
  const json = rest.includes('--json');
  if (json) rest.splice(rest.indexOf('--json'), 1);
  const codeFlag = flag('--code');
  const limitFlag = flag('--limit');
  const print = (value, text) => console.log(json || text === undefined ? JSON.stringify(value, null, 2) : text);
  if (command === 'article') {
    const value = article(rest[0], rest[1], rest[2]);
    return print(value, `# ${value.server} · ${value.code} · ст. ${value.number} (стр. ${value.lines}${value.truncated ? ', обрезано' : ''})\n\n${value.text}`);
  }
  if (command === 'toc') { const value = toc(rest[0], rest[1], rest[2]); return print(value, `# ${value.server} · ${value.code} · ${value.document} · статей: ${value.articles}\n${value.toc}`); }
  if (command === 'search') {
    const value = search(rest[0], rest.slice(1).join(' '), { code: codeFlag, limit: Number(limitFlag) || 10 });
    return print(value, [`# ${value.server}: «${value.query}» — ${value.totalMatches} совп., показано ${value.shown}`, ...value.matches.map((m) => `${m.code}:${m.line} ${m.article || ''}\n  ${m.text}`)].join('\n'));
  }
  if (command === 'list' || !command) { const value = list(rest[0]); return print(value, value.items.map((item) => `${item.server}/${item.code} (${item.modifiedAt.slice(0, 10)})${item.title ? ' ' + item.title : ''}${item.removed ? ' [снят с сайта]' : ''}`).join('\n')); }
  if (command === 'docs') {
    const value = docs(rest[0]);
    return print(value, [`# ${value.server}: ${value.synced ? `синхр. ${msk(value.syncedAt)}, сайт обновлён ${msk(value.siteUpdatedAt) || '—'}` : 'синхронизации не было'}`, ...value.items.map((item) => `${item.code} — ${item.title}${item.lines ? ` · ${item.lines} стр.` : ''}${item.updatedAt ? ` · изм. ${msk(item.updatedAt, false)}` : ''}${item.removed ? ' [снят с сайта]' : ''}${item.localOnly ? ' [только локально]' : ''}`)].join('\n'));
  }
  if (command === 'changes') {
    const sinceFlag = flag('--since');
    const value = changes(rest[0], { since: sinceFlag, code: codeFlag, limit: Number(limitFlag) || 5 });
    return print(value, [`# ${value.server}: изменения (${value.shown} из ${value.total}; синхр. ${msk(value.syncedAt)})`, value.overview, '', value.text, value.hint ? `\n${value.hint}` : ''].join('\n').trim());
  }
  throw new Error('Команды: list [server] | docs <server> | changes <server> [--since 7d] [--code uk] [--limit 5] | toc <server> <code> [префикс] | article <server> <code> <номер> | search <server> <запрос> [--code uk] [--limit 10] [--json]');
}

if (require.main === module) {
  try { cli(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exitCode = 1; }
}

module.exports = { SERVERS, LAWS, files, load, splitArticles, locate, article, toc, search, readRange, list, manifest, changesData, docs, changes, msk, sinceTime };
