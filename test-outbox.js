'use strict';
/**
 * Регресс-тест очереди outbox (без сети, на фейковом deliver).
 * Запуск: node test-outbox.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { createOutbox } = require('./outbox');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
const quiet = !!process.env.QUIET;
const log = quiet ? () => {} : (...a) => console.log('    ·', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mk(deliver, extra) {
  return createOutbox(Object.assign({
    log, deliver, retryDelays: [50, 100, 150], parkRetryMs: 400, idleWaitMs: 3600000,
    statePath: path.join(tmp, 'outbox.json'), deadLetterPath: path.join(tmp, 'dead.jsonl'),
  }, extra || {}));
}

(async () => {
  // A. два сетевых сбоя -> успех
  let calls = 0; const sentA = [];
  const a = mk(async it => { calls++; if (calls <= 2) throw new Error('ECONNRESET'); sentA.push(it.text); return { ok: true }; });
  a.enqueue('k', { kind: 'bot', text: 'A1', channelId: '1' }, 'test');
  await sleep(800);
  assert.deepStrictEqual(sentA, ['A1'], 'A: доставлено после ретраев');
  assert.strictEqual(a.pending(), 0, 'A: очередь пуста');
  assert.strictEqual(a.stats().retriedMessages, 1, 'A: 1 сообщение потребовало ретраев');
  assert.strictEqual(a.stats().retryAttempts, 2, 'A: 2 повторных попытки');
  console.log('✓ A: retry -> sent (сообщение доставлено со 3-й попытки)');

  // B. постоянная ошибка (403) -> dead-letter, очередь не стопорится
  const b = mk(async () => ({ ok: false, permanent: true, reason: 'HTTP 403 forbidden' }));
  b.enqueue('k', { kind: 'hook', text: 'B1', url: 'x' }, 'test');
  await sleep(300);
  assert.strictEqual(b.pending(), 0, 'B: элемент снят с очереди');
  assert.strictEqual(b.stats().dead, 1, 'B: 1 dead-letter');
  const dead = fs.readFileSync(path.join(tmp, 'dead.jsonl'), 'utf8');
  assert.ok(dead.includes('B1') && dead.includes('403'), 'B: dead-letter содержит текст и код');
  console.log('✓ B: permanent -> dead-letter, без вечного затыка');

  // C. вечный сбой -> парковка; новое сообщение будит очередь, порядок сохранён
  let up = false; const sentC = [];
  const c = mk(async it => { if (!up) throw new Error('ECONNREFUSED'); sentC.push(it.text); return { ok: true }; });
  c.enqueue('k', { kind: 'bot', text: 'C1', channelId: '1' }, 'test');
  await sleep(500);
  assert.strictEqual(c.pending(), 1, 'C: сообщение удержано в буфере');
  assert.strictEqual(c.stats().parked, 1, 'C: запарковано после 3 попыток');
  const attemptsBefore = c.stats().retryAttempts;
  assert.ok(attemptsBefore >= 3, 'C: до парковки было 3 попытки, было ' + attemptsBefore);
  c.enqueue('k', { kind: 'bot', text: 'C2', channelId: '1' }, 'test'); // новое сообщение -> poke
  up = true;
  await sleep(500);
  assert.deepStrictEqual(sentC, ['C1', 'C2'], 'C: отправлено в исходном порядке после разблокировки');
  assert.strictEqual(c.pending(), 0, 'C: очередь пуста');
  console.log('✓ C: park -> poke новым сообщением -> очередь доставлена (' + attemptsBefore + ' попыток до парковки)');

  // D. буфер переживает перезапуск: состояние на диск + восстановление
  const statePath = path.join(tmp, 'restore.json');
  const d1 = createOutbox({ log, deliver: () => new Promise(() => {}), retryDelays: [50], parkRetryMs: 400, idleWaitMs: 3600000, statePath });
  d1.enqueue('k', { kind: 'bot', text: 'D1', channelId: '7' }, 'test');
  d1.enqueue('k', { kind: 'bot', text: 'D2', channelId: '7' }, 'test');
  await sleep(1400); // дебаунс записи состояния
  const dump = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(dump.queues['k'].length, 2, 'D: оба сообщения сохранены на диск');
  const sentD = [];
  const d2 = createOutbox({ log, deliver: async it => { sentD.push(it.text); return { ok: true }; }, retryDelays: [50], parkRetryMs: 400, idleWaitMs: 3600000, statePath });
  const restored = d2.loadState();
  await sleep(400);
  assert.strictEqual(restored, 2, 'D: восстановлено 2 сообщения');
  assert.deepStrictEqual(sentD, ['D1', 'D2'], 'D: восстановленное отправлено по порядку');
  await sleep(1300); // дебаунс записи состояния после отправки
  assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).queues.k, undefined, 'D: файл состояния очищен после восстановления');
  console.log('✓ D: буфер переживает перезапуск (state -> restore)');

  // E. onResult: результат доставки возвращается тому, кто ставил в очередь (нужно тикеру)
  const e = mk(async it => ({ ok: true, id: 'msg-' + it.text }));
  const resE = await new Promise(resolve => {
    e.enqueue('k', { kind: 'bot', text: 'E1', channelId: '9', onResult: r => resolve(r) }, 'test');
  });
  assert.strictEqual(resE.id, 'msg-E1', 'E: onResult получил id созданного сообщения');
  const resE2 = await new Promise(resolve => {
    e.enqueue('k', { kind: 'bot', text: 'E2', channelId: '9', onResult: r => resolve(r) }, 'test');
  });
  assert.ok(resE2 && resE2.id, 'E: повторный вызов тоже получает результат');
  console.log('✓ E: onResult (id созданного сообщения) работает для тикера');

  // F. kind=edit: правка сообщения идёт через ту же очередь и сохраняет порядок
  const order = [];
  const f = mk(async it => { order.push(it.kind === 'edit' ? 'edit:' + it.messageId + '=' + it.text : it.kind + ':' + it.text); return { ok: true, id: 'x' }; });
  await new Promise(resolve => {
    f.enqueue('k', { kind: 'bot', text: 'C', channelId: '5', onResult: () => resolve() }, 'test');
  });
  f.enqueue('k', { kind: 'edit', channelId: '5', messageId: '42', text: 'E1' }, 'test');
  await sleep(300);
  assert.deepStrictEqual(order, ['bot:C', 'edit:42=E1'], 'F: создание, потом правка - тем же воркером');
  const dumpF = (() => { const g = createOutbox({ log, deliver: () => new Promise(() => {}), statePath: path.join(tmp, 'editstate.json') }); g.enqueue('k', { kind: 'edit', channelId: '5', messageId: '42', text: 'E2' }, 'test'); return null; })();
  await sleep(1300);
  const st = JSON.parse(fs.readFileSync(path.join(tmp, 'editstate.json'), 'utf8'));
  assert.strictEqual(st.queues.k[0].messageId, '42', 'F: messageId сохраняется в состояние (правка переживёт перезапуск)');
  console.log('✓ F: edit через очередь + messageId в состоянии');

  console.log('\nВсе проверки outbox пройдены.');
  process.exit(0);
})().catch(e => { console.error('✗ ТЕСТ УПАЛ:', e.message); process.exit(1); });
