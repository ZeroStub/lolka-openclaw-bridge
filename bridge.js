#!/usr/bin/env node
'use strict';
/**
 * Мост Lolka <-> OpenClaw (v3).
 *  - Lolka-канал -> сессия: sessions.send
 *  - сессия -> Lolka: session.message (assistant -> бот; user -> вебхук с подписью владельца)
 *  - локальные команды из Lolka: /help /status /compact /stop
 *  - опциональные уведомления о тул-вызовах и компакции (mapping.notices = true)
 * Конфиг: bridges.json
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('lolka.js');
const { createOutbox } = require('./outbox');

const DIR = __dirname;
// Мультиинстанс: свой набор файлов на каждый экземпляр (второй бот и т.п.).
// LOLKA_CFG_SUFFIX=-bot2 -> bridges-bot2.json, .token-bot2, .owner-bot2.json, outbox-bot2.json
const SUF = process.env.LOLKA_CFG_SUFFIX || '';
const CFG_FILE = 'bridges' + SUF + '.json';
const TOKEN_FILE = '.token' + SUF;
const OWNER_FILE = '.owner' + SUF + '.json';
const STATE_FILE = 'outbox' + SUF + '.json';
const DEAD_FILE = 'outbox-dead' + SUF + '.jsonl';
const API = 'https://lolka.app/api/bot/v10';
const ocCfg = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH || `${os.homedir()}/.openclaw/openclaw.json`, 'utf8'));
const PORT = ocCfg.gateway && ocCfg.gateway.port ? ocCfg.gateway.port : 18789;
const TOKEN = ocCfg.gateway && ocCfg.gateway.auth ? ocCfg.gateway.auth.token : undefined;
const bridgeCfg = JSON.parse(fs.readFileSync(path.join(DIR, CFG_FILE), 'utf8'));
const lolkaToken = (process.env.LOLKA_BOT_TOKEN && process.env.LOLKA_BOT_TOKEN.trim()) || fs.readFileSync(path.join(DIR, TOKEN_FILE), 'utf8').trim();
const ALLOW_SELF_CMDS = process.env.LOLKA_BRIDGE_ALLOW_SELF_CMDS === '1';

const MAPPINGS = bridgeCfg.mappings || [];
const byChannel = new Map(MAPPINGS.map(m => [String(m.channelId), m]));
const bySession = new Map(MAPPINGS.map(m => [m.sessionKey, m]));
let OWNER = null;
try { OWNER = JSON.parse(fs.readFileSync(path.join(DIR, OWNER_FILE), 'utf8')); } catch {}
function saveOwner() { try { fs.writeFileSync(path.join(DIR, OWNER_FILE), JSON.stringify(OWNER)); } catch {} }

const recentInbound = new Map();
const seen = new Set();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const norm = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
function markSeen(id) { if (!id) return false; if (seen.has(id)) return true; seen.add(id); if (seen.size > 2000) seen.delete(seen.values().next().value); return false; }

function textOf(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map(p => (p && (p.text !== undefined ? p.text : p.content)) || '').join('');
  if (typeof m.text === 'string') return m.text;
  return '';
}
function chunk(text, size) {
  size = size || 1900;
  const out = []; let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < 500) cut = size;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest);
  return out;
}

async function botSendRaw(channelId, text) {
  let last = null; let lastId = null;
  for (const c of chunk(text)) {
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${lolkaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: c || '-' }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      log('[lolka] bot send failed', res.status, body);
      last = { ok: false, status: res.status, reason: 'HTTP ' + res.status + ' ' + body };
    } else {
      try { const j = await res.json(); if (j && j.id) lastId = String(j.id); } catch (e) {}
    }
  }
  if (last) return last;
  return lastId ? { ok: true, id: lastId } : { ok: true };
}
async function hookSendRaw(url, text, profile) {
  const body = { content: text };
  if (profile && profile.username) body.username = profile.username;
  if (profile && profile.avatar) body.avatar_url = profile.avatar;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 200);
    log('[lolka] hook send failed', res.status, t);
    return { ok: false, status: res.status, reason: 'HTTP ' + res.status + ' ' + t };
  }
  return { ok: true };
}
// Правка ранее отправленного сообщения (PATCH) - нужна для блока-тикера тул-вызовов.
async function botEditRaw(channelId, messageId, text) {
  const res = await fetch(`${API}/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bot ${lolkaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text || '-' }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    log('[lolka] bot edit failed', res.status, body);
    return { ok: false, status: res.status, reason: 'HTTP ' + res.status + ' ' + body };
  }
  return { ok: true };
}
/* ---------- надёжная отправка: очередь с ретраями (outbox) ----------
 * 5 попыток через 5/10/15/20/25 с; если не вышло - буфер паркуется и ждёт
 * следующего сообщения в канале (или страховочного таймера). Настройка:
 *   LOLKA_RETRY_DELAYS=5,10,15,20,25   (секунды)
 *   LOLKA_OUTBOX_PARK_MS=300000        (страховочный ретрай запаркованного)
 *   LOLKA_SEND_TIMEOUT_MS=20000        (таймаут одного HTTP-запроса)
 */
const RETRY_DELAYS = process.env.LOLKA_RETRY_DELAYS
  ? process.env.LOLKA_RETRY_DELAYS.split(',').map(x => Number(x.trim()) * 1000).filter(x => x > 0)
  : [5000, 10000, 15000, 20000, 25000];
const PARK_RETRY_MS = process.env.LOLKA_OUTBOX_PARK_MS ? Number(process.env.LOLKA_OUTBOX_PARK_MS) : 300000;const SEND_TIMEOUT_MS = process.env.LOLKA_SEND_TIMEOUT_MS ? Number(process.env.LOLKA_SEND_TIMEOUT_MS) : 20000;

function classify(res) {
  if (!res || res.ok) return res && res.id ? { ok: true, id: res.id } : { ok: true };
  const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
  return { ok: false, permanent: !retryable, status: res.status, reason: res.reason || ('HTTP ' + res.status) };
}
function withTimeout(p, ms) {
  let t = null;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('send timeout ' + Math.round(ms / 1000) + 's')), ms); });
  return Promise.race([p, timeout]).finally(() => { if (t) clearTimeout(t); });
}

const outbox = createOutbox({
  log,
  retryDelays: RETRY_DELAYS,
  parkRetryMs: PARK_RETRY_MS,
  statePath: path.join(DIR, STATE_FILE),
  deadLetterPath: path.join(DIR, DEAD_FILE),
  deliver: async it => {
    if (it.kind === 'hook') return classify(await withTimeout(hookSendRaw(it.url, it.text, it.profile), SEND_TIMEOUT_MS));
    if (it.kind === 'edit') return classify(await withTimeout(botEditRaw(String(it.channelId), String(it.messageId), it.text), SEND_TIMEOUT_MS));
    return classify(await withTimeout(botSendRaw(String(it.channelId), it.text), SEND_TIMEOUT_MS));
  },
});
log('[outbox] ready: retry ' + RETRY_DELAYS.map(x => x / 1000 + 's').join('/') +
    ', park ' + Math.round(PARK_RETRY_MS / 1000) + 's, restored ' + outbox.loadState() + ' msg(s)');

// Отправка теперь = постановка в очередь (порядок держит воркер очереди).
async function botSend(channelId, text) {
  const map = byChannel.get(String(channelId));
  const label = map ? map.name : 'channel ' + channelId;
  for (const c of chunk(text)) outbox.enqueue('channel:' + channelId, { kind: 'bot', channelId: String(channelId), text: c || '-' }, label);
}

