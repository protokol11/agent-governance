// Headless-тесты ядра setup-upgrade на memoryFsAdapter.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalize,
  identityHash,
  buildManifest,
  classify,
  executePlan,
} from '../core.ts';
import { memoryFsAdapter } from '../fs.ts';

const CARD_A = '# Card\nGenerated: 2026-09-10\nVersion: abc123\n';
const CARD_B = '# Card\nGenerated: 2027-01-01\nVersion: abc123\n';

test('(a) normalize нейтрализует Generated: <date>', () => {
  assert.equal(normalize(CARD_A), '# Card\nGenerated: <date>\nVersion: abc123\n');
  assert.equal(identityHash(CARD_A), identityHash(CARD_B));
});

test('(b) classify -> ok / user-modified / missing', () => {
  const manifest = buildManifest({ 'a.md': CARD_A, 'b.md': 'x\n' });
  const onDisk = { 'a.md': CARD_B, 'b.md': 'changed by user\n' };
  const verdicts = classify(manifest, onDisk);
  assert.equal(verdicts['a.md'], 'ok');
  assert.equal(verdicts['b.md'], 'user-modified');
  assert.equal(verdicts['missing.md'], undefined);
  const verdicts2 = classify(manifest, { 'a.md': CARD_B });
  assert.equal(verdicts2['a.md'], 'ok');
  assert.equal(verdicts2['b.md'], 'missing');
});

test('(c) executePlan dryRun делает 0 записей на memoryFsAdapter', () => {
  const fs = memoryFsAdapter({ 'keep.md': 'user\n' });
  const plan = {
    schema_version: 1,
    ops: [
      { kind: 'ensure', path: 'new.md', reason: 'scaffold', content: 'new\n', conflictPolicy: 'overwrite' },
      { kind: 'ensure', path: 'keep.md', reason: 'scaffold', content: 'gen\n', conflictPolicy: 'keep-user' },
      { kind: 'skip', path: 'old.md', reason: 'noop', conflictPolicy: 'keep-user' },
      { kind: 'delete', path: 'gone.md', reason: 'cleanup', conflictPolicy: 'overwrite' },
    ],
  };
  const before = fs.snapshot();
  const result = executePlan(plan, fs, { dryRun: true });
  assert.equal(result.writes, 3);
  assert.deepEqual(fs.snapshot(), before);
  assert.equal(fs.read('new.md'), null);
});

test('(c2) executePlan без dryRun пишет и уважает keep-user', () => {
  const fs = memoryFsAdapter({ 'keep.md': 'user\n' });
  const plan = {
    schema_version: 1,
    ops: [
      { kind: 'ensure', path: 'new.md', reason: 'scaffold', content: 'new\n', conflictPolicy: 'overwrite' },
      { kind: 'ensure', path: 'keep.md', reason: 'scaffold', content: 'gen\n', conflictPolicy: 'keep-user' },
    ],
  };
  const result = executePlan(plan, fs, { dryRun: false });
  assert.equal(fs.read('new.md'), 'new\n');
  assert.equal(fs.read('keep.md'), 'user\n');
  assert.deepEqual(result.skipped, ['keep.md']);
});

// (d) Недетерминированный рендер -> throw.
// Мок-рендерер в temp: первый прогон детерминирован (только дата),
// второй — с счётчиком в файле, даёт разный normalized-контент.
test('(d) renderStamp бросает при недетерминированном рендере', async () => {
  const { renderStamp } = await import('../render.ts');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // Детерминированный мок: дата дрейфует, normalized-контент одинаков.
  const det = mkdtempSync(join(tmpdir(), 'mock-det-'));
  writeFileSync(join(det, 'render.mjs'), `
import { writeFileSync, mkdirSync } from 'node:fs';
const out = process.argv[process.argv.indexOf('--out') + 1];
mkdirSync(out, { recursive: true });
writeFileSync(out + '/x.md', 'same\\nGenerated: ' + new Date().toISOString().slice(0, 10) + '\\n');
`);
  const detTree = renderStamp({ renderer: join(det, 'render.mjs') });
  assert.equal(detTree['x.md'].startsWith('same\nGenerated:'), true);

  // Недетерминированный мок: счётчик вызовов меняет normalized-контент.
  const nonDet = mkdtempSync(join(tmpdir(), 'mock-nondet-'));
  writeFileSync(join(nonDet, 'render.mjs'), `
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const out = process.argv[process.argv.indexOf('--out') + 1];
mkdirSync(out, { recursive: true });
const counterFile = join(tmpdir(), 'mock-counter-' + process.ppid + '.txt');
const n = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) + 1 : 1;
writeFileSync(counterFile, String(n));
writeFileSync(out + '/x.md', 'body ' + n + '\\nGenerated: 2026-09-10\\n');
`);
  assert.throws(
    () => renderStamp({ renderer: join(nonDet, 'render.mjs') }),
    /non-deterministic/,
  );
  rmSync(det, { recursive: true, force: true });
  rmSync(nonDet, { recursive: true, force: true });
  rmSync(join(tmpdir(), `mock-counter-${process.pid}.txt`), { force: true });
});
