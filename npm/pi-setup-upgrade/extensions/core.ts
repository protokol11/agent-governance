// Чистое ядро reconciler. Без pi-импортов, без прямого I/O.
// Портировано из tmp/setup-upgrade-prototype/core.mjs + executePlan.
import { createHash } from 'node:crypto';
import type { FileSystemAdapter, Manifest, Plan, PlanResult } from './types.ts';

// Нормализация: render.mjs вшивает `Generated: YYYY-MM-DD`.
// Дата косметична, не входит в идентичность.
export function normalize(content: string): string {
  return content
    .split('\n')
    .map((line) =>
      /^Generated: \d{4}-\d{2}-\d{2}$/.test(line.trim())
        ? 'Generated: <date>'
        : line,
    )
    .join('\n');
}

export function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function identityHash(content: string): string {
  return hash(normalize(content));
}

// files: { path: content }
export function buildManifest(
  files: Record<string, string>,
  opts: { generator?: string; rendererVersion?: string } = {},
): Manifest {
  const entries: Manifest['entries'] = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = { hash: identityHash(content), tag: 'generated' };
  }
  return {
    schema_version: 1,
    generator: opts.generator ?? 'setup-upgrade',
    renderer_version: opts.rendererVersion ?? 'unknown',
    stamp_hash: hash(
      Object.keys(files)
        .sort()
        .map((p) => `${p}:${entries[p].hash}`)
        .join('\n'),
    ),
    entries,
  };
}

// onDisk: { path: content } только для существующих файлов.
export function classify(
  manifest: Manifest,
  onDisk: Record<string, string>,
): Record<string, 'ok' | 'missing' | 'user-modified'> {
  const out: Record<string, 'ok' | 'missing' | 'user-modified'> = {};
  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (!(path in onDisk)) out[path] = 'missing';
    else if (identityHash(onDisk[path]) === entry.hash) out[path] = 'ok';
    else out[path] = 'user-modified';
  }
  return out;
}

// Выполнение плана. dryRun:true делает 0 записей.
export function executePlan(
  plan: Plan,
  fs: FileSystemAdapter,
  opts: { dryRun: boolean },
): PlanResult {
  const result: PlanResult = {
    dryRun: opts.dryRun,
    applied: [],
    skipped: [],
    writes: 0,
  };

  for (const op of plan.ops) {
    if (op.kind === 'skip') {
      result.skipped.push(op.path);
      continue;
    }
    if (op.kind === 'backup' || op.kind === 'merge') {
      // Полный merge/backup-движок — следующий срез; здесь пропуск.
      result.skipped.push(op.path);
      continue;
    }
    if (op.kind === 'delete') {
      if (opts.dryRun) {
        result.writes += 1;
        result.applied.push(op.path);
      } else {
        fs.delete(op.path);
        result.writes += 1;
        result.applied.push(op.path);
      }
      continue;
    }
    // ensure
    if (opts.dryRun) {
      result.writes += 1;
      result.applied.push(op.path);
    } else {
      if (op.conflictPolicy === 'fail' && fs.exists(op.path)) {
        result.skipped.push(op.path);
        continue;
      }
      if (op.conflictPolicy === 'keep-user' && fs.exists(op.path)) {
        result.skipped.push(op.path);
        continue;
      }
      fs.write(op.path, op.content ?? '');
      result.writes += 1;
      result.applied.push(op.path);
    }
  }
  return result;
}
