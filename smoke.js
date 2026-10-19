#!/usr/bin/env node
'use strict';
// Smoke-test Lolka Bot API (REST). Без зависимостей — только Node fetch.
// Токен читается из: --token, env LOLKA_BOT_TOKEN, или файла ./.token
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://lolka.app/api/bot/v10';

function readToken() {
  const i = process.argv.indexOf('--token');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1].trim();
  if (process.env.LOLKA_BOT_TOKEN) return process.env.LOLKA_BOT_TOKEN.trim();
  const f = path.join(__dirname, '.token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return null;
}

async function api(token, p) {
  const res = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bot ${token}` } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

(async () => {
  const token = readToken();
  if (!token) {
    console.error('Нет токена. Задай LOLKA_BOT_TOKEN или положи токен в ./.token');
    process.exit(2);
  }
  console.log('base =', BASE, '| token =', token.slice(0, 6) + '…' + token.slice(-4));

  const me = await api(token, '/users/@me');
  console.log('\nGET /users/@me ->', me.status);
  console.log(JSON.stringify(me.body, null, 2));

  if (me.status !== 200) {
    console.error('\n[!] Токен не принят (например 401). Проверь значение из портала разработчика.');
    process.exit(1);
  }

  const gw = await api(token, '/gateway/bot');
  console.log('\nGET /gateway/bot ->', gw.status);
  console.log(JSON.stringify(gw.body, null, 2));

  const guilds = await api(token, '/users/@me/guilds');
  console.log('\nGET /users/@me/guilds ->', guilds.status);
  console.log(JSON.stringify(guilds.body, null, 2));

  console.log('\n[ok] REST отвечает. Дальше: `node bot.js` для живого подключения к Gateway.');
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
