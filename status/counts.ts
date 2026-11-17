// Live vs installed skill counts, read-only. Shared by the Work Status section, the panel header
// and tests. No writes, no lock.
import * as core from '../src/core.js';
import type { State } from '../src/core.js';
import { discoverSkills } from '../panel/discover';
import { isUnreadable, readOptional, type FileHost } from '../shared/panel/host';
import { homeFromDirs } from '../shared/panel/projects';

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

/** Same id list as the panel: discovered skills across all roots plus built-ins, sorted. */
export async function listSkillIds(host: FileHost, opencodeText?: string | null): Promise<string[]> {
  const oc = opencodeText === undefined ? await readOptional(host, core.OPENCODE_PATH) : opencodeText;
  const { skills } = await discoverSkills(host, oc);
  return [...new Set([...Object.keys(skills), ...core.BUILTIN_SKILLS])].sort();
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
    const live = liveFromOpencode(opencodeText, allIds, opts?.projectOpencodeText);
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

/**
 * Header + meter, shared by the Work Status section and the rail panel:
 *   <35 live / 211 installed · 17%>            <~1.6k tokens>
 *   [■■■■□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□□]
 * Returns `left` so a caller can append to the summary (e.g. a Saving… badge).
 */
export function renderMeterHeader(c: SkillCounts) {
  const pct = livePct(c);
  const wrap = document.createElement('div');
  wrap.className = 'skm';
  const top = document.createElement('div');
  top.className = 'skm-top';
  const left = document.createElement('span');
  left.className = 'skm-left';
  const n = Object.assign(document.createElement('span'), { className: 'skm-live-n', textContent: String(c.live) });
  const w = Object.assign(document.createElement('span'), { className: 'skm-live-w', textContent: 'live' });
  const rest = Object.assign(document.createElement('span'), { className: 'skm-rest', textContent: ` / ${c.installed} installed · ${pct}%` });
  left.append(n, w, rest);
  const right = Object.assign(document.createElement('span'), {
    className: 'skm-tokens', title: TOKENS_TITLE, textContent: `~${formatTokens(tokensOf(c.chars))} tokens`,
  });
  top.append(left, right);
  const meter = document.createElement('div');
  meter.className = 'skm-meter';
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', String(c.installed));
  meter.setAttribute('aria-valuenow', String(c.live));
  meter.setAttribute('aria-label', `${c.live} of ${c.installed} skills live`);
  const fill = document.createElement('div');
  fill.className = 'skm-fill';
  fill.style.width = `${pct}%`;
  meter.appendChild(fill);
  wrap.append(top, meter);
  return { wrap, left, fill };
}
