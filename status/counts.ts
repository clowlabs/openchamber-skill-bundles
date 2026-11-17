// Live vs installed skill counts, read-only. Shared by the Work Status section, the panel header
// and tests. No writes, no lock.
import * as core from '../src/core.js';
import type { State } from '../src/core.js';
import { GLOBAL_SKILL_ROOTS, skillRoots } from '../src/discover.js';
import { discoverSkills } from '../panel/discover';
import { isUnreadable, readOptional, type FileHost, type ProjectsHost } from '../shared/panel/host';
import { createHomeDeriver, homeFromDirs } from '../shared/panel/projects';
import {
  formatRootStamps,
  readSkillIndexCache,
  statRootsMap,
  writeSkillIndexCache,
  type SkillIndexCache,
  type StorageHost,
} from './cache';

export type SkillCounts = {
  /** Skills agents can use (auto + called). */
  live: number;
  /** Installed skill folders plus built-ins. */
  installed: number;
  /** Est. prompt characters (auto skills only). */
  chars: number;
  /** Ids of bundles that are on; null when skill-bundles.json is missing. */
  bundlesOn: string[] | null;
  /** True when counted from opencode.json because skill-bundles.json is missing. */
  fromOpencode: boolean;
};

/** Discovered skills across all roots plus built-ins (sorted), and whether any root was unreachable. */
export async function discoverSkillIds(
  host: FileHost,
  opencodeText?: string | null,
): Promise<{ allIds: string[]; incomplete: boolean }> {
  const oc = opencodeText === undefined ? await readOptional(host, core.OPENCODE_PATH) : opencodeText;
  const { skills, unreachable } = await discoverSkills(host, oc);
  return {
    allIds: [...new Set([...Object.keys(skills), ...core.BUILTIN_SKILLS])].sort(),
    incomplete: unreachable.length > 0,
  };
}

/** Same id list as the panel: discovered skills across all roots plus built-ins, sorted. */
export async function listSkillIds(host: FileHost, opencodeText?: string | null): Promise<string[]> {
  return (await discoverSkillIds(host, opencodeText)).allIds;
}

export type SkillRule = { action: 'skill'; resource: string; effect?: unknown };

/**
 * Parse `permissions` skill rules from an `opencode.json` text:
 * - filtered `action === 'skill'` rules when valid JSON object with an array `permissions`,
 * - `[]` when valid JSON object with no `permissions` key,
 * - `null` otherwise (invalid JSON, non-object, or non-array `permissions`).
 */
export function parseSkillRules(text: string): SkillRule[] | null {
  try {
    const j = JSON.parse(text) as { permissions?: unknown };
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    if (!Object.hasOwn(j, 'permissions')) return [];
    if (!Array.isArray(j.permissions)) return null;
    return (j.permissions as { action?: unknown; resource?: unknown; effect?: unknown }[]).filter(
      (r): r is SkillRule => Boolean(r && r.action === 'skill' && typeof r.resource === 'string'),
    );
  } catch {
    return null;
  }
}

export function applySkillRules(allowed: boolean, rules: readonly SkillRule[], id: string): boolean {
  let cur = allowed;
  for (const r of rules) {
    if (r.resource === '*' || r.resource === id) cur = r.effect !== 'deny';
  }
  return cur;
}

/**
 * Live skills from opencode.json alone, the way OpenCode reads it: the last skill rule matching an
 * id wins; "*" matches all; no skill rules at all means every skill is allowed.
 * When `projectOpencodeText` is provided, matching rules there override/allow on top of global.
 */
export function liveFromOpencode(opencodeText: string | null, allIds: string[], projectOpencodeText?: string | null): number {
  let globalSkill: SkillRule[] = [];
  if (opencodeText != null) {
    const parsed = parseSkillRules(opencodeText);
    if (parsed === null) return 0;
    globalSkill = parsed;
  }
  const projSkill = projectOpencodeText != null ? (parseSkillRules(projectOpencodeText) ?? []) : [];
  if (!globalSkill.length && !projSkill.length) return allIds.length;
  let live = 0;
  for (const id of allIds) {
    if (applySkillRules(applySkillRules(true, globalSkill, id), projSkill, id)) live++;
  }
  return live;
}

export type CountsOptions = {
  projectDir?: string | null;
  home?: string;
  projectOpencodeText?: string | null;
  opencodeText?: string | null;
  cachedIds?: string[];
};