// ── Индикатор «печатает» ─────────────────────────────────────────────────────
// Lolka (Discord-совместимо): POST /channels/{id}/typing → 204. Держим индикатор
// пока агент думает: повторяем каждые TYPING_EVERY_MS, максимум TYPING_MAX_MS.
const TYPING_ON = process.env.LOLKA_TYPING !== '0';
const TYPING_EVERY_MS = Number(process.env.LOLKA_TYPING_EVERY_MS || 8000);
// Потолок одного прогона: 30 минут (было 10 — не хватало на длинные задачи).
const TYPING_MAX_MS = Number(process.env.LOLKA_TYPING_MAX_MS || 1800000);
// Минимальная выдержка индикатора перед финальным сообщением и режим задержки:
//   min    - добираем до TYPING_MIN_MS, если ответ пришёл быстрее (по умолчанию)
//   always - всегда ждём TYPING_MIN_MS перед отправкой
//   off    - отправляем сразу
const TYPING_MIN_MS = Number(process.env.LOLKA_TYPING_MIN_MS || 2500);
const TYPING_DELAY = String(process.env.LOLKA_TYPING_DELAY || 'min').toLowerCase();
const typingTimers = new Map();
const typingFallback = new Map();

// Операция завершилась, но финального сообщения ещё нет: гасим индикатор не сразу,
// а с грейсом — иначе он успевает погаснуть до отправки ответа.
function typingStopSoon(channelId, ms) {
  const id = String(channelId);
  const prev = typingFallback.get(id);
  if (prev) clearTimeout(prev);
  const h = setTimeout(() => { typingFallback.delete(id); typingStop(id); }, ms);
  if (h.unref) h.unref();
  typingFallback.set(id, h);
}
function typingCancelFallback(channelId) {
  const id = String(channelId);
  const prev = typingFallback.get(id);
  if (prev) { clearTimeout(prev); typingFallback.delete(id); }
}

