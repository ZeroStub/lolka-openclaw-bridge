#!/usr/bin/env node
'use strict';
// PoC: подключение к gateway OpenClaw по WS + подписка на сообщения сессии.
// Запуск: node gw-subscribe.js <sessionKey> [seconds]
const fs = require('node:fs');
const os = require('node:os');

const cfgPath = process.env.OPENCLAW_CONFIG_PATH || `${os.homedir()}/.openclaw/openclaw.json`;
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const port = cfg.gateway?.port ?? 18789;
const token = cfg.gateway?.auth?.token;
const key = process.argv[2];
const seconds = Number(process.argv[3] || 30);
if (!key) { console.error('usage: node gw-subscribe.js <sessionKey> [seconds]'); process.exit(2); }

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let id = 0;
const pending = new Map();

function send(method, params) {
  const rid = `r${++id}`;
  ws.send(JSON.stringify({ type: 'req', id: rid, method, params }));
  return rid;
}

ws.addEventListener('message', ev => {
  let f; try { f = JSON.parse(ev.data); } catch { return; }
  if (f.type === 'event' && f.event === 'connect.challenge') {
    ws.send(JSON.stringify({
      type: 'req', id: 'connect', method: 'connect',
      params: {
        minProtocol: 4, maxProtocol: 4,
        client: { id: 'cli', version: '0.0.1', platform: process.platform, mode: 'cli' },
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        caps: [], commands: [], permissions: {},
        auth: { token },
        locale: 'ru-RU',
        userAgent: 'bridge-poc/0.0.1',
      },
    }));
    return;
  }
  if (f.type === 'res' && f.id === 'connect') {
    if (!f.ok) { console.error('connect failed:', JSON.stringify(f.error)); process.exit(1); }
    console.log('[ws] connected, protocol', f.payload?.protocol, 'scopes', f.payload?.auth?.scopes);
    send('sessions.messages.subscribe', { key });
    console.log('[ws] subscribed to', key);
    return;
  }
  if (f.type === 'event') {
    console.log('[event]', f.event, JSON.stringify(f.payload).slice(0, 400));
  }
});
ws.addEventListener('error', e => console.error('[ws error]', e.message || e));
ws.addEventListener('open', () => console.log('[ws] open, waiting challenge…'));

setTimeout(() => { console.log('[ws] done'); process.exit(0); }, seconds * 1000);