/** Counts from already-loaded data (the panel passes its state). */
export function countsFromState(state: State | null, allIds: string[], opencodeText: string | null, opts?: CountsOptions): SkillCounts {
  const home = opts?.home ?? homeFromDirs(opts?.projectDir ? [opts.projectDir] : []);
  const homeOpt = home ? { home } : {};
  const normDir = core.normalizeScopeDir(opts?.projectDir, homeOpt);
  if (!state) {
    const live = liveFromOpencode(opencodeText, allIds, normDir != null ? opts?.projectOpencodeText : undefined);
    return { live, installed: allIds.length, chars: live * core.CHARS_PER_SKILL, bundlesOn: null, fromOpencode: true };
  }
  const scope = { projectDir: normDir, ...homeOpt };
  const bundlesOn = state.bundles.filter((b) => core.isBundleActive(b, scope)).map((b) => b.id);

  const projRules =
    normDir != null && opts?.projectOpencodeText !== undefined
      ? opts.projectOpencodeText === null
        ? []
        : parseSkillRules(opts.projectOpencodeText)
      : null;
  if (projRules !== null) {
    let live = 0;
    let auto = 0;
    for (const id of allIds) {
      const allowed = applySkillRules(core.effectiveMode(state, id) !== 'off', projRules, id);
      if (allowed) {
        live++;
        if (!Object.hasOwn(state.overrides, id) || state.overrides[id] !== 'called' || core.isBuiltin(id)) {
          auto++;
        }
      }
    }
    return {
      live,
      installed: allIds.length,
      chars: auto * core.CHARS_PER_SKILL,
      bundlesOn,
      fromOpencode: false,
    };
  }

  let auto = 0;
  let called = 0;
  const activeBundleSkills = new Set<string>();
  for (const b of state.bundles) {
    if (bundlesOn.includes(b.id)) {
      for (const id of b.skills) activeBundleSkills.add(id);
    }
  }
  for (const id of allIds) {
    const ov =
      Object.hasOwn(state.overrides, id) && core.MODES.includes(state.overrides[id]) ? state.overrides[id] : undefined;
    let mode = ov ?? (activeBundleSkills.has(id) ? 'auto' : 'off');
    if (mode === 'called' && core.isBuiltin(id)) mode = 'auto';
    if (mode === 'auto') auto++;
    else if (mode === 'called') called++;
  }
  return {
    live: auto + called,
    installed: allIds.length,
    chars: auto * core.CHARS_PER_SKILL,
    // ids ("dev, plan"): short enough for one line; names can be long.
    bundlesOn,
    fromOpencode: false,
  };
}

async function readProjectConfigSafe(
  host: FileHost,
  normDir: string | null,
  given: string | null | undefined,
): Promise<string | null | undefined> {
  if (normDir == null || given !== undefined) return given;
  try {
    return await readOptional(host, core.projectConfigPath(normDir));
  } catch (e) {
    if (!isUnreadable(e)) throw e;
    return undefined;
  }
}

/** Read the files and count. */
export async function readCounts(host: FileHost, opts?: CountsOptions): Promise<SkillCounts> {
  const home = opts?.home ?? homeFromDirs(opts?.projectDir ? [opts.projectDir] : []);
  const homeOpt = home ? { home } : {};
  const normDir = core.normalizeScopeDir(opts?.projectDir, homeOpt);
  const opencodePromise =
    opts?.opencodeText !== undefined ? Promise.resolve(opts.opencodeText) : readOptional(host, core.OPENCODE_PATH);
  const [bundlesText, opencodeText, projectOpencodeText, allIds] = await Promise.all([
    readOptional(host, core.BUNDLES_PATH),
    opencodePromise,
    readProjectConfigSafe(host, normDir, opts?.projectOpencodeText),
    opts?.cachedIds ? Promise.resolve(opts.cachedIds) : opencodePromise.then((oc) => listSkillIds(host, oc)),
  ]);
  const state = bundlesText == null ? null : core.parseBundles(bundlesText, homeOpt);
  return countsFromState(state, allIds, opencodeText, { projectDir: normDir, home, projectOpencodeText });
}

export type StatusLoaderOptions = {
  revalidateAfterMs?: number;
  onRevalidated?: (counts: SkillCounts) => void;
};

export type StatusLoadOptions = {
  forceScan?: boolean;
  forceImmediateScan?: boolean;
};

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Single-wave Work Status loader with persistent storage cache and stale-while-revalidate.
 * Warm hits resolve in one parallel RPC wave with 0 `listDir` calls.
 */
