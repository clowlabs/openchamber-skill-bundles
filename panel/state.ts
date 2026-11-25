// Panel state every io module shares: the host, S (with the boot phase), render hooks, the home
// folder that shapes project paths, the undo history and the error types saves report.
import type { HostClient } from '@openchamber/sdk';
import * as core from '../src/core.js';
import type { Bundle, State } from '../src/core.js';
import type { SkillRef } from '../src/discover.js';
import type { Unreachable } from './discover';
import { errText, readOptional as readOpt } from '../shared/panel/host';
import { deriveHomeFromHost, homeFromDirs } from '../shared/panel/projects';

/** The host client; main sets it at boot (io.setHost), tests pass a fake. */
export let host: HostClient;
/** Only io.setHost calls this, after resetting everything tied to the old host. */
export function setHostRef(h: HostClient) {
  host = h;
}

/**
 * Boot phase. 'empty': nothing to show yet. 'preview': painted from the stored index only (disk
 * not read yet, so writes and syncs wait). 'verified': loaded from disk. Never goes back to
 * 'empty'; a reload moves 'verified' to 'verified'.
 */
export type Phase = 'empty' | 'preview' | 'verified';

/** Data loaded from disk plus write-queue bookkeeping. */
export const S = {
  phase: 'empty' as Phase,
  state: null as State | null,
  /** Something is painted (index preview or disk). */
  get loaded(): boolean {
    return S.phase !== 'empty';
  },
  /** Loaded from disk: writes and syncs may run. */
  get fresh(): boolean {
    return S.phase === 'verified';
  },
  allIds: [] as string[],
  skillRefs: Object.create(null) as Record<string, SkillRef>,
  skillPaths: Object.create(null) as Record<string, string>,
  unreachable: [] as Unreachable[],
  /** Some folder could not be scanned (unreachable roots, entries or truncation; not file reads). */
  incomplete: false,
  /** Ids found but whose markdown could not be read. */
  unreadable: [] as string[],
  /** Null-prototype: a skill may be named `constructor`. Read through skillText(). */
  skillMds: Object.create(null) as Record<string, string>,
  opencodeText: '',
  bundlesText: null as string | null,
  /** User's home dir, derived once at load (undefined = unknown: textual collapsing only). */
  home: undefined as string | undefined,
  homeDerived: false,
  descDraft: null as { id: string; value: string } | null,
  /** Bundle ids created in this session (newest first) so pickers surface them first. */
  createdBundles: [] as string[],
  /** Active project directory from host.onDirectory, or null. */
  activeDir: null as string | null,
  /** Last read `<dir>/.opencode/opencode.json` contents keyed by config path. */
  projectTexts: Object.create(null) as Record<string, string | null>,
};

export function noteCreatedBundle(id: string) {
  S.createdBundles = [id, ...S.createdBundles.filter((x) => x !== id)];
}

/** Order bundles for "add/move to bundle" pickers: session-created first, then empty bundles, then stored order. */
export function orderBundles(bundles: readonly Bundle[]): Bundle[] {
  const rank = (b: Bundle, i: number) => {
    const c = S.createdBundles.indexOf(b.id);
    if (c >= 0) return c;
    if (b.skills.length === 0) return S.createdBundles.length + (bundles.length - i);
    return S.createdBundles.length + bundles.length + 1 + i;
  };
  return bundles
    .map((b, i) => ({ b, r: rank(b, i) }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.b);
}

/** Set by main: full, stats-only, and external-sync re-render. */
export const hooks = {
  render: () => {},
  renderLight: () => {},
  onExternalSync: () => hooks.render(),
};

/** Effective home dir: derived from projects, or inferred from S.activeDir. */
export const effectiveHome = (): string | undefined =>
  S.home ?? (S.fresh ? undefined : previewHome) ?? (S.activeDir ? homeFromDirs([S.activeDir]) : undefined);
/** Home stored with the index: shapes only the preview paint, never a save (that derives its own). */
let previewHome: string | undefined;
/** The index paint sets it; the disk load clears it before parsing anything. */
export function setPreviewHome(h: string | undefined) {
  previewHome = h;
}

/** `{ home }` for every core call that takes it. */
export const homeOpt = () => {
  const h = effectiveHome();
  return h ? { home: h } : {};
};

export function sameProjectDir(a: string, b: string): boolean {
  return core.sameProjectDir(a, b, homeOpt());
}

export function activeProjectDir(): string | null {
  return core.normalizeScopeDir(S.activeDir, homeOpt());
}

export function isBundleOnInScope(b: Bundle, projDir = activeProjectDir()): boolean {
  return core.isBundleActive(b, { projectDir: projDir, ...homeOpt() });
}

export async function deriveHome() {
  await deriveHomeFromHost(host, S, (e) => {
    console.warn('skill-bundles: could not list projects to find the home folder', e);
  });
}

export const skillPath = (id: string) => S.skillPaths[id] ?? `${core.SKILLS_DIR}/${id}/SKILL.md`;
export const mode = (id: string) => (S.state ? core.effectiveMode(S.state, id) : 'off');
export const bundlesOf = (id: string) => (S.state ? S.state.bundles.filter((b) => b.skills.includes(id)) : []);

export function toastError(e: unknown, what: string) {
  void host.toast({ kind: 'error', message: `${what}: ${errText(e)}`, copy: true, dismiss: true });
}

// Protocol shared with the CLI (core.LOCK_PATH etc.), run by shared/panel/panel-lock.
/** How long to wait for a held lock. Tests shorten it. */
export const lockTiming = { pollMs: 250, waitMs: 3000 };

export const readOptional = (path: string) => readOpt(host, path);

/** A file changed under a save: the save aborts and the panel reloads. */
export class StaleError extends Error {}
/** Core refused the change: nothing was written, no reload. */
export class RefusedError extends Error {}

export function sameRec<V>(a: Record<string, V>, b: Record<string, V>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

// ---------- undo history (saves push, reloads and external config changes clear) ----------

export type UndoEntry = { state: State; label: string };
export const history = { stack: [] as UndoEntry[] };
export function clearUndo() {
  history.stack = [];
}
