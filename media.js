// Вложения для моста Lolka ↔ OpenClaw.
// Входящие: скачать файлы сообщения и отдать гейтвею как attachments (base64).
// Исходящие: найти ссылки на медиа в ответе агента и отправить файлы в канал.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MEDIA_MAX_MB = Number(process.env.LOLKA_MEDIA_MAX_MB || 20);
const MEDIA_IMAGE_MAX_MB = Number(process.env.LOLKA_MEDIA_IMAGE_MAX_MB || 6);
const MEDIA_MAX_COUNT = Number(process.env.LOLKA_MEDIA_MAX_COUNT || 10);
const MEDIA_STORE = path.join(os.homedir(), '.openclaw', 'media', 'inbound');

function attList(msg) {
  const a = msg && msg.attachments;
  if (!a) return [];
  if (Array.isArray(a)) return a;
  if (typeof a.values === 'function') return Array.from(a.values());
  return [];
}

function attKind(mimeType, name) {
  const mt = String(mimeType || '').toLowerCase();
  const nm = String(name || '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('video/')) return 'video';
  if (/\.(png|jpe?g|gif|webp|bmp|heic)$/.test(nm)) return 'image';
  if (/\.(mp3|ogg|wav|m4a|flac)$/.test(nm)) return 'audio';
  if (/\.(mp4|mov|webm)$/.test(nm)) return 'video';
  return 'file';
}

/** Вырезает из текста ссылки на медиа, оставляя чистый текст. */
function extractMedia(text) {
  const files = [];
  let rest = String(text || '');
  rest = rest.replace(/^[ \t]*MEDIA:(?!\/\/)[ \t]*(\S+)[ \t]*$/gim, (all, ref) => { files.push(ref); return ''; });
  rest = rest.replace(/!\[[^\]]*\]\((media:\/\/[^\s)]+|\/[^\s)]+)\)/gi, (all, ref) => { files.push(ref); return ''; });
  rest = rest.replace(/\[media attached:\s*([^\]]+)\]/gi, (all, ref) => { files.push(ref.trim()); return ''; });
  rest = rest.replace(/media:\/\/inbound\/[^\s)\]>]+/gi, (ref) => { files.push(ref); return ''; });
  return { files: files.filter(Boolean), text: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

/** media://inbound/<id> | /abs/путь | ~/путь | http(s)-URL → путь или { url }. */
function resolveMediaRef(ref) {
  const raw = String(ref || '').trim().replace(/^MEDIA:(?!\/\/)\s*/i, '');
  if (!raw) return null;
  const m = /^media:\/\/inbound\/([^/?#]+)$/i.exec(raw);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!fs.existsSync(MEDIA_STORE)) return null;
    const hit = fs.readdirSync(MEDIA_STORE).find(f => f === id || f.startsWith(id + '.'));
    return hit ? path.join(MEDIA_STORE, hit) : null;
  }
  if (/^https?:/i.test(raw)) return { url: raw };
  if (raw.startsWith('/') || raw.startsWith('~')) {
    const p = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
    return fs.existsSync(p) ? p : null;
  }
  return null;
}

function createMediaTools(deps) {
  const { log, lolkaToken, botSend, chunk, getClient } = deps;

  async function fetchAttachment(att) {
    const url = att.url || att.proxyURL || att.proxy_url;
    if (!url) return null;
    const size = Number(att.size || 0);
    const kind = attKind(att.contentType || att.content_type, att.name);
    const capMb = kind === 'image' ? MEDIA_IMAGE_MAX_MB : MEDIA_MAX_MB;
    if (size && size > capMb * 1024 * 1024) {
      log('[media] пропуск (велик ' + Math.round(size / 1048576) + 'МБ > ' + capMb + 'МБ): ' + (att.name || url));
      return { tooLarge: true, name: att.name, sizeBytes: size };
    }
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: 'Bot ' + lolkaToken } });
      if (!res.ok && res.status === 401) res = await fetch(url); // CDN без авторизации
    } catch (e) {
      log('[media] ошибка скачивания', e.message);
      return { error: e.message, name: att.name };
    }
    if (!res.ok) { log('[media] HTTP ' + res.status + ' для ' + (att.name || url)); return { error: 'HTTP ' + res.status, name: att.name }; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > capMb * 1024 * 1024) {
      log('[media] пропуск (велик ' + Math.round(buf.length / 1048576) + 'МБ > ' + capMb + 'МБ): ' + (att.name || url));
      return { tooLarge: true, name: att.name, sizeBytes: buf.length };
    }
    const mimeType = att.contentType || att.content_type || res.headers.get('content-type') || 'application/octet-stream';
    return {
      type: kind,
      mimeType,
      fileName: att.name || ('file-' + att.id),
      content: buf.toString('base64'),
      sizeBytes: buf.length,
      ...(att.width ? { width: att.width } : {}),
      ...(att.height ? { height: att.height } : {}),
      ...(att.duration ? { durationMs: att.duration } : {}),
    };
  }

  /** Вложения сообщения Lolka → { attachments, notes }. */
  async function inboundMedia(msg) {
    const list = attList(msg).slice(0, MEDIA_MAX_COUNT);
    if (!list.length) return { attachments: [], notes: [] };
    const out = [];
    const notes = [];
    for (const att of list) {
      const r = await fetchAttachment(att);
      if (!r) continue;
      if (r.tooLarge) {
        notes.push('[файл не передан: ' + (r.name || 'без имени') + ', ' + Math.round((r.sizeBytes || 0) / 1048576) + ' МБ — больше лимита]');
        continue;
      }
      if (r.error) { notes.push('[файл не скачался: ' + (r.name || 'без имени') + ' — ' + r.error + ']'); continue; }
      out.push(r);
      notes.push('📎 ' + r.fileName + ' (' + r.mimeType + ', ' + Math.round(r.sizeBytes / 1024) + ' КБ)');
    }
    return { attachments: out, notes };
  }

  async function channelOf(channelId) {
    const id = String(channelId);
    const client = getClient();
    try {
      const cached = client && client.channels && client.channels.cache && client.channels.cache.get(id);
      if (cached) return cached;
      if (client && client.channels && typeof client.channels.fetch === 'function') return await client.channels.fetch(id);
    } catch (e) { log('[media] не удалось получить канал', e.message); }
    return null;
  }

  /** Отправить файлы (и текст) в канал. */
  async function sendMediaFiles(map, refs, text) {
    const files = [];
    for (const r of refs) {
      const p = resolveMediaRef(r);
      if (p) files.push(p); else log('[media] файл не найден: ' + r);
    }
    if (!files.length) { if (text) botSend(String(map.channelId), text); return; }
    const ch = await channelOf(map.channelId);
    if (!ch) { log('[media] канал недоступен, файлы не отправлены'); if (text) botSend(String(map.channelId), text); return; }
    if (text) for (const part of chunk(text, 1900)) {
      try { await ch.send({ content: part }); } catch (e) { log('[media] текст не ушёл', e.message); }
    }
    for (const item of files) {
      try {
        const { AttachmentBuilder } = require('lolka.js');
        const builders = [];
        if (typeof item === 'string') {
          const name = path.basename(item);
          const size = fs.statSync(item).size;
          if (size > MEDIA_MAX_MB * 1024 * 1024) { log('[media] слишком велик: ' + name); continue; }
          builders.push(new AttachmentBuilder(item, { name }));
        }
        if (!builders.length) continue;
        await ch.send({ files: builders });
        log('[media] отправлен файл ' + (typeof item === 'string' ? path.basename(item) : item.url));
      } catch (e) { log('[media] ошибка отправки файла', e.message); }
    }
  }

  return { inboundMedia, sendMediaFiles, extractMedia, resolveMediaRef, attList };
}

module.exports = { createMediaTools, extractMedia, resolveMediaRef, attList, attKind, MEDIA_MAX_MB, MEDIA_IMAGE_MAX_MB };