export function createStatusLoader(
  host: FileHost & ProjectsHost & StorageHost,
  opts?: StatusLoaderOptions,
) {
  const revalidateAfterMs = opts?.revalidateAfterMs ?? 60_000;
  const onRevalidated = opts?.onRevalidated;
  const homeDeriver = createHomeDeriver(host);
  let idCache: SkillIndexCache | null = null;
  let invalidScanAge = false;
  let latestDir: string | null = null;
  let loadSeq = 0;
  let activeRootsKey: string | null = null;
  let scanGen = 0;
  let bgScan: Promise<void> | null = null;
  let bgDirty = false;
  let bgArgs: {
    roots: readonly string[];
    rootsKey: string;
    opencodeText: string | null;
    home: string | undefined;
    epoch: number;
  } | null = null;

  function startBackgroundScan(
    prevIds: readonly string[],
    roots: readonly string[],
    rootsKey: string,
    opencodeText: string | null,
    home: string | undefined,
    epoch: number,
  ): void {
    bgArgs = { roots, rootsKey, opencodeText, home, epoch };
    if (bgScan) {
      bgDirty = true;
      return;
    }
    let baselineIds = prevIds;
    bgScan = (async () => {
      try {
        do {
          bgDirty = false;
          const cur = bgArgs;
          if (!cur || cur.epoch !== scanGen || cur.rootsKey !== activeRootsKey) break;
          const [{ allIds, incomplete }, rootMap] = await Promise.all([
            discoverSkillIds(host, cur.opencodeText),
            statRootsMap(host, cur.roots),
          ]);
          if (cur.epoch !== scanGen || cur.rootsKey !== activeRootsKey) continue;
          const entry: SkillIndexCache = {
            v: 1,
            rootsKey: cur.rootsKey,
            rootStamps: formatRootStamps(cur.roots, rootMap),
            allIds,
            ...(cur.home ? { home: cur.home } : {}),
            scannedAt: Date.now(),
          };
          idCache = entry;
          const publishedAtSeq = loadSeq;
          if (!incomplete) {
            await writeSkillIndexCache(host, entry);
            if (cur.epoch !== scanGen || cur.rootsKey !== activeRootsKey) continue;
          }
          if (!sameIds(baselineIds, allIds)) {
            baselineIds = allIds;
            if (onRevalidated && loadSeq === publishedAtSeq) {
              const fresh = await readCounts(host, {
                projectDir: latestDir,
                home: cur.home,
                cachedIds: allIds,
              });
              if (cur.epoch === scanGen && cur.rootsKey === activeRootsKey && loadSeq === publishedAtSeq) {
                onRevalidated(fresh);
              }
            }
          }
        } while (bgDirty);
      } catch {
        // Non-fatal: periodic/next refresh will retry.
      } finally {
        bgScan = null;
      }
    })();
  }

  return {
    invalidateScanAge(): void {
      invalidScanAge = true;
      if (idCache) idCache = { ...idCache, scannedAt: 0 };
    },
    async load(dir: string | null, loadOpts?: StatusLoadOptions): Promise<SkillCounts> {
      loadSeq++;
      latestDir = dir;
      const optimisticDir = dir && !core.isChatsDir(dir) ? core.normalizeScopeDir(dir) : null;
      const [cached, bundlesText, opencodeText, initialRootMap, derivedHome, optimisticProjText] =
        await Promise.all([
          idCache ? Promise.resolve(idCache) : readSkillIndexCache(host),
          readOptional(host, core.BUNDLES_PATH),
          readOptional(host, core.OPENCODE_PATH),
          statRootsMap(host, GLOBAL_SKILL_ROOTS),
          homeDeriver.derive(),
          optimisticDir !== null ? readProjectConfigSafe(host, optimisticDir, undefined) : Promise.resolve(undefined),
        ]);

      const home = derivedHome ?? idCache?.home ?? cached?.home ?? (dir ? homeFromDirs([dir]) : undefined);
      const homeOpt = home ? { home } : {};
      const normDir = core.normalizeScopeDir(dir, homeOpt);
      const projectOpencodeText =
        normDir === null
          ? undefined
          : optimisticDir !== null
            ? optimisticProjText
            : await readProjectConfigSafe(host, normDir, undefined);

      const roots = skillRoots(opencodeText);
      const rootsKey = JSON.stringify(roots);
      if (rootsKey !== activeRootsKey) {
        activeRootsKey = rootsKey;
        scanGen++;
        bgArgs = null;
        bgDirty = false;
      }
      const missingRoots = roots.filter((r) => !Object.hasOwn(initialRootMap, r));
      const rootMap = missingRoots.length
        ? { ...initialRootMap, ...(await statRootsMap(host, missingRoots)) }
        : initialRootMap;
      const rootStamps = formatRootStamps(roots, rootMap);
      const state = bundlesText == null ? null : core.parseBundles(bundlesText, homeOpt);

      // Prefer in-memory `idCache` if a background scan published a fresher entry while Wave 1 was in flight.
      const effectiveCached =
        idCache && idCache.rootsKey === rootsKey && (!cached || idCache.scannedAt >= cached.scannedAt)
          ? idCache
          : cached;

      if (effectiveCached && effectiveCached.rootsKey === rootsKey) {
        const nextCached =
          invalidScanAge || loadOpts?.forceImmediateScan ? { ...effectiveCached, scannedAt: 0 } : effectiveCached;
        invalidScanAge = false;
        idCache = nextCached;
        const immediate = countsFromState(state, nextCached.allIds, opencodeText, {
          projectDir: normDir,
          home,
          projectOpencodeText,
        });
        const stampsChanged = nextCached.rootStamps !== rootStamps;
        const staleAge =
          Boolean(loadOpts?.forceImmediateScan) ||
          (Boolean(loadOpts?.forceScan) && Date.now() - nextCached.scannedAt >= revalidateAfterMs);
        if (stampsChanged || staleAge) {
          startBackgroundScan(nextCached.allIds, roots, rootsKey, opencodeText, home, scanGen);
        }
        return immediate;
      }

      invalidScanAge = false;
      const myScanGen = ++scanGen;
      const { allIds, incomplete } = await discoverSkillIds(host, opencodeText);
      if (myScanGen === scanGen && rootsKey === activeRootsKey) {
        const entry: SkillIndexCache = {
          v: 1,
          rootsKey,
          rootStamps,
          allIds,
          ...(home ? { home } : {}),
          scannedAt: Date.now(),
        };
        idCache = entry;
        if (!incomplete) void writeSkillIndexCache(host, entry);
      }
      return countsFromState(state, allIds, opencodeText, { projectDir: normDir, home, projectOpencodeText });
    },
  };
}

