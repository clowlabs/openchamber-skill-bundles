// Live vs installed skill counts, read-only. Shared by the Work Status section, the panel header
// and tests. No writes, no lock.
import * as core from '../src/core.js';
import type { State } from '../src/core.js';
import { isNotFound, readOptional, type FileHost } from '../shared/panel/host';

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

/** Same id list as the panel: skill folders (no dotfiles) plus built-ins, sorted. */
export async function listSkillIds(host: FileHost): Promise<string[]> {
  let dirs: string[] = [];
  try {
    const { entries } = await host.listDir(core.SKILLS_DIR);
    dirs = entries.filter((e) => e.kind === 'directory' && !e.name.startsWith('.')).map((e) => e.name);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  return [...new Set([...dirs, ...core.BUILTIN_SKILLS])].sort();
}

type Rule = { action?: unknown; resource?: unknown; effect?: unknown };

/**
 * Live skills from opencode.json alone, the way OpenCode reads it: the last skill rule matching an
 * id wins; "*" matches all; no skill rules at all means every skill is allowed.
 */
export function liveFromOpencode(opencodeText: string | null, allIds: string[]): number {
  if (opencodeText == null) return allIds.length;
  let rules: Rule[] = [];
  try {
    const j = JSON.parse(opencodeText) as { permissions?: unknown };
    if (Array.isArray(j.permissions)) rules = j.permissions as Rule[];
  } catch {
    return 0;
  }
  const skill = rules.filter((r) => r && r.action === 'skill' && typeof r.resource === 'string');
  if (!skill.length) return allIds.length;
  let live = 0;
  for (const id of allIds) {
    let allowed = true;
    for (const r of skill) {
      if (r.resource === '*' || r.resource === id) allowed = r.effect !== 'deny';
    }
    if (allowed) live++;
  }
  return live;
}

/** Counts from already-loaded data (the panel passes its state). */
export function countsFromState(state: State | null, allIds: string[], opencodeText: string | null): SkillCounts {
  if (!state) {
    const live = liveFromOpencode(opencodeText, allIds);
    return { live, installed: allIds.length, chars: live * core.CHARS_PER_SKILL, bundlesOn: null, fromOpencode: true };
  }
  const sum = core.summary(state, allIds);
  return {
    live: sum.on,
    installed: allIds.length,
    chars: sum.chars,
    // ids ("dev, plan"): short enough for one line; names can be long.
    bundlesOn: state.bundles.filter((b) => b.enabled).map((b) => b.id),
    fromOpencode: false,
  };
}

/** Read the files and count. */
export async function readCounts(host: FileHost): Promise<SkillCounts> {
  const [allIds, bundlesText, opencodeText] = await Promise.all([
    listSkillIds(host),
    readOptional(host, core.BUNDLES_PATH),
    readOptional(host, core.OPENCODE_PATH),
  ]);
  const state = bundlesText == null ? null : core.parseBundles(bundlesText);
  return countsFromState(state, allIds, opencodeText);
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
