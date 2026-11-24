'use strict';
const fs = require('node:fs');
const path = require('node:path');

class RequestGate {
  constructor({ file, interval = 30000, recoveryMs = 120000, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    Object.assign(this, { file, interval, recoveryMs, now, pause });
    this.tail = Promise.resolve();
    this.lastAt = 0;
    this.recoverUntil = 0;
    this.pending = 0;
    this.active = false;
    try {
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.version !== 1 || !Number.isFinite(saved.lastAt) || saved.lastAt < 0 || typeof saved.inFlight !== 'boolean') throw Error('Invalid rate state');
        this.lastAt = saved.lastAt;
        if (saved.inFlight) this.recoverUntil = Math.max(this.now() + interval, saved.lastAt + recoveryMs + interval);
      }
    } catch { this.storageError = true; }
  }

  fail(code, message) { throw Object.assign(new Error(message), { code, status: 503 }); }

  persist(inFlight) {
    if (this.storageError) this.fail('FORUM_RATE_STORAGE', 'Журнал интервала запросов недоступен; обращения к форуму остановлены');
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, lastAt: this.lastAt, inFlight }) + '\n', { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    } catch { this.storageError = true; this.fail('FORUM_RATE_STORAGE', 'Не удалось сохранить интервал запросов; обращение к форуму остановлено'); }
  }

  run(action, { deadline } = {}) {
    this.pending++;
    const result = this.tail.then(async () => {
      if (this.storageError) this.fail('FORUM_RATE_STORAGE', 'Журнал интервала запросов недоступен');
      const availableAt = Math.max(this.recoverUntil, this.lastAt ? this.lastAt + this.interval : 0);
      if (deadline !== undefined && (!Number.isFinite(deadline) || Math.max(availableAt, this.now()) >= deadline)) this.fail('REQUEST_EXPIRED', 'Срок запроса истёк в очереди; отправка не выполнялась');
      const delay = availableAt - this.now();
      if (delay > 0) await this.pause(delay);
      if (deadline !== undefined && this.now() >= deadline) this.fail('REQUEST_EXPIRED', 'Срок запроса истёк в очереди; отправка не выполнялась');
      this.lastAt = this.now();
      this.persist(true);
      this.active = true;
      try { return await action(); }
      finally {
        this.active = false;
        this.lastAt = this.now();
        this.recoverUntil = 0;
        this.persist(false);
      }
    });
    this.tail = result.catch(() => {});
    return result.finally(() => { this.pending--; });
  }

  status() {
    return { intervalMs: this.interval, pending: this.pending, active: this.active, lastCompletedOrStartedAt: this.lastAt || null, nextAvailableAt: this.lastAt ? Math.max(this.recoverUntil, this.lastAt + this.interval) : null, storageError: !!this.storageError };
  }
}
module.exports = { RequestGate };
