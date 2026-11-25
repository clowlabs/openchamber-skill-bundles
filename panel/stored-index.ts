// Stored index (cache-first boot): what the next open paints before the disk load, and the
// paint itself. Writes run one at a time; a snapshot counts as stored once its write succeeds.
import * as core from '../src/core.js';
import type { SkillRef } from '../src/discover.js';
import { skillRoots } from '../src/discover.js';
import { isVerifiedStamp } from '../status/cache';
import { panelIndexText, readPanelIndex, writePanelIndex, type PanelIndex } from './index-cache';
import { S, effectiveHome, homeOpt, host, readOptional, setPreviewHome } from './state';
import { applySkillSnapshot, meta, type LazySkill } from './catalog';

/** Text of the index known to be stored (read at boot or written successfully). */
let lastIndexText: string | null = null;
/** Index writes run one at a time, so an older write can never land after a newer one. */
let indexWrites: Promise<void> = Promise.resolve();

/** Null while any SKILL.md stamp is unverified: a summary must be pinned to the file it describes. */
function buildPanelIndex(roots: readonly string[], skillFileStamps: Record<string, string>): PanelIndex | null {
  const skills: PanelIndex['skills'] = [];
  for (const r of Object.values(S.skillRefs).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (S.unreadable.includes(r.id)) continue; // no summary to pin; retried by every scan
    const stamp = skillFileStamps[r.path];
    if (!isVerifiedStamp(stamp)) return null;
    const m = meta(r.id);
    skills.push({ id: r.id, root: r.root, path: r.path, dir: r.dir, description: m.description, autoinvoke: m.autoinvoke, error: m.error, stamp });
  }
  const home = effectiveHome();
  return {
    v: 1,
    rootsKey: JSON.stringify(roots),
    ...(home ? { home } : {}),
    allIds: [...S.allIds],
    skills,
    unreachable: S.unreachable.map((u) => ({ path: u.path, code: u.code })),
    unreadable: [...S.unreadable],
  };
}

/** Store what the next boot paints first; skipped when unchanged, incomplete or too large. */
export function savePanelIndex(roots: readonly string[], skillFileStamps: Record<string, string>) {
  if (S.incomplete || !S.fresh) return;
  const index = buildPanelIndex(roots, skillFileStamps);
  if (!index) return;
  const h = host;
  indexWrites = indexWrites.then(async () => {
    const text = panelIndexText(index);
    if (text === lastIndexText) return;
    try {
      if (await writePanelIndex(h, index)) lastIndexText = text;
    } catch (e) {
      console.warn('skill-bundles: could not store the skill index; the next open loads from disk', e);
    }
  });
}

/** Paint state from the stored index plus the two config files: no folder walk, no SKILL.md. */
export async function paintFromIndex(): Promise<boolean> {
  try {
    const [index, opencodeText, bundlesText] = await Promise.all([
      readPanelIndex(host),
      host.readFile(core.OPENCODE_PATH).then((r) => r.content),
      readOptional(core.BUNDLES_PATH),
    ]);
    if (!index || index.rootsKey !== JSON.stringify(skillRoots(opencodeText))) return false;
    setPreviewHome(index.home);
    const home = S.home ?? index.home;
    const state = bundlesText == null ? null : core.parseBundles(bundlesText, home ? { home } : homeOpt());
    const refs: Record<string, SkillRef> = Object.create(null);
    const paths: Record<string, string> = Object.create(null);
    const known = new Map<string, LazySkill>();
    for (const s of index.skills) {
      refs[s.id] = { id: s.id, root: s.root, path: s.path, dir: s.dir };
      paths[s.id] = s.path;
      known.set(s.id, { path: s.path, stamp: s.stamp, meta: { description: s.description, autoinvoke: s.autoinvoke, error: s.error } });
    }
    applySkillSnapshot({
      allIds: index.allIds,
      skillRefs: refs,
      skillPaths: paths,
      unreachable: index.unreachable,
      incomplete: false, // only complete scans are stored
      unreadable: index.unreadable,
      mds: Object.create(null),
      lazy: known,
    });
    S.opencodeText = opencodeText;
    S.bundlesText = bundlesText;
    S.state = state;
    S.projectTexts = Object.create(null);
    S.phase = 'preview';
    lastIndexText = panelIndexText(index);
    return true;
  } catch {
    return false; // the disk load reports real errors
  }
}