/** Coalesce overlapping status refreshes so a ping mid-read triggers an immediate follow-up pass. */
export function createStatusRefresher(
  read: () => Promise<SkillCounts>,
  paint: (c: SkillCounts) => void,
  onError: (e: unknown) => void,
) {
  let reading = false;
  let dirty = false;
  let active: Promise<void> | null = null;
  return function refresh(): Promise<void> {
    if (reading) {
      dirty = true;
      return active ?? Promise.resolve();
    }
    reading = true;
    active = (async () => {
      try {
        do {
          dirty = false;
          try {
            paint(await read());
          } catch (e) {
            onError(e);
          }
        } while (dirty);
      } finally {
        reading = false;
        active = null;
      }
    })();
    return active;
  };
}

/** "35 live / 212 installed" */
export const liveLine = (c: SkillCounts) => `${c.live} live / ${c.installed} installed`;

/** Live share of installed, 0–100 (0 when nothing is installed). */
export const livePct = (c: Pick<SkillCounts, 'live' | 'installed'>) => (c.installed > 0 ? Math.round((c.live / c.installed) * 100) : 0);

/** Estimated prompt tokens (~4 chars per token). */
export const tokensOf = (chars: number) => Math.round(chars / 4);

/** 950 → "950", 1,600 → "1.6k", 12,345 → "12k", 1,250,000 → "1.3M". */
export function formatTokens(n: number) {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export const TOKENS_TITLE = 'Estimated tokens the live skills add to every prompt (skill list only)';

/** Remixicon `stack` (the extension's manifest icon), drawn like the host's Work Status row icons. */
export const STACK_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20.083 15.2l1.202.721a.5.5 0 0 1 0 .858l-8.77 5.262a1 1 0 0 1-1.03 0l-8.77-5.262a.5.5 0 0 1 0-.858l1.202-.721L12 20.05l8.083-4.85zm0-4.7l1.202.721a.5.5 0 0 1 0 .858L12 17.65l-9.285-5.571a.5.5 0 0 1 0-.858l1.202-.721L12 15.35l8.083-4.85zm-7.569-9.191l8.771 5.262a.5.5 0 0 1 0 .858L12 13 2.715 7.429a.5.5 0 0 1 0-.858l8.77-5.262a1 1 0 0 1 1.03 0zM12 3.332L5.887 7 12 10.668 18.113 7 12 3.332z"/></svg>';

/** Work Status: one muted row with an icon, live/installed counts and estimated tokens. */
export function renderMeterHeader(c: SkillCounts) {
  const wrap = document.createElement('div');
  wrap.className = 'skm skm-compact';
  const top = document.createElement('div');
  top.className = 'skm-top';
  const left = document.createElement('span');
  left.className = 'skm-left';
  const n = Object.assign(document.createElement('span'), { className: 'skm-live-n', textContent: String(c.live) });
  const w = Object.assign(document.createElement('span'), { className: 'skm-live-w', textContent: 'live' });
  const rest = Object.assign(document.createElement('span'), { className: 'skm-rest', textContent: `/ ${c.installed}` });
  left.append(n, rest, w);
  const right = Object.assign(document.createElement('span'), {
    className: 'skm-tokens', title: TOKENS_TITLE, textContent: `~${formatTokens(tokensOf(c.chars))} tokens`,
  });
  const icon = Object.assign(document.createElement('span'), { className: 'skm-icon', innerHTML: STACK_ICON_SVG });
  icon.setAttribute('aria-hidden', 'true');
  top.append(icon, left, right);
  wrap.append(top);
  return { wrap };
}
