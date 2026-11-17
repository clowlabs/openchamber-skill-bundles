// Minimal structural view of the OpenChamber host client used by shared/panel. Kept local (no
// @openchamber/sdk import) so this folder resolves from any extension, through its symlink.

export type FileKind = 'file' | 'directory' | 'other';
export type StatKind = FileKind | 'missing';

export type ToastRequest = {
  kind: 'info' | 'success' | 'error';
  message: string;
  copy?: boolean | { text: string };
  dismiss?: boolean;
  persistent?: boolean;
};

export type ProjectInfo = { id: string; name: string; directory: string };
export type ProjectsSnapshot = { state: 'loading' | 'ready' | 'error' | string; projects: ProjectInfo[] };

/** The file part of the host client. */
export interface FileHost {
  readFile(path: string): Promise<{ content: string }>;
  writeFile(path: string, content: string): Promise<unknown>;
  listDir(path: string): Promise<{ entries: { name: string; kind: FileKind }[] }>;
  stat(path: string): Promise<{ kind: StatKind; size: number; mtime: number }>;
}
export interface ToastHost {
  toast(req: ToastRequest): Promise<void>;
}
export interface ProjectsHost {
  listProjects(): Promise<ProjectsSnapshot>;
  onProjects?(listener: (snap: ProjectsSnapshot) => void): Promise<() => void>;
}

/** Host error code (HostRequestError.code), or ''. */
export const errorCode = (e: unknown): string =>
  e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '';
export const isNotFound = (e: unknown) => errorCode(e) === 'NOT_FOUND';
export function isUnreadable(e: unknown): boolean {
  const c = errorCode(e);
  return c === 'DENIED' || c === 'BAD_PATH' || c === 'FILE_TOO_LARGE';
}

/** "CODE: message" for host errors, else the message. */
export function errText(e: unknown) {
  const code = errorCode(e);
  const msg = e instanceof Error ? e.message : String(e);
  return code ? `${code}: ${msg}` : msg;
}

/** readFile, with a missing file as null. */
export async function readOptional(host: Pick<FileHost, 'readFile'>, path: string): Promise<string | null> {
  try {
    return (await host.readFile(path)).content;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Run fn over items, at most `size` at a time. */
export async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) await fn(queue.shift()!);
  };
  await Promise.all(Array.from({ length: Math.max(1, size) }, worker));
}
