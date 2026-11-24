#!/usr/bin/env node
'use strict';

// Синхронизация законов с публичного раздела https://docossum.com/legal/<server>:
// список документов, текст каждого документа и история изменений (/history).
// Только обычные GET публичных страниц с честным User-Agent, последовательно и с паузой.
// Cookie и авторизация не используются; на 403/капчу синхронизация останавливается без обхода.
//
//   node tools/laws-sync.js [houston|miami|all] [--dry-run] [--full] [--json] [--status]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const laws = require('./laws');

const BASE = 'https://docossum.com';
const USER_AGENT = 'MajesticWorkspace/1.0 (+local law sync)';
const MIN_DELAY_MS = 1500;
const TIMEOUT_MS = 30000;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_VERSIONS = 60;
const MAX_ACTION_LINES = 600;
const MAX_LINE_CHARS = 6000;
const HEADER_LINES = 1; // первая строка файла — название документа, дальше строки как в Docossum
// Версия разбора текста: при смене тексты, скачанные прежним разбором, перекачиваются полностью.
// 2 — в текст входят блоки ссылок после основного bbWrapper (как в нумерации истории Docossum).
const PARSER_VERSION = 2;
const LOCK_STALE_MS = 30 * 60 * 1000;
const HISTORY_MARGIN_MS = 10 * 60 * 1000;
const STATUS_FILE = '.sync-status.json';
const LOCK_FILE = '.sync.lock';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function syncError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function checkServer(server) {
  if (!laws.SERVERS.includes(server)) throw syncError(`Сервер: ${laws.SERVERS.join(', ')} или all`, 'BAD_SERVER');
  return server;
}

// ---------------------------------------------------------------- загрузка

let lastRequestAt = 0;

async function readBody(response, limit) {
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) return typeof response.text === 'function' ? response.text() : '';
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        throw syncError('Страница Docossum слишком большая — синхронизация остановлена', 'TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

const CHALLENGE = /cf-chl|challenge-platform|cf_chl_opt|Just a moment\.\.\.|Attention Required|captcha|hcaptcha|turnstile/i;

function blockReason(response, body) {
  const status = response.status;
  const header = (name) => (response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null);
  const looksChallenge = CHALLENGE.test(String(body).slice(0, 20000)) && !String(body).includes('$_TSR');
  if (status === 403) return looksChallenge ? 'HTTP 403, проверка браузера/капча' : 'HTTP 403, доступ запрещён';
  if (status === 429) return `HTTP 429, слишком много запросов${header('retry-after') ? `, Retry-After: ${header('retry-after')}` : ''}`;
  if (header('cf-mitigated') === 'challenge') return `HTTP ${status}, проверка браузера (Cloudflare)`;
  if (looksChallenge && (status === 503 || status === 200)) return `HTTP ${status}, страница проверки браузера/капча`;
  return null;
}

// Один GET публичной страницы docossum.com. Пауза ≥ delayMs между запросами процесса.
async function getPage(url, { fetchImpl = globalThis.fetch, delayMs = MIN_DELAY_MS, timeoutMs = TIMEOUT_MS, retries = 1 } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== 'docossum.com' || target.port || target.username || target.password) throw syncError('Загрузка разрешена только с https://docossum.com', 'BAD_URL');
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    let response;
    let body;
    try {
      response = await fetchImpl(target.href, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'ru-RU,ru;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await readBody(response, MAX_PAGE_BYTES);
    } catch (err) {
      lastRequestAt = Date.now();
      if (err.code === 'TOO_LARGE') throw err;
      const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      if (attempt < retries) { await sleep(delayMs ? 5000 : 0); continue; }
      throw timeout
        ? syncError(`Docossum не ответил за ${Math.round(timeoutMs / 1000)} с: ${target.pathname}`, 'TIMEOUT')
        : syncError(`Сеть: не удалось загрузить ${target.pathname} (${err.cause?.code || err.message})`, 'NETWORK');
    }
    lastRequestAt = Date.now();
    if (response.url) {
      const final = new URL(response.url);
      if (final.hostname !== 'docossum.com') throw syncError(`Docossum перенаправил на ${final.hostname} — синхронизация остановлена`, 'REDIRECT');
    }
    const reason = blockReason(response, body);
    if (reason) throw syncError(`Docossum отклонил запрос (${reason}): ${target.pathname}. Защиту сайта не обходим: повтори позже или открой страницу в браузере.`, 'BLOCKED', { status: response.status });
    if (response.status >= 500 && attempt < retries) { await sleep(delayMs ? 5000 : 0); continue; }
    if (!response.ok) throw syncError(`HTTP ${response.status} при загрузке ${target.pathname}`, response.status === 404 ? 'NOT_FOUND' : `HTTP_${response.status}`, { status: response.status });
    return body;
  }
}

// ---------------------------------------------------------------- SSR-данные (seroval)

// Разбор подмножества JS-литералов из встроенного скрипта TanStack Start ($R[n]=…) без eval.
function unescapeJs(text) {
  return text.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|\r\n|[\s\S])/g, (match, all, cp, u4, x2, oct) => {
    if (cp) { const code = parseInt(cp, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; }
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (x2) return String.fromCharCode(parseInt(x2, 16));
    if (oct) return oct === '0' ? '\0' : String.fromCharCode(parseInt(oct, 8));
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\n': '', '\r': '', '\r\n': '' };
    if (all.length === 1 && (all.charCodeAt(0) === 0x2028 || all.charCodeAt(0) === 0x2029)) return '';
    return Object.hasOwn(simple, all) ? simple[all] : all;
  });
}

