// Live vs installed skill counts, read-only. Shared by the Work Status section, the panel header
// and tests. No writes, no lock.
import * as core from '../src/core.js';
import type { State } from '../src/core.js';
import { discoverSkills } from '../panel/discover';
import { errorCode, readOptional, type FileHost } from '../shared/panel/host';
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

type Rule = { action?: unknown; resource?: unknown; effect?: unknown };

/**
 * Live skills from opencode.json alone, the way OpenCode reads it: the last skill rule matching an
 * id wins; "*" matches all; no skill rules at all means every skill is allowed.
 * When `projectOpencodeText` is provided, matching rules there override/allow on top of global.
 */
export function liveFromOpencode(opencodeText: string | null, allIds: string[], projectOpencodeText?: string | null): number {
  let globalSkill: Rule[] = [];
  if (opencodeText != null) {
    let rules: Rule[] = [];
    try {
      const j = JSON.parse(opencodeText) as { permissions?: unknown };
      if (Array.isArray(j.permissions)) rules = j.permissions as Rule[];
    } catch {
      return 0;
    }
    globalSkill = rules.filter((r) => r && r.action === 'skill' && typeof r.resource === 'string');
  }
  let projSkill: Rule[] = [];
  if (projectOpencodeText != null) {
    try {
      const pj = JSON.parse(projectOpencodeText) as { permissions?: unknown };
      if (Array.isArray(pj.permissions)) {
        projSkill = (pj.permissions as Rule[]).filter((r) => r && r.action === 'skill' && typeof r.resource === 'string');
      }
    } catch {
      // ignore invalid project opencode.json
    }
  }
  if (!globalSkill.length && !projSkill.length) return allIds.length;
  let live = 0;
  for (const id of allIds) {
    let allowed = true;
    for (const r of globalSkill) {
      if (r.resource === '*' || r.resource === id) allowed = r.effect !== 'deny';
    }
    for (const r of projSkill) {
      if (r.resource === '*' || r.resource === id) allowed = r.effect !== 'deny';
    }
    if (allowed) live++;
  }
  return live;
}

function normalizeScopeDir(projectDir: string | null | undefined, home?: string): string | null {
  if (!projectDir || core.isChatsDir(projectDir)) return null;
  try {
    const d = core.normalizeProjectDir(projectDir, home ? { home } : {});
    return d === '~' || d === '/' ? null : d;
  } catch {
    return null;
  }
}

export type CountsOptions = {
  projectDir?: string | null;
  home?: string;
  projectOpencodeText?: string | null;
};

function projectSkillRulesFromText(text: string | null): Rule[] | null {
  if (text === null) return [];
  try {
    const pj = JSON.parse(text) as { permissions?: unknown };
    if (!pj || typeof pj !== 'object' || Array.isArray(pj)) return null;
    if (!Object.hasOwn(pj, 'permissions')) return [];
    if (!Array.isArray(pj.permissions)) return null;
    return (pj.permissions as Rule[]).filter((r) => r && r.action === 'skill' && typeof r.resource === 'string');
  } catch {
    return null;
  }
}

/** Counts from already-loaded data (the panel passes its state). */
export function countsFromState(state: State | null, allIds: string[], opencodeText: string | null, opts?: CountsOptions): SkillCounts {
  const home = opts?.home ?? homeFromDirs(opts?.projectDir ? [opts.projectDir] : []);
  const normDir = normalizeScopeDir(opts?.projectDir, home);
  if (!state) {
    const live = liveFromOpencode(opencodeText, allIds, opts?.projectOpencodeText);
    return { live, installed: allIds.length, chars: live * core.CHARS_PER_SKILL, bundlesOn: null, fromOpencode: true };
  }
  const homeOpt = home ? { home } : {};
  const matches = (list: string[] | undefined) =>
    normDir != null &&
    (list ?? []).some((x) => {
      try { return core.normalizeProjectDir(x, homeOpt) === normDir; } catch { return x === normDir; }
    });
  const bundlesOn = state.bundles
    .filter((b) => (normDir != null ? matches(b.projects) || (b.enabled && !matches(b.excludedProjects)) : b.enabled))
    .map((b) => b.id);

  const projRules = normDir != null && opts?.projectOpencodeText !== undefined
    ? projectSkillRulesFromText(opts.projectOpencodeText)
    : null;
  if (projRules !== null) {
    let live = 0;
    let auto = 0;
    for (const id of allIds) {
      const gm = core.effectiveMode(state, id);
      let allowed = gm !== 'off';
      for (const r of projRules) {
        if (r.resource === '*' || r.resource === id) allowed = r.effect !== 'deny';
      }
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

  const sum = core.summary(state, allIds, { projectDir: normDir, home });
  return {
    live: sum.on,
    installed: allIds.length,
    chars: sum.chars,
    // ids ("dev, plan"): short enough for one line; names can be long.
    bundlesOn,
    fromOpencode: false,
  };
}

/** Read the files and count. */
export async function readCounts(host: FileHost, opts?: CountsOptions): Promise<SkillCounts> {
  const home = opts?.home ?? homeFromDirs(opts?.projectDir ? [opts.projectDir] : []);
  const normDir = normalizeScopeDir(opts?.projectDir, home);
  const [bundlesText, opencodeText] = await Promise.all([
    readOptional(host, core.BUNDLES_PATH),
    readOptional(host, core.OPENCODE_PATH),
  ]);
  const allIds = await listSkillIds(host, opencodeText);
  const state = bundlesText == null ? null : core.parseBundles(bundlesText, home ? { home } : {});
  let projectOpencodeText = opts?.projectOpencodeText;
  if (normDir != null && projectOpencodeText === undefined) {
    try {
      projectOpencodeText = await readOptional(host, core.projectConfigPath(normDir));
    } catch (e) {
      const code = errorCode(e);
      if (code !== 'DENIED' && code !== 'BAD_PATH' && code !== 'FILE_TOO_LARGE') throw e;
      projectOpencodeText = undefined;
    }
  }
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
