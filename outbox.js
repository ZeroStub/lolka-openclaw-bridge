'use strict';
/**
 * outbox.js - надёжная очередь исходящих сообщений в Lolka.
 *
 * Схема (по запросу владельца, без гонок):
 *  - на канал работает ровно один воркер: отправка идёт по одной, порядок сохраняется;
 *  - неудача -> повтор через таймеры 5/10/15/20/25 с (RETRY_DELAYS, настраивается);
 *  - если и они не помогли - сообщение НЕ теряется: буфер "паркуется" и ждёт
 *    нового сообщения в этом канале (или медленного таймера PARK_RETRY_MS),
 *    после чего очередь снова пытается отправить накопленное;
 *  - новое сообщение мгновенно будит очередь (poke) - ретрай не ждёт таймера;
 *  - постоянные ошибки (4xx кроме 429) очередь не застопорят: уходят в dead-letter.
 *
 * Экспорт: createOutbox({ log, deliver, ...opts })
 */
const fs = require('node:fs');

const DEFAULT_RETRY_DELAYS = [5000, 10000, 15000, 20000, 25000];

function createOutbox(opts) {
  const options = opts || {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const deliver = options.deliver;
  if (typeof deliver !== 'function') throw new Error('outbox: deliver() is required');
  const retryDelays = (options.retryDelays || DEFAULT_RETRY_DELAYS).slice().sort((a, b) => a - b);
  const parkRetryMs = options.parkRetryMs === undefined ? 300000 : options.parkRetryMs;
  const maxPerChannel = options.maxPerChannel || 300;
  const idleWaitMs = options.idleWaitMs || 3600000;
  const statePath = options.statePath || null;
  const deadLetterPath = options.deadLetterPath || null;

  const queues = new Map();
  const stats = { enqueued: 0, sent: 0, retriedMessages: 0, retryAttempts: 0, parked: 0, dead: 0, dropped: 0, restored: 0 };
  let saveTimer = null;

  /* ------------------------------------------------------------------ state */

  function snapshot() {
    const out = {};
    for (const [key, q] of queues) {
      if (!q.items.length) continue;
      out[key] = q.items.map(it => ({
        kind: it.kind, text: it.text, channelId: it.channelId, url: it.url, profile: it.profile, messageId: it.messageId,
      }));
    }
    return out;
  }
  function saveStateNow() {
    if (!statePath) return;
    try {
      fs.writeFileSync(statePath, JSON.stringify({ savedAt: new Date().toISOString(), queues: snapshot() }) + '\n');
    } catch (e) { log('[outbox] state save failed', e.message); }
  }
  function scheduleSave() {
    if (!statePath || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveStateNow(); }, 1000);
  }
  function deadLetter(item, reason) {
    if (!deadLetterPath) return;
    try {
      fs.appendFileSync(deadLetterPath, JSON.stringify({
        at: new Date().toISOString(), reason: reason || '', item: { kind: item.kind, text: item.text, channelId: item.channelId },
      }) + '\n');
    } catch (e) { log('[outbox] dead-letter write failed', e.message); }
  }

  /* ------------------------------------------------------------------ queue */

  function queueFor(key, label) {
    let q = queues.get(key);
    if (!q) {
      q = { key, label: label || key, items: [], wake: null, started: false };
      queues.set(key, q);
    } else if (label) {
      q.label = label;
    }
    return q;
  }

  // Прервать текущее ожидание таймера, если воркер спит.
  function wakeup(q) {
    if (q.wake) { const w = q.wake; q.wake = null; w(); }
  }
  function waitFor(q, ms) {
    return new Promise(resolve => {
      const t = setTimeout(() => { q.wake = null; resolve('timeout'); }, Math.max(0, ms));
      q.wake = () => { clearTimeout(t); resolve('poke'); };
    });
  }
  // Новое сообщение: голова очереди отправляется немедленно (в т.ч. с парковки).
  function poke(q) {
    const head = q.items[0];
    if (head) {
      head.nextAt = 0;
      if (head.parked) { head.parked = false; head.attempts = 0; }
    }
    wakeup(q);
  }

  function enqueue(key, item, label, silent) {
    const q = queueFor(key, label);
    const it = Object.assign({ attempts: 0, nextAt: 0, parked: false }, item);
    q.items.push(it);
    if (q.items.length > maxPerChannel) {
      const over = q.items.length - maxPerChannel;
      const dropped = q.items.splice(0, over);
      stats.dropped += over;
      for (const it of dropped) { if (typeof it.onResult === 'function') { try { it.onResult({ ok: false, dropped: true, reason: 'buffer overflow' }); } catch (e) {} } }
      log('[outbox] buffer overflow:', over, 'oldest dropped for', q.label);
    }
    if (silent) stats.restored++;
    else stats.enqueued++;
    startWorker(q);
    poke(q);
    scheduleSave();
    return it;
  }

  /* ----------------------------------------------------------------- worker */

  function startWorker(q) {
    if (q.started) return;
    q.started = true;
    (async () => {
      for (;;) {
        if (!q.items.length) { await waitFor(q, idleWaitMs); continue; }
        const it = q.items[0];

        const wait = (it.nextAt || 0) - Date.now();
        if (wait > 0) { await waitFor(q, wait); continue; }

        let r;
        try { r = await deliver(it); }
        catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }

        if (r && r.ok) {
          q.items.shift();
          stats.sent++;
          if (it.attempts) stats.retriedMessages++;
          log('[outbox] sent', q.label, it.kind, (it.text || '').length + ' chars' +
            (it.attempts ? ' (после ' + it.attempts + ' ретраев)' : ''));
          scheduleSave();
          if (typeof it.onResult === 'function') { try { it.onResult(r); } catch (e) {} }
          continue;
        }

        const reason = (r && r.reason) || 'send failed';

        if (r && r.permanent) {
          q.items.shift();
          stats.dead++;
          log('[outbox] permanent failure, drop:', q.label, reason);
          deadLetter(it, reason);
          scheduleSave();
          if (typeof it.onResult === 'function') { try { it.onResult(r); } catch (e) {} }
          continue;
        }

        it.attempts = (it.attempts || 0) + 1;
        stats.retryAttempts++;

        if (it.attempts > retryDelays.length) {
          it.parked = true;
          it.attempts = 0;
          stats.parked++;
          it.nextAt = Date.now() + parkRetryMs;
          log('[outbox] parked', q.label, it.kind, '-', reason,
            '- ждём новое сообщение в канале (страховочный таймер ' + Math.round(parkRetryMs / 1000) + 's), буфер держим');
          scheduleSave();
          continue; // ждём poke или страховочный таймер
        }

        const base = retryDelays[it.attempts - 1];
        const delay = Math.max(base, (r && r.retryAfterMs) || 0);
        it.nextAt = Date.now() + delay;
        log('[outbox] retry #' + it.attempts + ' через ' + Math.round(delay / 1000) + 's:', q.label, reason);
        continue;
      }
    })().catch(e => log('[outbox] worker crashed for', q.label, (e && e.message) || e));
  }

  /* ------------------------------------------------------------------- api */

  function loadState() {
    if (!statePath) return 0;
    let d;
    try { d = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') log('[outbox] state load failed', e.message); return 0; }
    let n = 0;
    for (const [key, items] of Object.entries((d && d.queues) || {})) {
      for (const it of items) { enqueue(key, it, null, true); n++; }
      if (items.length) log('[outbox] restored', items.length, 'buffered msg(s) for', key);
    }
    return n;
  }

  return {
    enqueue,
    poke: key => { const q = queues.get(key); if (q) poke(q); },
    pokeAll: () => { for (const q of queues.values()) poke(q); },
    loadState,
    saveState: saveStateNow,
    stats: () => Object.assign({}, stats),
    size: key => { const q = queues.get(key); return q ? q.items.length : 0; },
    pending: () => [...queues.values()].reduce((n, q) => n + q.items.length, 0),
    retryDelays,
  };
}

module.exports = { createOutbox, DEFAULT_RETRY_DELAYS };