const STRING_RE = { '"': /"((?:[^"\\]|\\[\s\S])*)"/y, "'": /'((?:[^'\\]|\\[\s\S])*)'/y };
const NUMBER_RE = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_$][\w$]*/y;
const REF_RE = /\$R\[(\d+)\]/y;
const KEYWORDS = [['!0', true], ['!1', false], ['null', null], ['void 0', undefined], ['undefined', undefined], ['true', true], ['false', false], ['-Infinity', -Infinity], ['Infinity', Infinity], ['NaN', NaN]];

function parseLiteral(src, start, refs = new Map()) {
  let i = start;
  const fail = (what) => { throw new SyntaxError(`SSR: ${what} @${i}`); };
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const sticky = (re) => { re.lastIndex = i; const m = re.exec(src); if (m) i = re.lastIndex; return m; };
  function value(depth) {
    if (depth > 80) fail('слишком глубокая вложенность');
    ws();
    const c = src[i];
    if (c === '$') {
      const m = sticky(REF_RE);
      if (!m) fail('ожидалась ссылка $R');
      const n = Number(m[1]);
      if (src[i] === '=' && src[i + 1] !== '=') { i++; const v = value(depth + 1); refs.set(n, v); return v; }
      return refs.has(n) ? refs.get(n) : { $ref: n };
    }
    if (c === '{') {
      i++;
      const out = {};
      for (;;) {
        ws();
        if (src[i] === '}') { i++; return out; }
        let key;
        if (src[i] === '"' || src[i] === "'") { const m = sticky(STRING_RE[src[i]]); if (!m) fail('ключ'); key = unescapeJs(m[1]); }
        else { const m = sticky(IDENT_RE) || sticky(NUMBER_RE); if (!m) fail('ключ'); key = m[0]; }
        ws();
        if (src[i] !== ':') fail('ожидалось «:»');
        i++;
        const v = value(depth + 1);
        if (key !== '__proto__') out[key] = v;
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return out; }
        fail('ожидалось «,» или «}»');
      }
    }
    if (c === '[') {
      i++;
      const out = [];
      for (;;) {
        ws();
        if (src[i] === ']') { i++; return out; }
        if (src[i] === ',') { i++; out.push(undefined); continue; }
        out.push(value(depth + 1));
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return out; }
        fail('ожидалось «,» или «]»');
      }
    }
    if (c === '"' || c === "'") { const m = sticky(STRING_RE[c]); if (!m) fail('строка'); return unescapeJs(m[1]); }
    if (src.startsWith('new Date(', i)) {
      i += 9; ws();
      const m = src[i] === '"' ? sticky(STRING_RE['"']) : sticky(NUMBER_RE);
      if (!m) fail('дата');
      ws();
      if (src[i] !== ')') fail('ожидалось «)»');
      i++;
      return m[1] !== undefined ? unescapeJs(m[1]) : new Date(Number(m[0])).toISOString();
    }
    for (const [word, v] of KEYWORDS) if (src.startsWith(word, i) && !/[\w$]/.test(src[i + word.length] || '')) { i += word.length; return v; }
    const m = sticky(NUMBER_RE);
    if (m) return Number(m[0]);
    return fail('неподдерживаемое значение');
  }
  const result = value(0);
  return { value: result, end: i };
}