async function botTyping(channelId) {
  try {
    const res = await fetch(`${API}/channels/${channelId}/typing`, {
      method: 'POST',
      headers: { Authorization: `Bot ${lolkaToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    return res.status;
  } catch (e) { return 0; }
}

function typingStart(channelId) {
  if (!TYPING_ON || !channelId) return;
  const id = String(channelId);
  typingCancelFallback(id);
  typingStop(id);
  const tick = () => { botTyping(id).then(st => { if (st !== 204) log('[typing] ' + id + ' → ' + (st === 0 ? 'сеть/ошибка' : 'HTTP ' + st)); }); };
  if (process.env.LOLKA_BRIDGE_DEBUG) log('[typing] ' + id + ': печатает…');
  tick();
  const t = setInterval(() => {
    const cur = typingTimers.get(id);
    if (!cur || Date.now() > cur.until) { typingStop(id); return; }
    tick();
  }, TYPING_EVERY_MS);
  if (t.unref) t.unref();
  typingTimers.set(id, { t, until: Date.now() + TYPING_MAX_MS, since: Date.now() });
}

// Финальное сообщение агента: сначала даём индикатору «печатает» повисеть
// (минимум TYPING_MIN_MS), только потом гасим и отправляем текст.
function sendFinal(map, text) {
  const id = String(map.channelId);
  const cur = typingTimers.get(id);
  let wait = 0;
  if (TYPING_ON && cur && TYPING_DELAY !== 'off') {
    const elapsed = Date.now() - (cur.since || Date.now());
    wait = TYPING_DELAY === 'always' ? TYPING_MIN_MS : Math.max(0, TYPING_MIN_MS - elapsed);
  }
  const send = () => {
    typingCancelFallback(id);
    typingStop(id);
    tickerClose(map); // закрываем блок-тикер тул-вызовов, если он открыт
    botSend(id, text).catch(e => log('[lolka] send error', e.message));
  };
  if (wait > 0) { const h = setTimeout(send, wait); if (h.unref) h.unref(); } else send();
}

function typingStop(channelId) {
  const id = String(channelId);
  const cur = typingTimers.get(id);
  if (cur) { clearInterval(cur.t); typingTimers.delete(id); }
}

async function hookSend(url, text, profile) {
  const map = MAPPINGS.find(m => m.webhookUrl === url);
  const prof = profile && profile.username ? { username: profile.username, avatar: profile.avatar } : undefined;
  outbox.enqueue('hook:' + url, { kind: 'hook', url, text, profile: prof }, map ? map.name : 'webhook');
}
// То же, но с результатом доставки (нужно тикеру: получить id созданного сообщения).
function botSendQueued(channelId, text) {
  return new Promise(resolve => {
    const map = byChannel.get(String(channelId));
    const label = map ? map.name : 'channel ' + channelId;
    outbox.enqueue('channel:' + channelId,
      { kind: 'bot', channelId: String(channelId), text, onResult: r => resolve(r || { ok: false }) }, label);
  });
}
function botEdit(channelId, messageId, text) {
  return new Promise(resolve => {
    const map = byChannel.get(String(channelId));
    const label = map ? map.name : 'channel ' + channelId;
    outbox.enqueue('channel:' + channelId,
      { kind: 'edit', channelId: String(channelId), messageId: String(messageId), text, onResult: r => resolve(r || { ok: false }) }, label);
  });
}

/* ---- контекст: плашка при заполнении + принудительная компакция ----
 * Источник — `sessions.describe` → `session.contextBudgetStatus` (оценка контекста
 * самим OpenClaw: estimatedPromptTokens / contextTokenBudget, флаг shouldCompact).
 * По умолчанию порог один — 100%: сообщаем в канал и САМИ запускаем компакцию,
 * потому что авто-компакция иногда «залипает» и ход не обрабатывается.
 * Настройка: LOLKA_CTX_THRESHOLDS=100, LOLKA_CTX_SWEEP_MS=300000,
 *   LOLKA_CTX_AUTOCOMPACT=0 (выключить), LOLKA_CTX_COMPACT_COOLDOWN_MS=600000,
 *   LOLKA_CTX_STUCK_MS=180000 (сколько ждать ответа, прежде чем сказать «чат не отвечает»).
 */
const CTX_THRESHOLDS = (process.env.LOLKA_CTX_THRESHOLDS || '100')
  .split(',').map(x => Number(x.trim())).filter(n => n > 0 && n <= 100).sort((a, b) => a - b);
const CTX_SWEEP_MS = process.env.LOLKA_CTX_SWEEP_MS ? Number(process.env.LOLKA_CTX_SWEEP_MS) : 300000;
const CTX_MIN_GAP_MS = process.env.LOLKA_CTX_MIN_GAP_MS ? Number(process.env.LOLKA_CTX_MIN_GAP_MS) : 20000;
// Отладочные ключи: ограничить проверку одним каналом и/или отправить плашку сразу.
const CTX_ONLY = process.env.LOLKA_CTX_ONLY || null;
const CTX_FORCE = process.env.LOLKA_CTX_FORCE_NOTICE === '1';
const CTX_AUTOCOMPACT = process.env.LOLKA_CTX_AUTOCOMPACT !== '0';
const CTX_COMPACT_COOLDOWN_MS = process.env.LOLKA_CTX_COMPACT_COOLDOWN_MS ? Number(process.env.LOLKA_CTX_COMPACT_COOLDOWN_MS) : 600000;
const CTX_STUCK_MS = process.env.LOLKA_CTX_STUCK_MS ? Number(process.env.LOLKA_CTX_STUCK_MS) : 180000;
const ctxState = new Map(); // sessionKey -> { level, compact, seen, lastCheck, lastCompactAt, pendingSince }

function ctxStateFor(key) {
  let st = ctxState.get(key);
  if (!st) { st = { level: 0, compact: false, seen: false, lastCheck: 0, lastCompactAt: 0, pendingSince: 0 }; ctxState.set(key, st); }
  return st;
}

async function contextSnapshot(key) {
  try {
    const d = await req('sessions.describe', { key });
    const s = (d && (d.session || d.snapshot || d)) || {};
    const cb = s.contextBudgetStatus || {};
    const budget = cb.contextTokenBudget || s.contextTokens || 0;
    const used = cb.estimatedPromptTokens || s.totalTokens || ((s.inputTokens || 0) + (s.outputTokens || 0));
    if (!budget || !used) return null;
    return {
      pct: Math.min(100, Math.round(100 * used / budget)),
      used, budget,
      shouldCompact: !!cb.shouldCompact,
      route: cb.route || null,
      model: s.model || null,
      updatedAt: cb.updatedAt || null,
    };
  } catch (e) { return null; }
}

function fmtTokens(n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
function ctxFull(u) { return !!u && (u.pct >= 100 || u.shouldCompact); }

// Принудительная компакция (с антидребезгом и отдельным флагом канала).
async function forceCompact(map, st, reason) {
  if (!CTX_AUTOCOMPACT || map.ctxCompact === false) return false;
  if (Date.now() - (st.lastCompactAt || 0) < CTX_COMPACT_COOLDOWN_MS) {
    log('[ctx] ' + map.name + ': компакцию уже запускали только что, пропускаю');
    return false;
  }
  st.lastCompactAt = Date.now();
  try {
    await req('sessions.compact', Object.assign({ key: map.sessionKey }, map.agentId ? { agentId: map.agentId } : {}), 120000);
    log('[ctx] принудительная компакция запущена: ' + map.name + ' (' + reason + ')');
    await botSend(String(map.channelId), 'Запустил компакцию принудительно — контекст сжался, можно продолжать.');
    return true;
  } catch (e) {
    const m = (e && e.message) || String(e);
    log('[ctx] компакция не удалась: ' + map.name + ' — ' + m);
    await botSend(String(map.channelId), 'Контекст полон, но компакцию запустить не удалось: ' + m);
    return false;
  }
}

// Проверяет заполнение контекста: плашка при переходе порога и при «залипании».
async function contextNotice(map, opts) {
  opts = opts || {};
  if (!map || map.ctxWarn === false) return null;
  const st = ctxStateFor(map.sessionKey);
  if (!opts.force && Date.now() - st.lastCheck < CTX_MIN_GAP_MS) return null;
  st.lastCheck = Date.now();
  if (CTX_ONLY && String(map.channelId) !== String(CTX_ONLY)) return null;

  const u = await contextSnapshot(map.sessionKey);
  if (!u) return null;

  const level = CTX_THRESHOLDS.filter(t => u.pct >= t).pop() || 0;
  const stuck = !!st.pendingSince && (Date.now() - st.pendingSince) > CTX_STUCK_MS && ctxFull(u);
  let reason = null;

  if (!st.seen) { // первый замер после старта: базовая линия, без спама (кроме случая «уже полон»)
    st.seen = true; st.level = level; st.compact = u.shouldCompact;
    log('[ctx] ' + map.name + ': ' + u.pct + '% (' + u.used + '/' + u.budget + ')' + (u.shouldCompact ? ' shouldCompact' : ''));
    if (!CTX_FORCE && !ctxFull(u) && !stuck) return null;
    reason = ctxFull(u) ? 'на старте контекст уже полон' : 'залипание после старта';
  } else {
    if (level < st.level) st.level = level; // после компакции/нового окна — просто заметили
    if (!u.shouldCompact) st.compact = false;
    const crossed = level > st.level;
    const compactNow = u.shouldCompact && !st.compact;
    if (!crossed && !compactNow && !stuck) return null;
    st.level = Math.max(st.level, level);
    if (u.shouldCompact) st.compact = true;
    reason = stuck ? 'чат не отвечает — контекст полон' : (crossed ? 'порог ' + level + '%' : 'shouldCompact');
  }

  const head = stuck
    ? '[!] Чат не отвечает: контекст заполнен'
    : (u.pct >= 100 ? '[!] Контекст заполнен на ' + u.pct + '%' : (level >= 95 ? '[!] Контекст почти полон: ' + u.pct + '%' : 'Контекст: ' + u.pct + '%'));
  const lines = ['**' + head + '** — канал «' + map.name + '»'];
  lines.push('оценка контекста: ' + fmtTokens(u.used) + ' из ' + fmtTokens(u.budget) + ' токенов');
  if (u.shouldCompact && !stuck) lines.push('OpenClaw: `shouldCompact` — авто-компакция не сработала (залипание).');
  const willCompact = (ctxFull(u) || stuck) && CTX_AUTOCOMPACT && map.ctxCompact !== false;
  lines.push(willCompact
    ? 'Запускаю компакцию принудительно…'
    : 'Сожми вручную: `/compact` (или ветка: `/chatadd tree`)');
  await botSend(String(map.channelId), lines.join('\n'));
  log('[ctx->lolka] ' + map.name + ' ' + u.pct + '%' + (u.shouldCompact ? ' shouldCompact' : '') + (stuck ? ' STUCK' : ''));
  if (stuck) st.pendingSince = 0; // повторно не долбим до следующего сообщения пользователя
  if (ctxFull(u) || stuck) await forceCompact(map, st, reason || 'полный контекст');
  return u;
}

/* ---- /chatadd: новый чат/ветка + автосоздание канала в Lolka ---- */
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

async function createLolkaChannel(name, parentId) {
  const guildId = bridgeCfg.guildId;
  if (!guildId) throw new Error('guildId не задан в bridges.json');
  const body = { name: name, type: 0 };
  if (parentId) body.parent_id = String(parentId);
  const res = await fetch(`${API}/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: { Authorization: `Bot ${lolkaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('создание канала: HTTP ' + res.status + ' ' + text.slice(0, 160));
  let ch; try { ch = JSON.parse(text); } catch { throw new Error('создание канала: неожиданный ответ'); }
  return ch;
}

async function createSessionWithFallback(params, mode) {
  try {
    return await req('sessions.create', params, 60000);
  } catch (e) {
    // Ветку нельзя форкнуть, пока исходная сессия в работе: просим точку последнего завершённого хода.
    if (mode === 'tree' && /still active/i.test(String((e && e.message) || ''))) {
      params.forkFrom = 'last-completed';
      return await req('sessions.create', params, 60000);
    }
    throw e;
  }
}

async function addChatSession(map, mode, title, parentId) {
  const agent = map.agentId || 'main';
  let model = null;
  try {
    const l = await req('sessions.list', {});
    const arr = (l && (l.sessions || l.items)) || [];
    const row = arr.find(x => x && x.key === map.sessionKey) || null;
    model = (row && row.model) || null;
  } catch (e) { /* не критично */ }

  const slug = slugify(title) || 'chat-' + Date.now().toString(36);
  const key = 'agent:' + agent + ':lolka:' + slug;
  const params = { key, agentId: agent, label: (mode === 'tree' ? 'ветка: ' : '') + (title || slug) };
  if (model) params.model = model;
  if (mode === 'tree') { params.parentSessionKey = map.sessionKey; params.fork = true; }

  const created = await createSessionWithFallback(params, mode);
  const sessionKey = (created && (created.key || created.sessionKey)) || key;

  const ch = await createLolkaChannel(slug, parentId);
  const entry = {
    channelId: String(ch.id), name: ch.name || slug, sessionKey,
    agentId: agent, webhookUrl: null, notices: false,
  };
  MAPPINGS.push(entry);
  byChannel.set(entry.channelId, entry);
  bySession.set(entry.sessionKey, entry);
  bridgeCfg.mappings = MAPPINGS;
  fs.writeFileSync(path.join(DIR, CFG_FILE), JSON.stringify(bridgeCfg, null, 2) + '\n');
  await ensureWebhook(entry);
  sendReq('sessions.messages.subscribe', { key: sessionKey, agentId: agent });
  return { entry, sessionKey, model: model || 'default', mode };
}

async function ensureWebhook(map) {
  if (map.webhookUrl) return map.webhookUrl;
  try {
    const res = await fetch(`${API}/channels/${map.channelId}/webhooks`, {
      method: 'POST', headers: { Authorization: `Bot ${lolkaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'OpenClaw mirror' }),
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok || !b.url) { log('[hook] create failed', map.name, res.status); return null; }
    map.webhookUrl = b.url;
    bridgeCfg.mappings = MAPPINGS;
    fs.writeFileSync(path.join(DIR, CFG_FILE), JSON.stringify(bridgeCfg, null, 2) + '\n');
    log('[hook] created for', map.name);
    return b.url;
  } catch (e) { log('[hook] error', e.message); return null; }
}
async function learnOwner() {
  for (const m of MAPPINGS) {
    try {
      const res = await fetch(`${API}/channels/${m.channelId}/messages?limit=50`, { headers: { Authorization: `Bot ${lolkaToken}` } });
      const d = await res.json();
      const msgs = Array.isArray(d) ? d : (d.messages || []);
      for (const x of msgs) {
        const a = x.author || {};
        if (a.bot || a.is_webhook || !a.username) continue;
        OWNER = { username: a.global_name || a.username, avatar: a.avatar, id: a.id };
        saveOwner();
        log('[owner] learned:', OWNER.username, OWNER.id);
        return;
      }
    } catch (e) { log('[owner] learn failed', e.message); }
  }
  log('[owner] not found, fallback will be used');
}

let ws = null, rid = 0;
const waiters = new Map();
function req(method, params, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('gateway not connected'));
    const id = 'r' + (++rid);
    const t = setTimeout(() => { waiters.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
    waiters.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}
function sendReq(method, params) { req(method, params).catch(() => {}); }

function pick(o) { for (let i = 1; i < arguments.length; i++) { const k = arguments[i]; if (o && o[k] !== undefined && o[k] !== null) return o[k]; } }
function fmtStatus(name, d, row) {
  d = d || {}; row = row || {};
  const snap = d.session || d.snapshot || d || {};
  const lines = ['**' + name + '**'];
  const model = pick(row, 'model') || pick(snap, 'model');
  if (model) lines.push('модель: `' + model + '`');
  const total = pick(row, 'totalTokens') || pick(snap, 'totalTokens');
  const ctx = pick(row, 'contextTokens') || pick(snap, 'contextTokens');
  if (total) lines.push('токенов: ' + total + (ctx ? ' / окно ' + ctx + ' (' + Math.round(100 * total / ctx) + '%)' : ''));
  else if (ctx) lines.push('окно: ' + ctx);
  const st = pick(row, 'status') || pick(snap, 'status');
  if (st) lines.push('статус: ' + st);
  const cost = pick(row, 'estimatedCostUsd');
  if (cost) lines.push('расход: $' + Number(cost).toFixed(4));
  if (total && ctx && total / ctx >= 0.8) lines.push(':warning: контекст заполнен на ' + Math.round(100 * total / ctx) + '% - стоит сделать `/compact`');
  if (lines.length === 1) lines.push('_(нет данных: сессия не найдена в списке)_');
  return lines.join('\n');
}
function saveBridges() {
  try {
      const cur = JSON.parse(fs.readFileSync(path.join(DIR, CFG_FILE), 'utf8'));
      cur.mappings = (cur.mappings || []).map(m => {
      const live = MAPPINGS.find(x => x.channelId === m.channelId);
      return live ? Object.assign(m, { notices: !!live.notices, ctxWarn: live.ctxWarn !== false, ctxCompact: live.ctxCompact !== false, toolStyle: live.toolStyle || m.toolStyle || TOOL_STYLE, toolTicker: live.toolTicker !== false }) : m;
    });
    fs.writeFileSync(path.join(DIR, CFG_FILE), JSON.stringify(cur, null, 2) + '\n');
    return true;
  } catch (e) { log('[cfg] save failed:', e.message); return false; }
}
function statusButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bridge:status').setLabel('Обновить').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bridge:compact').setLabel('Компакция').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bridge:stop').setLabel('Стоп').setStyle(ButtonStyle.Danger),
  );
}
async function sendStatus(map, text) {
  try {
    const ch = lolka.channels.cache.get(String(map.channelId)) || await lolka.channels.fetch(String(map.channelId));
    await ch.send({ content: text, components: [statusButtons()] });
  } catch (e) {
    log('[ui] status send failed, fallback rest:', e.message);
    await botSend(String(map.channelId), text);
  }
}
// Команды моста — только владельцу (id из .owner.json).
// Опциональный расширенный список — env LOLKA_ADMINS (по умолчанию пуст).
// Права админа сервера намеренно НЕ учитываются: админов много.
const ADMIN_IDS = new Set(String(process.env.LOLKA_ADMINS || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean));
const cmdDeniedAt = new Map();
function isAdminId(id) {
  const s = String(id || '');
  if (!s) return false;
  if (!OWNER) return ADMIN_IDS.has(s);
  return s === String(OWNER.id) || ADMIN_IDS.has(s);
}
function canUseCommands(_msg, a) {
  return isAdminId(a && a.id);
}

