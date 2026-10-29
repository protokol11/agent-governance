// Типы ядра reconciler: манифест, план, файловый адаптер, результат плана.

export interface ManifestEntry {
  hash: string;
  tag: string;
}

export interface Manifest {
  schema_version: number;
  generator: string;
  renderer_version: string;
  stamp_hash: string;
  entries: Record<string, ManifestEntry>;
}

export type FileOpKind = 'ensure' | 'merge' | 'backup' | 'skip' | 'delete';

export interface FileOp {
  kind: FileOpKind;
  path: string;
  reason: string;
  content?: string;
  conflictPolicy: 'overwrite' | 'keep-user' | 'fail';
}

export interface Plan {
  schema_version: number;
  ops: FileOp[];
}

// Файловый шов: ядро делает I/O только через этот интерфейс.
export interface FileSystemAdapter {
  read(path: string): string | null;
  write(path: string, content: string): void;
  delete(path: string): void;
  exists(path: string): boolean;
  list(dir: string): string[];
}

export interface PlanResult {
  dryRun: boolean;
  applied: string[];
  skipped: string[];
  writes: number;
}