function inlineScripts(html) {
  return [...String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/type\s*=\s*["']?application\/ld\+json/i.test(m[1]))
    .map((m) => m[2]);
}

// Все объекты-литералы скриптов, начинающиеся с заданного ключа: { key: … }.
function collectObjects(html, key) {
  const out = [];
  const pattern = new RegExp(`\\{(?=${key.replace(/[$]/g, '\\$')}:)`, 'g');
  for (const script of inlineScripts(html)) {
    pattern.lastIndex = 0;
    for (let m; (m = pattern.exec(script));) {
      try {
        const { value, end } = parseLiteral(script, m.index);
        out.push(value);
        pattern.lastIndex = end;
      } catch { /* не литерал данных — пропускаем */ }
    }
  }
  return out;
}

function jsonLd(html) {
  for (const m of String(html).matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const data = JSON.parse(m[1]); if (data && typeof data === 'object') return data; } catch { /* битый JSON-LD */ }
  }
  return null;
}

// "2026-11-04 02:16:16.952745+00" → ISO UTC.
function isoDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const m = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i);
  let date;
  if (m) {
    let zone = m[4] || 'Z';
    if (/^[+-]\d{2}$/.test(zone)) zone += ':00';
    else if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ':' + zone.slice(3);
    date = new Date(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ''}${zone}`);
  } else date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---------------------------------------------------------------- HTML → строки

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', bdquo: '„', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', minus: '−', hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', sect: '§', deg: '°', times: '×', numero: '№',
  shy: '', zwsp: '', zwj: '', zwnj: '', lrm: '', rlm: '', thinsp: ' ', ensp: ' ', emsp: ' ',
};

function decodeEntities(text) {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    const value = ENTITIES[entity.toLowerCase()];
    return value === undefined ? match : value;
  });
}

// Классы символов строим из кодов: невидимые символы не должны попадать в исходник буквально.
const charClass = (...items) => `[${items.map((item) => (Array.isArray(item) ? `${String.fromCodePoint(item[0])}-${String.fromCodePoint(item[1])}` : String.fromCodePoint(item))).join('')}]`;
const INVISIBLE = new RegExp(charClass(0xad, 0x180e, [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], 0xfeff), 'g');
const SPACES = new RegExp(charClass(0xa0, [0x2000, 0x200a], 0x202f, 0x205f, 0x3000, 0x09), 'g');
const LINE_SEPARATORS = new RegExp(charClass(0x2028, 0x2029), 'g');
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const BLOCK_TAGS = 'div|p|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|pre|tr|table|thead|tbody|tfoot|caption|section|article|header|footer|aside|nav|hr|figure|figcaption|details|summary';

// Строки текста в порядке Docossum: блоки и <br> — переводы строк, пустые строки убраны.
// Нумерация совпадает с нумерацией строк в истории изменений Docossum.
function htmlToLines(fragment) {
  let text = String(fragment)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|button)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]*>/g, '');
  text = decodeEntities(text).replace(LINE_SEPARATORS, '\n').replace(INVISIBLE, '').replace(SPACES, ' ');
  return text.split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').replace(/^(?:\s*\|)+\s*|(?:\s*\|)+\s*$/g, '').trim())
    .filter(Boolean)
    .map((line) => (line.length > 100000 ? line.slice(0, 100000) : line));
}

// Внутренность <div>, открытого тегом в позиции start, до парного </div>.
function divInner(body, start, openLength) {
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = start;
  let depth = 0;
  for (let m; (m = tag.exec(body));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return body.slice(start + openLength, m.index);
  }
  return body.slice(start + openLength);
}

const stripScripts = (html) => String(html).replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');

// Содержимое <div class="bbWrapper"> до парного </div>.
function bbWrapper(html) {
  const body = stripScripts(html);
  const open = /<div\b[^>]*\bclass\s*=\s*"[^"]*\bbbWrapper\b[^"]*"[^>]*>/i.exec(body);
  return open ? divInner(body, open.index, open[0].length) : null;
}

const UPDATED_NOTE = /<span\b[^>]*>\s*Обновлен\b[\s\S]*?<\/span>\s*$/i;

// Текст закона так, как его нумерует Docossum: основной bbWrapper и следующие за ним блоки
// (ссылки на приложения и черновики), без подписи «Обновлен …».
// 1) SSR-данные страницы { html: "<div><div class=bbWrapper>…" } — ровно содержимое документа;
// 2) весь контейнер forumPreview/readingText в разметке; 3) первый bbWrapper.
function lawFragment(html) {
  let ssr = null;
  for (const item of collectObjects(html, 'html')) {
    if (item && typeof item.html === 'string' && /\bbbWrapper\b/.test(item.html) && (!ssr || item.html.length > ssr.length)) ssr = item.html;
  }
  if (ssr) return ssr;
  const body = stripScripts(html);
  const wrapper = /<div\b[^>]*\bclass\s*=\s*"[^"]*\bbbWrapper\b[^"]*"[^>]*>/i.exec(body);
  if (!wrapper) return null;
  const container = /<div\b[^>]*\bclass\s*=\s*"[^"]*\b(?:forumPreview|readingText)\b[^"]*"[^>]*>/gi;
  let found = null;
  for (let m; (m = container.exec(body)) && m.index < wrapper.index;) found = m;
  if (found) {
    const inner = divInner(body, found.index, found[0].length);
    if (/\bbbWrapper\b/.test(inner)) return inner.replace(UPDATED_NOTE, '');
  }
  return divInner(body, wrapper.index, wrapper[0].length);
}

// ---------------------------------------------------------------- разбор страниц

function cleanTitle(value) {
  return decodeEntities(String(value || '')).replace(INVISIBLE, '').replace(SPACES, ' ').replace(/\s+/g, ' ').trim();
}

// Список документов /legal/<server>: SSR-данные, иначе ссылки страницы.
function parseServerList(html, server) {
  checkServer(server);
  const documents = [];
  const seen = new Set();
  let info = null;
  for (const item of collectObjects(html, 'id')) {
    if (!item || typeof item !== 'object') continue;
    if (item.key === server && (item.lastParsedAt || item.versionId) && !item.serverKey) {
      info = { name: item.name || server, versionId: item.versionId || null, lastParsedAt: isoDate(item.lastParsedAt) };
      continue;
    }
    if (item.serverKey !== server || !Number.isSafeInteger(item.id) || !item.title || seen.has(item.id)) continue;
    seen.add(item.id);
    documents.push({
      id: item.id,
      guid: item.guid === undefined || item.guid === null ? null : String(item.guid),
      title: cleanTitle(item.title),
      versionId: item.versionId || null,
      forumUrl: typeof item.url === 'string' && /^https:\/\/forum\.majestic-rp\.ru\//.test(item.url) ? item.url : null,
      supplementary: item.isSupplementary === true,
      createdAt: isoDate(item.createdAt),
    });
  }
  let source = 'ssr';
  if (!documents.length) {
    source = 'html';
    const body = String(html).replace(/<script\b[\s\S]*?<\/script>/gi, '');
    const link = new RegExp(`<a\\b[^>]*href="(?:https://docossum\\.com)?/legal/${server}/document/(\\d+)/?"[^>]*>([\\s\\S]*?)</a>`, 'gi');
    for (const m of body.matchAll(link)) {
      const id = Number(m[1]);
      const title = cleanTitle(m[2].replace(/<svg\b[\s\S]*?<\/svg>/gi, '').replace(/<[^>]*>/g, ' '));
      if (!title || seen.has(id)) continue;
      seen.add(id);
      documents.push({ id, guid: null, title, versionId: null, forumUrl: null, supplementary: false, createdAt: null });
    }
  }
  const updated = /Последнее обновление(?:\s|<!--[\s\S]*?-->)*([^<]{3,60})</.exec(String(html).replace(/<script\b[\s\S]*?<\/script>/gi, ''));
  return { server, source, info, updatedText: updated ? cleanTitle(updated[1]) : null, documents };
}

// Страница документа: строки текста, заголовок, дата из JSON-LD, запись файла из SSR.
function parseDocument(html, { id } = {}) {
  const fragment = lawFragment(html);
  if (fragment === null) throw syncError('На странице документа нет текста закона (блок bbWrapper) — структура Docossum изменилась', 'PARSE');
  const lines = htmlToLines(fragment);
  const ld = jsonLd(html);
  const record = id === undefined ? null : collectObjects(html, 'id').find((item) => item && item.id === id && item.serverKey) || null;
  return {
    lines,
    headline: ld && typeof ld.headline === 'string' ? cleanTitle(ld.headline) : null,
    datePublished: ld ? isoDate(ld.datePublished) : null,
    guid: record && record.guid !== undefined && record.guid !== null ? String(record.guid) : null,
    versionId: record ? record.versionId || null : null,
  };
}

function clip(text, max = MAX_LINE_CHARS) {
  const value = String(text);
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.action !== 'string') return null;
  const file = raw.file && typeof raw.file === 'object' ? raw.file : {};
  const guid = raw.guid ?? file.guid;
  const fileId = raw.fileId ?? file.id;
  const action = { action: raw.action, guid: guid === undefined || guid === null ? null : String(guid), fileId: Number.isSafeInteger(fileId) ? fileId : null, title: cleanTitle(raw.title ?? file.title ?? '') };
  if (Array.isArray(raw.diff)) {
    let budget = MAX_ACTION_LINES;
    action.hunks = [];
    for (const hunk of raw.diff) {
      if (!hunk || typeof hunk !== 'object' || !Array.isArray(hunk.lines)) continue;
      if (budget <= 0) { action.truncated = true; break; }
      // Знак строки (« », «-», «+») сохраняем, текст чистим так же, как строки документа.
      const lines = hunk.lines.filter((line) => typeof line === 'string' && line.length).map((line) => clip(line[0] + line.slice(1).replace(INVISIBLE, '').replace(SPACES, ' ').replace(/[\r\n]+/g, ' ').replace(/ {2,}/g, ' ')));
      if (lines.length > budget) action.truncated = true;
      action.hunks.push({ oldStart: Number(hunk.oldStart) || 0, oldLines: Number(hunk.oldLines) || 0, newStart: Number(hunk.newStart) || 0, newLines: Number(hunk.newLines) || 0, lines: lines.slice(0, budget) });
      budget -= lines.length;
    }
  }
  return action;
}

// Новые первыми; версии без даты — в конце.
const byDateDesc = (a, b) => (a.date === b.date ? 0 : !a.date ? 1 : !b.date ? -1 : a.date < b.date ? 1 : -1);

// История /legal/<server>/history: версии с действиями и diff-ханками, новые первыми.
function parseHistory(html) {
  const byVersion = new Map();
  for (const item of collectObjects(html, 'version')) {
    if (!item || typeof item.version !== 'string' || !Array.isArray(item.actions)) continue;
    byVersion.set(item.version, { version: item.version, date: isoDate(item.createdAt), actions: item.actions.map(normalizeAction).filter(Boolean) });
  }
  return [...byVersion.values()].sort(byDateDesc);
}

// ---------------------------------------------------------------- коды файлов

const normalizeTitle = (text) => cleanTitle(text).toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/['’`ʼ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Прежние коды локальных файлов: сопоставление по названию, если нет ни manifest, ни совпадения первой строки.
const KNOWN_CODES = [
  [/^конституция$/, 'konstituciya'],
  [/^уголовный кодекс$/, 'uk'],
  [/^(уголовно )?процессуальный кодекс$/, 'upk'],
  [/^административный кодекс$/, 'administrativnyy'],
  [/^этический кодекс$/, 'eticheskiy'],
  [/^гражданский кодекс$/, 'grazhdanskiy'],
  [/^трудовой кодекс/, 'tk'],
  [/^закон об? адвокат/, 'ob_advokature'],
  [/^(конституционный )?закон о деятельности офиса генерального прокурора/, 'ofis_gp'],
  [/^закон о системе ордеров/, 'sistema_orderov'],
  [/^(конституционный )?закон о судебной системе/, { houston: 'sz_o_sudebnoy_sisteme', miami: 'sudebnaya_sistema' }],
  [/^закон о правовых терминах/, 'pravovye_terminy'],
  [/^закон о территориальной юрисдикции/, 'territorialnaya_yurisdikciya'],
];

function knownCode(title, server) {
  const value = normalizeTitle(title);
  for (const [pattern, code] of KNOWN_CODES) if (pattern.test(value)) return typeof code === 'string' ? code : code[server] || null;
  return null;
}

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'c', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const STOP_WORDS = new Set(['закон', 'законы', 'конституционный', 'о', 'об', 'обо', 'и', 'в', 'во', 'на', 'к', 'ко', 'по', 'для', 'с', 'со', 'от', 'из', 'за', 'а', 'или', 'при', 'штата', 'штате', 'штат', 'сан', 'андреас', 'san', 'andreas', 'деятельности', 'деятельность', 'внутренний', 'внутреннего', 'the', 'of', 'n']);
const translit = (word) => [...word].map((ch) => TRANSLIT[ch] ?? ch).join('').replace(/[^a-z0-9]/g, '');

// Короткий код из ключевых слов названия: латиница, [a-z0-9_], не длиннее 40 символов.
function makeCode(title) {
  const words = normalizeTitle(title).split(' ').filter(Boolean);
  let main = words.filter((word) => !STOP_WORDS.has(word));
  if (main.some((word) => !/^кодекс/.test(word))) main = main.filter((word) => !/^кодекс/.test(word));
  if (!main.length) main = words;
  let code = '';
  for (const part of main.map(translit).filter(Boolean)) {
    const next = code ? `${code}_${part}` : part;
    if (next.length > 40) { if (!code) code = part.slice(0, 40); break; }
    code = next;
  }
  return code || 'dokument';
}

function uniqueCode(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const code = base.slice(0, 40 - suffix.length) + suffix;
    if (!taken.has(code)) return code;
  }
}