async function handleCommand(map, cmd, arg) {
  const key = map.sessionKey;
  const extra = map.agentId ? { agentId: map.agentId } : {};
  try {
    if (cmd === 'help' || cmd === 'commands') {
      await botSend(String(map.channelId), [
        '**Команды моста** (доступны только владельцу):',
        '`/status` - состояние сессии (модель, токены, контекст) + кнопки',
        '`/model` - текущая модель; `/model <id>` - сменить; `/model default` - сбросить',
        '`/models` - список доступных моделей; `/modelall` - вообще все, включая недоступные',
        '`/modelprovider` - список провайдеров; `/modelprovider <id>` - модели одного провайдера',
        '`/notices [on|off]` - уведомления о тул-вызовах в этом канале',
        '`/toolstyle code|quote|spoiler|plain|off` - как оформлять тул-уведомления (по умолчанию `code`)',
        '`/toolticker [on|off]` - серия тул-вызовов одним блоком, который дописывается правкой',
        '`/typing [on|off]` - индикатор «печатает», пока агент думает',
        '`/think <off|minimal|low|medium|high>` - уровень размышлений',
        '`/compact` - запустить компакцию контекста',
        '`/stop` - прервать текущий прогон агента',
        '`/restart` - перезапустить гейтвей OpenClaw (~15 секунд)',
        '`/ctx` - сколько контекста занято (оценка OpenClaw) + порог/авто-компакция',
        '`/ctxwarn [on|off]` - вкл/выкл плашку при заполнении контекста (порог по умолчанию 100%)',
        '`/ctxcompact [on|off]` - вкл/выкл принудительную компакцию при полном контексте',
        '`/chatadd [new|tree] [имя]` - новый чат в OpenClaw + новый канал в Lolka, привязанные друг к другу',
        '`/help` - этот список',
        '',
        'Обычный текст уходит агенту. Уведомления о тул-вызовах и компакции включаются флагом `"notices": true` для канала в bridges.json.',
      ].join('\n'));
      return;
    }
    if (cmd === 'restart') {
      const { execFile } = require('node:child_process');
      const bin = process.env.OPENCLAW_BIN || path.join(os.homedir(), '.openclaw', 'bin', 'openclaw');
      await botSend(String(map.channelId), 'перезапускаю гейтвей, ~15 секунд…');
      execFile(bin, ['gateway', 'restart'], { timeout: 180000 }, (err, _stdout, stderr) => {
        const msg = err
          ? 'рестарт не удался: ' + (String(stderr || '').trim() || err.message)
          : 'гейтвей перезапущен';
        botSend(String(map.channelId), msg).catch(() => {});
      });
      return;
    }
    if (cmd === 'status') {
      const d = await req('sessions.describe', { key });
      let row = null;
      try {
        const l = await req('sessions.list', {});
        const arr = (l && (l.sessions || l.items)) || [];
        row = arr.find(x => x && x.key === key) || null;
      } catch (e) { /* ignore */ }
      await sendStatus(map, fmtStatus(map.name, d, row));
      return;
    }
    if (cmd === 'compact') {
      await req('sessions.compact', Object.assign({ key }, extra));
      await botSend(String(map.channelId), 'компакция запущена');
      return;
    }
    if (cmd === 'stop') {
      await req('sessions.abort', Object.assign({ key }, extra));
      await botSend(String(map.channelId), 'прогон остановлен');
      return;
    }
    if (cmd === 'notices') {
      const a = String(arg || '').trim().toLowerCase();
      if (a === 'on') map.notices = true;
      else if (a === 'off') map.notices = false;
      else if (a !== '') { await botSend(String(map.channelId), 'использование: `/notices on` или `/notices off`'); return; }
      const ok = saveBridges();
      await botSend(String(map.channelId), 'уведомления о тул-вызовах: ' + (map.notices ? 'вкл' : 'выкл') + (ok ? '' : ' (не удалось сохранить в bridges.json)'));
      return;
    }
    if (cmd === 'toolstyle') {
      const a = String(arg || '').trim().toLowerCase();
      const okv = ['code', 'quote', 'spoiler', 'plain', 'off'];
      if (a === '') {
        await botSend(String(map.channelId), 'стиль тул-уведомлений: `' + (map.toolStyle || TOOL_STYLE) + '`\nдоступно: `' + okv.join('`, `') + '`\nпример:\n' + toolNoticeText('Exec Check duplicate mirrors', map.toolStyle));
        return;
      }
      if (!okv.includes(a)) { await botSend(String(map.channelId), 'использование: `/toolstyle code|quote|spoiler|plain|off`'); return; }
      map.toolStyle = a;
      const ok = saveBridges();
      await botSend(String(map.channelId), 'стиль тул-уведомлений: `' + a + '`' + (ok ? '' : ' (не удалось сохранить в bridges.json)'));
      return;
    }
    if (cmd === 'toolticker') {
      const a = String(arg || '').trim().toLowerCase();
      if (a === 'on') map.toolTicker = true;
      else if (a === 'off') map.toolTicker = false;
      else if (a !== '') { await botSend(String(map.channelId), 'использование: `/toolticker on` или `/toolticker off`'); return; }
      const ok = saveBridges();
      await botSend(String(map.channelId), 'тул-вызовы одним блоком-тикером: ' + (map.toolTicker === false ? 'выкл (каждый вызов отдельно)' : 'вкл') + (ok ? '' : ' (не удалось сохранить в bridges.json)'));
      return;
    }
    if (cmd === 'typing') {
      const a = String(arg || '').trim().toLowerCase();
      if (a === 'on') map.typing = true;
      else if (a === 'off') map.typing = false;
      else if (a !== '') { await botSend(String(map.channelId), 'использование: `/typing on` или `/typing off`'); return; }
      const ok = saveBridges();
      await botSend(String(map.channelId), 'индикатор «печатает»: ' + (map.typing === false ? 'выкл' : 'вкл') + (ok ? '' : ' (не удалось сохранить в bridges.json)'));
      return;
    }
    if (cmd === 'models' || cmd === 'modelall' || (cmd === 'model' && String(arg || '').trim().toLowerCase() === 'all')) {
      const all = cmd === 'modelall' || String(arg || '').trim().toLowerCase() === 'all';
      const r = await req('models.list', { view: all ? 'all' : 'default' });
      const list = (r && r.models) || [];
      const shown = all ? list : list.filter(m => m.available !== false);
      const by = new Map();
      for (const m of shown) {
        const pr = m.provider || 'other';
        if (!by.has(pr)) by.set(pr, []);
        by.get(pr).push(m);
      }
      const out = ['**Модели: ' + shown.length + (all ? ' (включая недоступные)' : ' доступных') + '**'];
      for (const pr of [...by.keys()].sort()) {
        const arr = by.get(pr).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
        out.push('');
        out.push('**' + pr + '** (' + arr.length + ')');
        for (const m of arr) {
          const ctx = m.contextWindow ? ' · ' + Math.round(m.contextWindow / 1000) + 'k' : '';
          const flag = m.available === false ? ' · недоступна' : '';
          out.push('`' + pr + '/' + m.id + '`' + ctx + flag);
        }
      }
      out.push('');
      out.push('Сменить модель: `/model <provider/id>`');
      await botSend(String(map.channelId), out.join('\n'));
      return;
    }
    if (cmd === 'modelprovider' || cmd === 'modelproviders') {
      const p = String(arg || '').trim().toLowerCase();
      const r = await req('models.list', { view: 'all' });
      const list = (r && r.models) || [];
      if (!p) {
        const by = new Map();
        for (const m of list) { const pr = m.provider || 'other'; by.set(pr, (by.get(pr) || 0) + 1); }
        const out = ['**Провайдеры: ' + by.size + '**'];
        for (const pr of [...by.keys()].sort()) out.push('`' + pr + '` — ' + by.get(pr) + ' моделей');
        out.push('');
        out.push('Модели провайдера: `/modelprovider <провайдер>`');
        await botSend(String(map.channelId), out.join('\n'));
        return;
      }
      const arr = list.filter(m => String(m.provider || '').toLowerCase() === p);
      if (!arr.length) {
        await botSend(String(map.channelId), 'провайдера `' + p + '` нет. Список: `/modelprovider`');
        return;
      }
      arr.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const out = ['**' + p + '** — ' + arr.length + ' моделей'];
      for (const m of arr) {
        const ctx = m.contextWindow ? ' · ' + Math.round(m.contextWindow / 1000) + 'k' : '';
        out.push('`' + p + '/' + m.id + '`' + ctx + (m.available === false ? ' · недоступна' : ''));
      }
      await botSend(String(map.channelId), out.join('\n'));
      return;
    }
    if (cmd === 'model') {
      const cur = map.__model || null;
      if (!arg) {
        let row = null;
        try {
          const l = await req('sessions.list', {});
          const arr = (l && (l.sessions || l.items)) || [];
          row = arr.find(x => x && x.key === key) || null;
        } catch (e) { /* ignore */ }
        await botSend(String(map.channelId), 'текущая модель: `' + ((row && row.model) || 'default') + '`\nсменить: `/model <id>`');
        return;
      }
      const value = arg.trim() === 'default' ? null : arg.trim();
      if (value) {
        // Проверяем id по каталогу: опечатка иначе ломает сессию («модель не найдена»).
        let known = false;
        try {
          const r = await req('models.list', { view: 'all' });
          const list = (r && r.models) || [];
          known = list.some(m => String(m.provider || '') + '/' + String(m.id) === value || String(m.id) === value);
        } catch (e) { known = true; }
        if (!known) {
          await botSend(String(map.channelId), 'модели `' + value + '` нет. Список: `/modelall`');
          return;
        }
      }
      await req('sessions.patch', Object.assign({ key, model: value }, extra));
      await botSend(String(map.channelId), 'модель сессии: `' + (value || 'default') + '`');
      return;
    }
    if (cmd === 'ctx') {
      const u = await contextSnapshot(map.sessionKey);
      if (!u) { await botSend(String(map.channelId), 'не удалось получить оценку контекста (сессия не найдена?)'); return; }
      await botSend(String(map.channelId), [
        '**Контекст:** ' + u.pct + '% (оценка ' + fmtTokens(u.used) + ' из ' + fmtTokens(u.budget) + ' токенов)',
        'модель: `' + (u.model || 'default') + '`',
        u.shouldCompact ? 'OpenClaw: пора сжимать (`shouldCompact`)' : 'OpenClaw: запас есть',
        'плашка при ' + CTX_THRESHOLDS.join('/') + '%: ' + (map.ctxWarn === false ? 'выкл' : 'вкл') +
          ' · автокомпакция: ' + (CTX_AUTOCOMPACT && map.ctxCompact !== false ? 'вкл' : 'выкл'),
        'сжать сейчас: `/compact`; ветка с текущим контекстом: `/chatadd tree`',
      ].join('\n'));
      return;
    }
    if (cmd === 'ctxwarn') {
      const a = String(arg || '').trim().toLowerCase();
      if (a === 'on') map.ctxWarn = true;
      else if (a === 'off') map.ctxWarn = false;
      else if (a !== '') { await botSend(String(map.channelId), 'использование: `/ctxwarn on` или `/ctxwarn off`'); return; }
      const ok = saveBridges();
      if (map.ctxWarn !== false) { const st = ctxState.get(map.sessionKey); if (st) st.seen = false; }
      await botSend(String(map.channelId), 'авто-плашка о контексте: ' + (map.ctxWarn === false ? 'выкл' : 'вкл') + (ok ? '' : ' (не удалось сохранить в bridges.json)'));
      return;
    }
    if (cmd === 'ctxcompact') {
      const a = String(arg || '').trim().toLowerCase();
      if (a === 'on') map.ctxCompact = true;
      else if (a === 'off') map.ctxCompact = false;
      else if (a !== '') { await botSend(String(map.channelId), 'использование: `/ctxcompact on` или `/ctxcompact off`'); return; }
      const ok = saveBridges();
      await botSend(String(map.channelId), 'принудительная компакция при полном контексте: ' + (map.ctxCompact === false ? 'выкл' : 'вкл') + (ok ? '' : ' (не сохранилось в bridges.json)'));
      return;
    }
    if (cmd === 'chatadd') {
      const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
      let mode = 'new';
      if (parts.length && /^(new|tree)$/i.test(parts[0])) mode = parts.shift().toLowerCase();
      const title = parts.join(' ');
      await botSend(String(map.channelId), mode === 'tree' ? 'создаю ветку чата…' : 'создаю новый чат…');
      const r = await addChatSession(map, mode, title, map.__parentId);
      await botSend(String(map.channelId), [
        '**Создано:** канал «' + r.entry.name + '»',
        'сессия: `' + r.sessionKey + '`',
        'агент: `' + (r.entry.agentId || 'main') + '` · модель: `' + r.model + '`',
        mode === 'tree' ? 'режим: ветка от текущего чата (контекст продолжается)' : 'режим: новый чат с той же моделью и агентом',
        'Канал уже привязан — пиши в него.',
      ].join('\n'));
      await botSend(r.entry.channelId, 'Этот канал привязан к сессии `' + r.sessionKey + '` (агент `' + (r.entry.agentId || 'main') + '`).' + (mode === 'tree' ? '\nВетка продолжает контекст исходного чата.' : ''));
      return;
    }
    if (cmd === 'think') {
      if (!arg) { await botSend(String(map.channelId), 'укажи уровень: `/think off|minimal|low|medium|high`'); return; }
      await req('sessions.patch', Object.assign({ key, thinkingLevel: arg.trim() }, extra));
      await botSend(String(map.channelId), 'уровень размышлений: `' + arg.trim() + '`');
      return;
    }
    await botSend(String(map.channelId), 'Неизвестная команда: `/' + cmd + '`. Список: `/help`');
  } catch (e) {
    await botSend(String(map.channelId), 'команда `/' + cmd + '` не выполнена: ' + e.message);
  }
}

