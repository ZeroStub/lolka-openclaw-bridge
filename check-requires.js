#!/usr/bin/env node
'use strict';
/**
 * Проверка локальных require/import: каждая относительная ссылка должна
 * разрешаться в существующий файл.
 *
 * Зачем: `node --check` проверяет только синтаксис и не резолвит require,
 * поэтому забытый в публикации модуль вылезает лишь при запуске — уже у
 * пользователя. Этот скрипт ловит такое в CI.
 *
 * Запуск: node check-requires.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const SKIP = new Set(['node_modules', '.git', '__pycache__', 'outbox', 'media']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(c|m)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Ищет относительные ссылки в require(...) и import ... from '...'. */
function refsOf(code) {
  const refs = [];
  const patterns = [
    /require\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /from\s+['"](\.[^'"]+)['"]/g,
    /import\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) refs.push({ ref: m[1], index: m.index });
  }
  return refs;
}

function resolves(fromFile, ref) {
  const base = path.resolve(path.dirname(fromFile), ref);
  const candidates = [base, base + '.js', base + '.cjs', base + '.mjs', base + '.json'];
  for (const ext of ['.js', '.cjs', '.mjs', '.json']) candidates.push(path.join(base, 'index' + ext));
  return candidates.some(c => { try { return fs.statSync(c).isFile(); } catch { return false; } });
}

function lineOf(code, index) {
  return code.slice(0, index).split('\n').length;
}

/** Ссылки в `try { require('./x') } catch` считаем опциональными и пропускаем. */
function isOptional(code, index) {
  const lineStart = code.lastIndexOf('\n', index) + 1;
  const lineEnd = code.indexOf('\n', index);
  const line = code.slice(lineStart, lineEnd < 0 ? code.length : lineEnd);
  return /\btry\s*\{/.test(line);
}

const problems = [];
for (const file of walk(ROOT)) {
  if (path.basename(file) === 'check-requires.js') continue;
  const code = fs.readFileSync(file, 'utf8');
  for (const { ref, index } of refsOf(code)) {
    if (isOptional(code, index)) continue;
    if (!resolves(file, ref)) problems.push(`${path.relative(ROOT, file)}:${lineOf(code, index)} → ${ref}`);
  }
}

if (problems.length) {
  console.error('не разрешаются локальные модули:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('локальные require/import: все ссылки разрешаются');