function firstLine(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return stripBom(buffer.toString('utf8', 0, size)).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// guid → код. Порядок: manifest по guid; перенос кода документа, перевыложенного под новым guid;
// локальный файл с тем же названием; известное соответствие; новый транслит-код.
function assignCodes(documents, { server, previous = null, localFiles = [] } = {}) {
  const prevDocs = Array.isArray(previous?.documents) ? previous.documents : [];
  const presentGuids = new Set(documents.map((doc) => doc.guid).filter(Boolean));
  const byGuid = new Map(prevDocs.filter((item) => item.guid).map((item) => [String(item.guid), item]));
  const managed = new Set(prevDocs.filter((item) => !item.localOnly).map((item) => item.code));
  const taken = new Set([...prevDocs.map((item) => item.code), ...localFiles.map((item) => item.code)]);
  const result = new Map();
  const assigned = new Set();
  const keyOf = (doc) => doc.guid || `id:${doc.id}`;
  const claim = (doc, code) => { result.set(keyOf(doc), code); assigned.add(code); taken.add(code); };
  for (const doc of documents) {
    const prev = doc.guid && byGuid.get(doc.guid);
    if (prev && !assigned.has(prev.code)) claim(doc, prev.code);
  }
  const free = (code) => code && !assigned.has(code) && !prevDocs.some((item) => item.code === code && item.guid && presentGuids.has(String(item.guid)));
  for (const doc of documents) {
    if (result.has(keyOf(doc))) continue;
    const title = normalizeTitle(doc.title);
    const moved = prevDocs.find((item) => !item.localOnly && normalizeTitle(item.title) === title && !(item.guid && presentGuids.has(String(item.guid))) && free(item.code));
    if (moved) claim(doc, moved.code);
  }
  const localByTitle = new Map();
  for (const item of localFiles) if (!managed.has(item.code) && item.title) {
    const title = normalizeTitle(item.title);
    if (!localByTitle.has(title)) localByTitle.set(title, item.code);
  }
  for (const doc of documents) {
    if (result.has(keyOf(doc))) continue;
    const code = localByTitle.get(normalizeTitle(doc.title));
    if (free(code)) claim(doc, code);
  }
  for (const doc of documents) {
    if (result.has(keyOf(doc))) continue;
    const code = knownCode(doc.title, server);
    if (free(code) && (!managed.has(code) || prevDocs.some((item) => item.code === code && item.removed))) claim(doc, code);
  }
  for (const doc of documents) {
    if (result.has(keyOf(doc))) continue;
    claim(doc, uniqueCode(makeCode(doc.title), taken));
  }
  return result;
}

// ---------------------------------------------------------------- файлы

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content);
  try { fs.renameSync(temp, file); } catch (err) {
    // OneDrive/антивирус может держать файл: повторяем через копирование.
    try { fs.copyFileSync(temp, file); fs.rmSync(temp, { force: true }); } catch { fs.rmSync(temp, { force: true }); throw err; }
  }
}