const lolka = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

lolka.once('ready', async c => {
  log('[lolka] ready as ' + c.user.username + ', mappings: ' + MAPPINGS.length);
  for (const m of MAPPINGS) { await ensureWebhook(m); }
  await learnOwner();
  log('[hook] ready for', MAPPINGS.filter(m => m.webhookUrl).length, '/', MAPPINGS.length);
});

lolka.on('messageCreate', async msg => {
  try {
    const a = msg.author || {};
    const isSelf = String(a.id) === String(lolka.user && lolka.user.id);
    const text = (msg.content || '').trim();
    const map = byChannel.get(String(msg.channel_id !== undefined ? msg.channel_id : (msg.channel && msg.channel.id)));
    if (!map) return;
    if (a.bot || a.is_webhook || msg.webhook_id) {
      if (ALLOW_SELF_CMDS && isSelf && text.startsWith('/')) {
        const ps = text.slice(1).split(/\s+/);
        await handleCommand(map, ps[0].toLowerCase(), ps.slice(1).join(' '));
      }
      return;
    }
    if (!text) return;
    if (a.username && !OWNER) { OWNER = { username: a.global_name || a.username, avatar: a.avatar, id: a.id }; saveOwner(); }

    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      if (!canUseCommands(msg, a)) {
        log('[lolka->cmd] denied ' + map.name + ' <' + a.username + '> /' + parts[0]);
        const now = Date.now();
        if (!cmdDeniedAt.has(map.channelId) || now - cmdDeniedAt.get(map.channelId) > 60000) {
          cmdDeniedAt.set(map.channelId, now);
          await botSend(String(map.channelId), 'команды моста доступны только владельцу сервера');
        }
        return;
      }
      log('[lolka->cmd] ' + map.name + ' /' + parts[0]);
      map.__parentId = (msg.channel && (msg.channel.parent_id || msg.channel.parentId)) || null;
      await handleCommand(map, parts[0].toLowerCase(), parts.slice(1).join(' '));
      return;
    }

    log('[lolka->oc] ' + map.name + ' <' + a.username + '> ' + text.slice(0, 80));
    recentInbound.set(norm(text), Date.now());
    typingStart(map.channelId);
    sendReq('sessions.send', Object.assign({
      key: map.sessionKey,
      message: '[Lolka/' + map.name + '] ' + text,
      idempotencyKey: 'lolka:' + msg.id,
    }, map.agentId ? { agentId: map.agentId } : {}));
  } catch (e) { log('[lolka] handler error', e.message); }
});
lolka.on('interactionCreate', async it => {
  try {
    if (!it || typeof it.customId !== 'string' || !it.customId.startsWith('bridge:')) return;
    if (!isAdminId(it.user && it.user.id)) {
      try { await it.reply({ content: 'эти кнопки доступны только владельцу', ephemeral: true }); } catch {}
      return;
    }
    const map = byChannel.get(String(it.channelId));
    if (!map) return;
    const action = it.customId.slice(7);
    const key = map.sessionKey;
    const extra = map.agentId ? { agentId: map.agentId } : {};
    if (action === 'compact') {
      await req('sessions.compact', Object.assign({ key }, extra));
      await it.update({ content: 'компакция запущена', components: [statusButtons()] });
      return;
    }
    if (action === 'stop') {
      await req('sessions.abort', Object.assign({ key }, extra));
      await it.update({ content: 'прогон остановлен', components: [statusButtons()] });
      return;
    }
    if (action === 'status') {
      const d = await req('sessions.describe', { key });
      let row = null;
      try {
        const l = await req('sessions.list', {});
        const arr = (l && (l.sessions || l.items)) || [];
        row = arr.find(x => x && x.key === key) || null;
      } catch (e) { /* ignore */ }
      await it.update({ content: fmtStatus(map.name, d, row), components: [statusButtons()] });
      return;
    }
  } catch (e) { log('[ui] interaction error:', e.message); }
});
lolka.on('error', e => log('[lolka] error', (e && e.message) || e));

