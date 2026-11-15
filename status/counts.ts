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
  /** Extra project folders listed by bundles (on or off). */
  projects: number;
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
    return { live, installed: allIds.length, chars: live * core.CHARS_PER_SKILL, bundlesOn: null, projects: 0, fromOpencode: true };
  }
  const sum = core.summary(state, allIds);
  const projects = new Set(state.bundles.flatMap((b) => b.projects ?? [])).size;
  return {
    live: sum.on,
    installed: allIds.length,
    chars: sum.chars,
    // ids ("dev, plan"): short enough for one line; names can be long.
    bundlesOn: state.bundles.filter((b) => b.enabled).map((b) => b.id),
    projects,
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

/** "dev, plan on · +N projects" (or a fallback note). */
export function bundlesLine(c: SkillCounts) {
  if (c.bundlesOn == null) return 'from opencode.json · no bundles yet';
  const on = c.bundlesOn.length ? `${c.bundlesOn.join(', ')} on` : 'no bundles on';
  return c.projects ? `${on} · +${c.projects} project${c.projects > 1 ? 's' : ''}` : on;
}
