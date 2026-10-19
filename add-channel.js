#!/usr/bin/env node
'use strict';
// Создать текстовый канал в Lolka и привязать его к сессии OpenClaw.
// usage: node add-channel.js "<Название>" "<sessionKey>" [agentId]
const fs = require('node:fs');
const path = require('node:path');
const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'bridges.json'), 'utf8'));
const token = fs.readFileSync(path.join(DIR, '.token'), 'utf8').trim();
const [name, sessionKey, agentId] = process.argv.slice(2);
if (!name || !sessionKey) { console.error('usage: add-channel.js "<name>" "<sessionKey>" [agentId]'); process.exit(2); }
if (cfg.mappings.some(m => m.sessionKey === sessionKey)) { console.error('уже есть mapping для', sessionKey); process.exit(1); }

(async () => {
  const res = await fetch(`https://lolka.app/api/bot/v10/guilds/${cfg.guildId}/channels`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: 0 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('create failed', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
  const m = { channelId: String(body.id), name, sessionKey, ...(agentId ? { agentId } : {}) };
  cfg.mappings.push(m);
  fs.writeFileSync(path.join(DIR, 'bridges.json'), JSON.stringify(cfg, null, 2) + '\n');
  console.log('created channel', body.id, name, '->', sessionKey);
  console.log('restart: systemctl --user restart lolka-bridge.service');
})().catch(e => { console.error('error', e.message); process.exit(1); });