function connectGateway() {
  ws = new WebSocket('ws://127.0.0.1:' + PORT);
  ws.addEventListener('message', ev => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }

    if (f.type === 'event' && f.event === 'connect.challenge') {
      ws.send(JSON.stringify({
        type: 'req', id: 'connect', method: 'connect',
        params: {
          minProtocol: 4, maxProtocol: 4,
          client: { id: 'cli', version: '0.0.3', platform: process.platform, mode: 'cli' },
          role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'],
          caps: [], commands: [], permissions: {},
          auth: { token: TOKEN }, locale: 'ru-RU', userAgent: 'lolka-bridge/0.3',
        },
      }));
      return;
    }
    if (f.type === 'res' && f.id === 'connect') {
      if (!f.ok) { log('[gw] connect failed', JSON.stringify(f.error)); outbox.saveState(); process.exit(1); }
      log('[gw] connected, protocol', f.payload && f.payload.protocol);
      outbox.pokeAll();
      for (const m of MAPPINGS) sendReq('sessions.messages.subscribe', Object.assign({ key: m.sessionKey }, m.agentId ? { agentId: m.agentId } : {}));
      sendReq('sessions.subscribe', {});
      log('[gw] subscribed:', MAPPINGS.map(m => m.name).join(', '));
      return;
    }
    if (f.type === 'res' && waiters.has(f.id)) {
      const w = waiters.get(f.id); waiters.delete(f.id);
      if (f.ok) w.resolve(f.payload); else w.reject(new Error(JSON.stringify(f.error || {}).slice(0, 200)));
      return;
    }

    if (f.type === 'event' && f.event === 'session.message') {
      const p = f.payload || {};
      const map = bySession.get(p.sessionKey);
      if (!map) return;
      contextNotice(map).catch(() => {}); // авто-плашка о заполнении контекста
      if (process.env.LOLKA_BRIDGE_DEBUG) { try { fs.appendFileSync(path.join(DIR, 'events.jsonl'), JSON.stringify(p).slice(0, 3000) + '\n'); } catch {} }
      const msg = p.message || {};
      const role = msg.role || msg.author;
      // Индикатор «печатает»: держим, пока в сессии реально идёт работа агента.
      // Работает для любого агента/канала — привязка идёт по sessionKey → map.
      if (role === 'user') typingStart(map.channelId);
      // Индикатор гасит только sendFinal/finishRun: он должен жить до отправки
      // финального ответа, а не гаснуть на промежуточных событиях.
      const cst = ctxStateFor(p.sessionKey);
      if (role === 'user') cst.pendingSince = Date.now();
      else if (role === 'assistant') cst.pendingSince = 0;
      const text = textOf(msg).trim();
      if (!text) { if (role === 'assistant') typingStop(map.channelId); return; }
      if (markSeen(p.messageId || msg.id || (p.sessionKey + ':' + p.messageSeq))) return;
      if (/agent run failed before producing a reply/i.test(text)) { log('[oc] skip error msg'); if (role === 'assistant') typingStop(map.channelId); return; }
      if (text.indexOf('[Lolka/') !== -1) { log('[oc] skip lolka-origin msg'); return; }
      if (/^(Continue the OpenClaw runtime event|HEARTBEAT|Queued user message)/i.test(text)) { log('[oc] skip runtime msg'); return; }
      if (role === 'user') {
        if (p.senderIsOwner === false) { log('[oc] skip non-owner msg'); return; }
        const ts = recentInbound.get(norm(text));
        if (ts && Date.now() - ts < 30000) { log('[oc] skip echo of lolka msg'); return; }
        const url = map.webhookUrl;
        log('[oc->lolka] ' + map.name + ' user (' + text.length + ' chars)' + (url ? ' via webhook' : ''));
        if (url) hookSend(url, text, OWNER || undefined).catch(e => log('[lolka] hook error', e.message));
        else botSend(String(map.channelId), '**Вы:** ' + text).catch(e => log('[lolka] send error', e.message));
        return;
      }
      if (role !== 'assistant') return;
      if (msg.stopReason === 'toolUse') { log('[oc] skip interim (toolUse)'); return; }
      log('[oc->lolka] ' + map.name + ' assistant (' + text.length + ' chars)');
      sendFinal(map, text);
      return;
    }

    if (f.type === 'event' && (f.event === 'session.operation' || f.event === 'agent')) {
      const p = f.payload || {};
      const map = bySession.get(p.sessionKey);
      if (!map) return;
      if (f.event === 'session.operation') {
        const st = p.status || (p.operation && p.operation.status);
        const opName = (p.operation && (p.operation.name || p.operation.kind)) || p.name || p.kind;
        // «Печатает» — по факту работы агента, независимо от показа уведомлений.
        if (st === 'started') typingStart(map.channelId);
        else if (st === 'finished' || st === 'completed') typingStopSoon(map.channelId, Number(process.env.LOLKA_TYPING_GRACE_MS || 10000));
        if (!map.notices) return;
        if (st === 'started') { botSend(String(map.channelId), 'операция: ' + scrubLinks(opName || 'started')).catch(() => {}); }
        else if (st === 'finished' || st === 'completed') { botSend(String(map.channelId), 'операция завершена: ' + scrubLinks(opName || '')).catch(() => {}); }
        return;
      }
      if (!map.notices) return;
      const d = p.data || {};
      if (d.kind === 'tool' && d.phase === 'start' && d.title) {
        const style = String(map.toolStyle || TOOL_STYLE).toLowerCase();
        if (style === 'off') return;
        if (TOOL_TICKER && map.toolTicker !== false) { tickerAdd(map, d.title); return; }
        const tn = toolNoticeText(d.title, map.toolStyle);
        if (tn) botSend(String(map.channelId), tn).catch(() => {});
      }
      return;
    }
  });
  ws.addEventListener('open', () => log('[gw] open'));
  ws.addEventListener('close', () => scheduleReconnect('close'));
  ws.addEventListener('error', e => {
    log('[gw] error', (e && e.message) || e);
    if (!ws || ws.readyState !== 1) scheduleReconnect('error');
  });
}

