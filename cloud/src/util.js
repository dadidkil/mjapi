'use strict';
const { createHash, timingSafeEqual, randomBytes } = require('node:crypto');
function fail(status, code, message, extra = {}) { throw Object.assign(new Error(message), { status, code, ...extra }); }
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const normalize = value => String(value).normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u200b\ufeff]/g, '').replace(/[ \t]+$/gm, '').trim();
function equal(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); }
function integer(value, fallback, min, max) { const n = value === undefined || value === '' ? fallback : Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) fail(422, 'INVALID_INTEGER', `Expected an integer between ${min} and ${max}`); return n; }
function text(value, max = 200, required = false) { if (value === undefined && !required) return undefined; if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(422, 'INVALID_TEXT', 'Invalid or oversized text'); return value; }
function snowflake(value) { if (typeof value !== 'string' || !/^\d{15,22}$/.test(value)) fail(422, 'INVALID_ID', 'Expected a Discord snowflake string'); return value; }
const page = args => ({ limit: integer(args.limit, 10, 1, 50), offset: integer(args.offset, 0, 0, 100000) });
function envelope(items, offset, limit) { return { items: items.slice(0, limit), offset, limit, nextOffset: items.length > limit ? offset + limit : null }; }
function retryAfter(value, now = Date.now()) { if (!value) return 0; const seconds = Number(value); return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0; }
const sleep = (ms, signal) => require('node:timers/promises').setTimeout(ms, undefined, { signal });
function safeError(err) { return { code: /^[A-Z0-9_]+$/.test(err?.code || '') ? err.code : 'INTERNAL_ERROR', message: err?.status && err.status < 500 ? String(err.message).slice(0, 300) : 'Operation failed; check system_status and source state', ...(err?.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}) }; }
module.exports = { fail, hash, token, normalize, equal, integer, text, snowflake, page, envelope, retryAfter, sleep, safeError };