const dateStamp = (iso) => (iso ? String(iso).slice(0, 10) : new Date().toISOString().slice(0, 10));

// Прежняя редакция → .versions/<code>@<дата>.txt, если такой же редакции там ещё нет.
function archiveVersion(serverDir, code, oldText, { stamp, versionId }) {
  const dir = path.join(serverDir, '.versions');
  const hash = sha256(oldText);
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith(`${code}@`) || !file.endsWith('.txt')) continue;
      try { if (sha256(fs.readFileSync(path.join(dir, file), 'utf8')) === hash) return null; } catch { /* пропускаем нечитаемый */ }
    }
  }
  const variants = [stamp, versionId ? `${stamp}_${String(versionId).slice(0, 8)}` : null].filter(Boolean);
  let name = variants.map((item) => `${code}@${item}.txt`).find((item) => !fs.existsSync(path.join(dir, item)));
  for (let n = 2; !name; n++) if (!fs.existsSync(path.join(dir, `${code}@${stamp}_${n}.txt`))) name = `${code}@${stamp}_${n}.txt`;
  writeAtomic(path.join(dir, name), oldText);
  return `.versions/${name}`;
}

function localFiles(serverDir) {
  if (!fs.existsSync(serverDir)) return [];
  return fs.readdirSync(serverDir).filter((file) => /^[a-z0-9_-]+\.txt$/i.test(file)).sort().map((file) => {
    const fullPath = path.join(serverDir, file);
    return { code: file.slice(0, -4), fullPath, title: firstLine(fullPath), mtime: fs.statSync(fullPath).mtime.toISOString() };
  });
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Блокировка живая, если процесс жив и отмечался (updatedAt, иначе startedAt) не дольше LOCK_STALE_MS назад.
function lockFresh(lock, now = Date.now()) {
  if (!lock || !pidAlive(lock.pid)) return false;
  const beat = Date.parse(lock.updatedAt || lock.startedAt);
  return Number.isFinite(beat) && now - beat < LOCK_STALE_MS;
}

// Идущая синхронизация (в т.ч. запущенная из CLI без статуса) или null.
function lockInfo(dir = laws.LAWS) {
  const lock = readJsonFile(path.join(dir, LOCK_FILE));
  return lockFresh(lock) ? { pid: lock.pid, startedAt: lock.startedAt || null, updatedAt: lock.updatedAt || lock.startedAt || null } : null;
}

// Один процесс синхронизации на каталог законов. Возвращает release(); release.touch() — отметка «жив».
function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    const startedAt = new Date().toISOString();
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt }), { flag: 'wx' });
      const release = () => { try { const lock = readJsonFile(file); if (!lock || (lock.pid === process.pid && lock.startedAt === startedAt)) fs.rmSync(file, { force: true }); } catch { /* уже снят */ } };
      release.touch = () => {
        try {
          const lock = readJsonFile(file);
          if (lock && lock.pid === process.pid && lock.startedAt === startedAt) fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt, updatedAt: new Date().toISOString() }));
        } catch { /* отметка не критична */ }
      };
      return release;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const raw = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } })();
      let lock = null;
      try { lock = raw === null ? null : JSON.parse(raw); } catch { lock = null; }
      if (lockFresh(lock)) throw syncError(`Синхронизация законов уже идёт (pid ${lock.pid}, с ${lock.startedAt}); дождись окончания`, 'BUSY');
      // Пустой файл мог только что создать другой процесс и ещё не дописать.
      if (!lock && raw !== null) { try { if (Date.now() - fs.statSync(file).mtimeMs < 5000) throw syncError('Синхронизация законов уже запускается; дождись окончания', 'BUSY'); } catch (statErr) { if (statErr.code === 'BUSY') throw statErr; } }
      // Снимаем зависшую блокировку, только если её не успел заменить другой процесс.
      try { if (raw === null || fs.readFileSync(file, 'utf8') === raw) fs.rmSync(file, { force: true }); } catch { /* уже снята */ }
    }
  }
  throw syncError('Не удалось захватить блокировку синхронизации', 'BUSY');
}

// ---------------------------------------------------------------- синхронизация сервера

function historyDates(versions) {
  const latest = new Map();
  for (const version of versions) for (const action of version.actions) {
    if (!action.guid || !['changed', 'added'].includes(action.action) || !version.date) continue;
    if (!latest.has(action.guid) || latest.get(action.guid) < version.date) latest.set(action.guid, version.date);
  }
  return latest;
}

function mergeVersions(previous, fresh) {
  const map = new Map();
  for (const version of [...(previous || []), ...fresh]) if (version && version.version) map.set(version.version, version);
  return [...map.values()].sort(byDateDesc).slice(0, MAX_VERSIONS);
}