// Уведомления о тул-вызовах: code|quote|spoiler|plain|off
const TOOL_STYLE = process.env.LOLKA_TOOL_STYLE || 'code';
// Ссылки в уведомлениях тул-вызовов Lolka превращает в прикреплённые превью и ломает вид чата.
// Это служебная строка, а не сообщение — URL из неё вырезаем. Выключить: LOLKA_TOOL_SCRUB_LINKS=0
const TOOL_SCRUB_LINKS = process.env.LOLKA_TOOL_SCRUB_LINKS !== '0';
const LINK_PLACEHOLDER = '⟨ссылка⟩';
function scrubLinks(text) {
  if (!TOOL_SCRUB_LINKS) return String(text);
  return String(text)
    .replace(/https?:\/\/[^\s<>"'`]+/gi, LINK_PLACEHOLDER)
    .replace(/\bwww\.[^\s<>"'`]+/gi, LINK_PLACEHOLDER);
}
function toolIcon(title) {
  const t = String(title);
  if (/^(exec|bash|shell|process|terminal)/i.test(t)) return '⚙';
  if (/^(edit|write|patch|apply)/i.test(t)) return '✎';
  if (/^(read|ls|glob|grep|search|open)/i.test(t)) return '🔍';
  if (/^(web|http|fetch|curl)/i.test(t)) return '🌐';
  return '🔧';
}
function toolNoticeTitle(title) {
  const t = scrubLinks(String(title)).replace(/\s+/g, ' ').trim().slice(0, 160);
  return toolIcon(t) + ' ' + t;
}
function toolNoticeText(title, style) {
  const st = String(style || TOOL_STYLE).toLowerCase();
  if (st === 'off') return null;
  const line = toolNoticeTitle(title);
  if (st === 'quote') return '> ' + line;
  if (st === 'spoiler') return '||' + line + '||';
  if (st === 'plain') return line;
  return '```\n' + line + '\n```'; // code (по умолчанию): отдельный моноширинный блок
}

/* ---- тикер тул-вызовов: серия вызовов = ОДНО сообщение, дописывается правкой ----
 * Вместо 20 сообщений в канал уходит один блок; каждый следующий вызов инструмента
 * дописывается в него через PATCH. Когда агент отвечает текстом - блок закрывается
 * («завершено»), следующий вызов начинает новый блок.
 * Отключить: LOLKA_TOOL_TICKER=0; размер окна: LOLKA_TOOL_TICKER_MAX (строк).
 */
const TOOL_TICKER = process.env.LOLKA_TOOL_TICKER !== '0';
const TOOL_TICKER_MAX = process.env.LOLKA_TOOL_TICKER_MAX ? Number(process.env.LOLKA_TOOL_TICKER_MAX) : 15;
const TOOL_TICKER_FLUSH_MS = process.env.LOLKA_TOOL_TICKER_FLUSH_MS ? Number(process.env.LOLKA_TOOL_TICKER_FLUSH_MS) : 900;
const TOOL_TICKER_LIMIT = 1750; // символов в одном сообщении
const tickers = new Map(); // channelId -> { messageId, lines, total, timer, busy }

function shortTime(now) {
  try { return new Date(now).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Yakutsk', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return new Date(now).toISOString().slice(11, 16); }
}
function tickerFor(channelId) {
  let st = tickers.get(channelId);
  if (!st) { st = { messageId: null, lines: [], total: 0, timer: null, busy: false }; tickers.set(channelId, st); }
  return st;
}
function tickerText(st, fenced, done) {
  const head = '🗂 **Инструменты: ' + st.total + '** — ' + (done ? 'завершено' : 'идёт…');
  const picked = []; let len = 0;
  for (let i = st.lines.length - 1; i >= 0; i--) {
    const l = st.lines[i];
    if (picked.length >= TOOL_TICKER_MAX) break;
    if (picked.length && len + l.length + 1 > TOOL_TICKER_LIMIT) break;
    picked.unshift(l); len += l.length + 1;
  }
  const hidden = st.lines.length - picked.length;
  const body = (hidden > 0 ? ['… ещё ' + hidden + ' раньше'] : []).concat(picked);
  return head + '\n' + (fenced ? '```\n' + body.join('\n') + '\n```' : body.join('\n'));
}
async function tickerFlush(map, st, done) {
  st.timer = null;
  if (st.busy) return;
  st.busy = true;
  try {
    const fenced = String(map.toolStyle || TOOL_STYLE).toLowerCase() !== 'plain';
    const text = tickerText(st, fenced, !!done);
    if (!st.messageId) {
      const r = await botSendQueued(String(map.channelId), text);
      st.messageId = (r && r.id) ? String(r.id) : null;
      if (!st.messageId && !r) { st.lines = []; st.total = 0; }
      log('[ticker] ' + map.name + ': блок создан (' + st.total + ' выз.)');
    } else {
      await botEdit(String(map.channelId), st.messageId, text);
    }
  } finally { st.busy = false; }
}
function tickerAdd(map, title) {
  const st = tickerFor(String(map.channelId));
  st.lines.push(shortTime(Date.now()) + ' ' + toolNoticeTitle(title));
  if (st.lines.length > 200) st.lines.splice(0, st.lines.length - 200);
  st.total++;
  if (!st.timer) st.timer = setTimeout(() => tickerFlush(map, st, false).catch(() => {}), TOOL_TICKER_FLUSH_MS);
}
function tickerClose(map) {
  const id = String(map.channelId);
  const st = tickers.get(id);
  if (!st || !st.total) return;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  const fin = { messageId: st.messageId, lines: st.lines.slice(), total: st.total, timer: null, busy: false };
  st.messageId = null; st.lines = []; st.total = 0; // следующий вызов начнёт новый блок
  if (fin.messageId) tickerFlush(map, fin, true).catch(() => {});
}

let reconnectTimer = null;
function scheduleReconnect(why) {
  if (reconnectTimer) return;
  log('[gw] closed, reconnect in 5s (' + why + ')');
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectGateway(); }, 5000);
}
// Сторож: если сокет к гейтвею не открыт - переподключаемся, даже если события молчат.
setInterval(() => {
  if (!ws || ws.readyState !== 1) scheduleReconnect('watchdog');
}, 30000);
// Сторож контекста: даже без новых сообщений проверяем заполнение по всем каналам.
setInterval(() => {
  for (const m of MAPPINGS) contextNotice(m).catch(() => {});
}, CTX_SWEEP_MS);

function startBridge() {
  connectGateway();
  lolka.login(lolkaToken).catch(e => { log('[lolka] login failed', (e && e.message) || e); process.exit(1); });
  process.on('SIGINT', () => { log('bye'); process.exit(0); });
}

if (require.main === module) startBridge();

module.exports = { scrubLinks, toolNoticeTitle, toolNoticeText };
