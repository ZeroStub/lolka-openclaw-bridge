#!/usr/bin/env node
'use strict';
// Пост в канал Lolka через входящий вебхук (без бот-токена).
// URL вебхука берётся из: --url, env LOLKA_WEBHOOK_URL, или файла ./.webhook
// Использование:
//   node webhook.js "текст"
//   node webhook.js --slack "текст"     # через Slack-совместимый эндпоинт
const fs = require('node:fs');
const path = require('node:path');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function readUrl() {
  const u = arg('--url');
  if (u) return u.trim();
  if (process.env.LOLKA_WEBHOOK_URL) return process.env.LOLKA_WEBHOOK_URL.trim();
  const f = path.join(__dirname, '.webhook');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return null;
}

(async () => {
  const url = readUrl();
  if (!url) {
    console.error('Нет URL вебхука. Задай --url, LOLKA_WEBHOOK_URL или положи URL в ./.webhook');
    process.exit(2);
  }
  const slack = process.argv.includes('--slack');
  const text = arg('--text') || process.argv.filter(a => !a.startsWith('--') && a !== url).slice(2).join(' ') || 'Привет от OpenClaw 🖤 (тест вебхука)';
  const endpoint = slack ? `${url.replace(/\/$/, '')}/slack` : url;
  const payload = slack
    ? { text }
    : { content: text, username: 'OpenClaw' };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log('POST', endpoint.replace(/\/([^/]{6})[^/]*$/, '/$1…'), '->', res.status);
  console.log(body.slice(0, 800));
  if (!res.ok) process.exit(1);
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