async function syncServer(server, options = {}) {
  checkServer(server);
  const dir = path.resolve(options.dir || laws.LAWS);
  const serverDir = path.join(dir, server);
  const dryRun = Boolean(options.dryRun);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const fetchImpl = options.fetchImpl || options.fetch || globalThis.fetch;
  const get = (url) => getPage(url, { fetchImpl, delayMs: options.delayMs ?? MIN_DELAY_MS, timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const listUrl = `${BASE}/legal/${server}`;
  const historyUrl = `${BASE}/legal/${server}/history`;
  const manifestFile = path.join(serverDir, 'manifest.json');
  const changesFile = path.join(serverDir, 'changes.json');
  const previous = readJsonFile(manifestFile);
  const previousChanges = readJsonFile(changesFile);
  const report = { server, source: listUrl, dryRun, mode: 'full', siteUpdatedAt: null, documents: 0, fetched: 0, added: [], changed: [], unchanged: 0, removed: [], restored: [], archived: [], errors: [], versions: 0, newVersions: 0 };

  progress({ server, step: 'list', done: 0, total: null });
  const list = parseServerList(await get(listUrl), server);
  if (!list.documents.length) throw syncError(`На ${listUrl} не найден список документов — структура страницы изменилась`, 'PARSE');
  report.siteUpdatedAt = list.info?.lastParsedAt || null;
  const siteVersionId = list.info?.versionId || null;
  const sameParser = previous?.parser === PARSER_VERSION;
  // Тот же снимок сайта (versionId не сменился) и тот же разбор — на сайте ничего не менялось.
  const sameSnapshot = Boolean(sameParser && siteVersionId && previous?.siteVersionId === siteVersionId);

  // История меняется только с новым снимком: при том же снимке лишний запрос не делаем.
  let history = [];
  let historyOk = false;
  if (!options.full && sameSnapshot && previousChanges?.siteVersionId === siteVersionId) report.historySkipped = true;
  else {
    progress({ server, step: 'history', done: 0, total: null });
    try {
      history = parseHistory(await get(historyUrl));
      if (history.length) historyOk = true;
      else report.errors.push({ document: 'history', error: 'На странице истории не найдено версий — структура страницы могла измениться' });
    } catch (err) {
      if (err.code === 'BLOCKED') throw err;
      report.errors.push({ document: 'history', error: err.message });
    }
  }

  // Документы без guid (резервный разбор HTML) — guid берём со страницы документа.
  const pending = new Map();
  for (const doc of list.documents.filter((item) => !item.guid)) {
    try {
      const parsed = parseDocument(await get(`${BASE}/legal/${server}/document/${doc.id}`), { id: doc.id });
      doc.guid = parsed.guid || `id-${doc.id}`;
      pending.set(doc.id, { parsed });
    } catch (err) {
      if (err.code === 'BLOCKED') throw err;
      doc.guid = `id-${doc.id}`;
      pending.set(doc.id, { error: err });
    }
  }

  const files = localFiles(serverDir);
  const codes = assignCodes(list.documents, { server, previous, localFiles: files });
  const prevDocs = Array.isArray(previous?.documents) ? previous.documents : [];
  const prevByGuid = new Map(prevDocs.filter((item) => item.guid).map((item) => [String(item.guid), item]));
  const prevByCode = new Map(prevDocs.map((item) => [item.code, item]));
  const fileByCode = new Map(files.map((item) => [item.code, item]));

  // Инкрементально: качаем только изменённые по истории, новые, недокачанные и испорченные локально.
  const prevPoint = previous?.siteUpdatedAt ? Date.parse(previous.siteUpdatedAt) : NaN;
  const oldest = history.length ? Date.parse(history[history.length - 1].date) : NaN;
  const covered = Number.isFinite(prevPoint) && Number.isFinite(oldest) && oldest <= prevPoint - HISTORY_MARGIN_MS;
  const incremental = Boolean(!options.full && previous && sameParser && (sameSnapshot || covered));
  const touched = new Set();
  if (incremental) for (const version of history) {
    if (Date.parse(version.date) <= prevPoint - HISTORY_MARGIN_MS) continue;
    for (const action of version.actions) if (action.guid) touched.add(action.guid);
  }
  const fileOk = (code, entry) => {
    const file = fileByCode.get(code);
    if (!file || !entry?.sha256) return false;
    try { return sha256(fs.readFileSync(file.fullPath, 'utf8')) === entry.sha256; } catch { return false; }
  };
  const plan = list.documents.map((doc) => {
    const code = codes.get(doc.guid || `id:${doc.id}`);
    // prev по коду — документ перевыложен под новым guid (код перенесён с прежнего).
    const prev = prevByGuid.get(doc.guid) || (prevByCode.get(code)?.localOnly ? null : prevByCode.get(code)) || null;
    const needed = !incremental || !prev || String(prev.guid) !== String(doc.guid) || prev.removed || prev.stale || prev.code !== code || prev.title !== doc.title || touched.has(doc.guid) || !fileOk(code, prev);
    return { doc, code, prev, fetch: needed };
  });
  report.mode = incremental ? (plan.some((item) => item.fetch) ? 'incremental' : 'unchanged') : 'full';
  report.documents = plan.length;

  const latestDates = historyDates(mergeVersions(previousChanges?.versions, history));
  const writes = new Map();
  const total = plan.filter((item) => item.fetch).length;
  let done = 0;
  for (const item of plan) {
    if (!item.fetch) { report.unchanged++; continue; }
    progress({ server, step: 'document', done, total, current: item.doc.title });
    try {
      const cached = pending.get(item.doc.id);
      if (cached?.error) throw cached.error;
      const parsed = cached ? cached.parsed : parseDocument(await get(`${BASE}/legal/${server}/document/${item.doc.id}`), { id: item.doc.id });
      if (parsed.lines.length < 2 || parsed.lines.join('').length < 40) throw syncError('Текст документа пустой или слишком короткий — файл не перезаписан', 'PARSE');
      const text = [item.doc.title, ...parsed.lines].join('\n') + '\n';
      writes.set(item.code, { text, lines: parsed.lines.length + HEADER_LINES });
      report.fetched++;
    } catch (err) {
      if (err.code === 'BLOCKED') throw err;
      report.errors.push({ code: item.code, title: item.doc.title, error: err.message });
    }
    done++;
  }
  progress({ server, step: 'write', done, total });

  // Сборка manifest.
  const entries = [];
  for (const item of plan) {
    const { doc, code, prev } = item;
    const write = writes.get(code);
    const entry = {
      code, title: doc.title, id: doc.id, guid: doc.guid, versionId: doc.versionId || siteVersionId,
      url: `${BASE}/legal/${server}/document/${doc.id}`, forumUrl: doc.forumUrl || prev?.forumUrl || null,
      ...(doc.supplementary ? { supplementary: true } : {}),
      updatedAt: latestDates.get(doc.guid) || prev?.updatedAt || null,
      lines: prev?.lines ?? null, chars: prev?.chars ?? null, sha256: prev?.sha256 ?? null,
    };
    if (write) {
      const file = path.join(serverDir, `${code}.txt`);
      const oldText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const hash = sha256(write.text);
      const differs = oldText === null || sha256(oldText) !== hash;
      entry.lines = write.lines;
      entry.chars = write.text.length;
      entry.sha256 = hash;
      if (oldText === null) report.added.push({ code, title: doc.title });
      else if (differs) {
        const changed = { code, title: doc.title, ...(prev ? {} : { firstSync: true }) };
        if (!dryRun) {
          const archived = archiveVersion(serverDir, code, oldText, { stamp: dateStamp(prev?.updatedAt || fileByCode.get(code)?.mtime), versionId: prev?.versionId });
          if (archived) { changed.archived = archived; report.archived.push(archived); }
        }
        report.changed.push(changed);
      } else report.unchanged++;
      if (!dryRun && differs) writeAtomic(file, write.text);
      if (prev?.removed) report.restored.push({ code, title: doc.title });
    } else if (item.fetch) {
      // Не скачался: оставляем прежние данные и помечаем — следующая синхронизация скачает снова,
      // даже если по истории изменение уже «старое».
      entry.stale = true;
    }
    entries.push(entry);
  }
  const presentCodes = new Set(entries.map((item) => item.code));
  for (const prev of prevDocs) {
    if (presentCodes.has(prev.code)) continue;
    if (prev.localOnly && !fileByCode.has(prev.code)) continue;
    const entry = { ...prev };
    if (!prev.localOnly && !prev.removed) { entry.removed = true; entry.removedAt = now; report.removed.push({ code: prev.code, title: prev.title }); }
    entries.push(entry);
    presentCodes.add(prev.code);
  }
  for (const file of files) {
    if (presentCodes.has(file.code)) continue;
    entries.push({ code: file.code, title: file.title || file.code, localOnly: true, note: 'нет на сайте Docossum при синхронизации' });
  }

  // История изменений: коды по guid из итогового manifest.
  const codeByGuid = new Map(entries.filter((item) => item.guid).map((item) => [String(item.guid), item.code]));
  const previousIds = new Set((previousChanges?.versions || []).map((item) => item.version));
  const versions = mergeVersions(previousChanges?.versions, history).map((version) => ({
    ...version,
    actions: version.actions.map((action) => ({ ...action, code: (action.guid && codeByGuid.get(String(action.guid))) || action.code || null })),
  }));
  report.versions = versions.length;
  report.newVersions = history.filter((item) => !previousIds.has(item.version)).length;

  const manifest = {
    server, source: listUrl, history: historyUrl, syncedAt: now, siteUpdatedAt: report.siteUpdatedAt || previous?.siteUpdatedAt || null,
    siteVersionId, mode: report.mode, parser: PARSER_VERSION, headerLines: HEADER_LINES,
    format: 'Первая строка — название документа, далее строки текста Docossum без пустых; «Статья N.» и «ч. N» — отдельными строками. Номер строки файла = номер строки в истории Docossum + 1.',
    documents: entries,
  };
  if (!dryRun) {
    writeAtomic(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
    // siteVersionId истории — снимок, для которого история скачана целиком (иначе прежний).
    const historyVersionId = historyOk ? siteVersionId : report.historySkipped ? previousChanges?.siteVersionId || null : null;
    writeAtomic(changesFile, JSON.stringify({ server, source: historyUrl, syncedAt: now, siteVersionId: historyVersionId, headerLines: HEADER_LINES, versions }, null, 1) + '\n');
  }
  report.codes = Object.fromEntries(entries.filter((item) => !item.localOnly).map((item) => [item.code, item.title]));
  return { report, manifest };
}

// ---------------------------------------------------------------- INDEX.md

function mskShort(iso, withTime = true) {
  if (!iso) return '—';
  const date = new Date(Date.parse(iso) + 3 * 3600 * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
  return withTime ? `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} МСК` : day;
}

const groupDigits = (n) => (Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '—');
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function writeIndex(dir = laws.LAWS) {
  const out = [
    '# Правовая база Majestic (синхронизация с Docossum)',
    '',
    'Обновление: `node tools/laws-sync.js [houston|miami|all]` (MCP: `law_sync`); что изменилось — `law_changes`. Источник — публичный раздел `https://docossum.com/legal/<server>`, история — `/legal/<server>/history`.',
    '',
    'Законы серверов **разные** — Houston и Miami считаются по своим кодексам, не путать.',
    '',
    'Формат `.txt`: первая строка — название документа, дальше строки текста как на сайте (без пустых); «Статья N.» и «ч. N» — отдельными строками. Номер строки файла = номер строки в истории Docossum + 1. Прежние редакции — `<server>/.versions/<код>@<дата>.txt`; документы, снятые с сайта, не удаляются (`removed` в `manifest.json`).',
  ];
  for (const server of laws.SERVERS) {
    const serverDir = path.join(dir, server);
    const manifest = readJsonFile(path.join(serverDir, 'manifest.json'));
    const changes = readJsonFile(path.join(serverDir, 'changes.json'));
    const versionsDir = path.join(serverDir, '.versions');
    const archived = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir).filter((file) => file.endsWith('.txt')) : [];
    out.push('', `## ${server[0].toUpperCase()}${server.slice(1)} — \`majestic/laws/${server}/\``, '');
    if (!manifest) {
      const files = localFiles(serverDir);
      out.push('Синхронизация ещё не выполнялась: локальные копии без проверки актуальности.', '', '| Код | Документ |', '|---|---|');
      for (const file of files) out.push(`| \`${file.code}\` | ${cell(file.title)} |`);
      continue;
    }
    const docs = manifest.documents || [];
    const active = docs.filter((item) => !item.removed && !item.localOnly);
    const removed = docs.filter((item) => item.removed);
    out.push(`Синхронизация: ${mskShort(manifest.syncedAt)} · сайт обновлён: ${mskShort(manifest.siteUpdatedAt)} · документов на сайте: ${active.length}${removed.length ? ` (снято: ${removed.length})` : ''} · версий истории: ${changes?.versions?.length || 0} · прежних редакций: ${archived.length} · источник: ${manifest.source}`, '');
    out.push('| Код | Документ | Строк | Символов | Изменён | Примечание |', '|---|---|---|---|---|---|');
    for (const item of docs) {
      const notes = [];
      if (item.supplementary) notes.push('устав/доп.');
      if (item.removed) notes.push(`снят с сайта ${mskShort(item.removedAt, false)}`);
      if (item.localOnly) notes.push('только локально');
      const count = archived.filter((file) => file.startsWith(`${item.code}@`)).length;
      if (count) notes.push(`ред. в .versions: ${count}`);
      out.push(`| \`${item.code}\` | ${cell(item.title)} | ${groupDigits(item.lines)} | ${groupDigits(item.chars)} | ${item.updatedAt ? mskShort(item.updatedAt, false) : '—'} | ${notes.join('; ')} |`);
    }
  }
  writeAtomic(path.join(dir, 'INDEX.md'), out.join('\n') + '\n');
}

// ---------------------------------------------------------------- запуск

function writeStatus(dir, status) {
  try { writeAtomic(path.join(dir, STATUS_FILE), JSON.stringify({ ...status, pid: process.pid, updatedAt: new Date().toISOString() }) + '\n'); } catch { /* статус не критичен */ }
}

function readStatus(dir = laws.LAWS) {
  const status = readJsonFile(path.join(dir, STATUS_FILE));
  if (status && status.state === 'running') {
    if (!pidAlive(status.pid)) return { ...status, state: 'error', code: 'DIED', error: 'Процесс синхронизации завершился без итога' };
    const beat = Date.parse(status.updatedAt || status.startedAt);
    if (Number.isFinite(beat) && Date.now() - beat > LOCK_STALE_MS) return { ...status, state: 'error', code: 'STALLED', error: `Синхронизация не отмечалась с ${status.updatedAt || status.startedAt} — похоже, зависла` };
  }
  return status;
}

async function run(target = 'all', options = {}) {
  const servers = target === 'all' ? [...laws.SERVERS] : [checkServer(target)];
  const dir = path.resolve(options.dir || laws.LAWS);
  const release = acquireLock(dir);
  const startedAt = new Date().toISOString();
  const status = { state: 'running', target, dryRun: Boolean(options.dryRun), full: Boolean(options.full), startedAt, reports: [] };
  const setStatus = (extra) => { if (options.status) writeStatus(dir, { ...status, ...extra }); };
  setStatus({});
  const reports = [];
  try {
    for (const server of servers) {
      const { report } = await syncServer(server, {
        ...options, dir,
        onProgress: (step) => { release.touch(); setStatus({ progress: step }); if (options.onProgress) options.onProgress(step); },
      });
      reports.push(report);
      status.reports = reports;
    }
    if (!options.dryRun) writeIndex(dir);
    const result = { ok: true, target, dryRun: Boolean(options.dryRun), startedAt, finishedAt: new Date().toISOString(), reports };
    setStatus({ state: 'done', finishedAt: result.finishedAt, reports });
    return result;
  } catch (err) {
    setStatus({ state: 'error', finishedAt: new Date().toISOString(), error: err.message, code: err.code || 'ERROR', reports });
    err.reports = reports;
    throw err;
  } finally { release(); }
}

function summary(result) {
  const lines = [`Синхронизация законов${result.dryRun ? ' (пробный прогон, без записи)' : ''}: ${result.reports.length} сервер(а)`];
  for (const report of result.reports) {
    lines.push(`${report.server}: ${report.documents} документов на сайте (${report.mode === 'full' ? 'полная' : report.mode === 'incremental' ? 'по истории изменений' : 'без изменений на сайте'}), скачано ${report.fetched}; новых ${report.added.length}, изменено ${report.changed.length}, без изменений ${report.unchanged}, снято с сайта ${report.removed.length}; версий истории ${report.versions} (новых ${report.newVersions}${report.historySkipped ? ', история не запрашивалась — снимок сайта тот же' : ''}); сайт обновлён ${mskShort(report.siteUpdatedAt)}`);
    if (report.added.length) lines.push(`  новые: ${report.added.map((item) => `${item.code} «${item.title}»`).join('; ')}`);
    if (report.changed.length) lines.push(`  изменены: ${report.changed.map((item) => `${item.code}${item.archived ? ` (прежняя → ${item.archived})` : ''}`).join('; ')}`);
    if (report.removed.length) lines.push(`  сняты: ${report.removed.map((item) => `${item.code} «${item.title}»`).join('; ')}`);
    for (const error of report.errors) lines.push(`  ошибка ${error.code || error.document}: ${error.error}`);
  }
  return lines.join('\n');
}

async function cli(argv) {
  const args = argv.filter((item) => !item.startsWith('--'));
  const flags = new Set(argv.filter((item) => item.startsWith('--')));
  const known = new Set(['--dry-run', '--json', '--full', '--status', '--help']);
  for (const flag of flags) if (!known.has(flag)) throw syncError(`Неизвестный флаг ${flag}`, 'USAGE');
  if (flags.has('--help') || args.length > 1) {
    console.log('node tools/laws-sync.js [houston|miami|all] [--dry-run] [--full] [--json] [--status]');
    return;
  }
  const target = args[0] || 'all';
  if (target !== 'all') checkServer(target);
  const json = flags.has('--json');
  // Статус пишется всегда: law_sync {status:true} видит и запуски из командной строки (--status оставлен для совместимости).
  const result = await run(target, {
    dryRun: flags.has('--dry-run'), full: flags.has('--full'), status: true,
    onProgress: json ? undefined : (step) => { if (step.step === 'document') process.stderr.write(`${step.server}: ${step.done + 1}/${step.total} ${step.current}\n`); },
  });
  console.log(json ? JSON.stringify(result) : summary(result));
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exitCode = 1; });
}

module.exports = {
  BASE, USER_AGENT, MIN_DELAY_MS, MAX_VERSIONS, HEADER_LINES, PARSER_VERSION, STATUS_FILE, LOCK_FILE, LOCK_STALE_MS,
  getPage, blockReason, parseLiteral, unescapeJs, collectObjects, isoDate, htmlToLines, bbWrapper, lawFragment, decodeEntities,
  parseServerList, parseDocument, parseHistory, normalizeTitle, knownCode, makeCode, assignCodes,
  archiveVersion, acquireLock, lockInfo, syncServer, run, writeIndex, readStatus, summary, mskShort,
};
