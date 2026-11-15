// Browser/panel skill discovery via HostClient, using src/discover.js rules.
import { errorCode, isNotFound, pool, type FileHost } from '../shared/panel/host';
import { classifySkillDir, mergeSkillRefs, skillRoots, skipName, SKILL_SCAN_BUDGET, type DirEntry, type SkillRef } from '../src/discover.js';

export type Unreachable = {
  path: string;
  code: string;
};

export type DiscoveryResult = {
  skills: Record<string, SkillRef>;
  unreachable: Unreachable[];
};

const join = (a: string, b: string) => (b ? `${a.replace(/\/+$/, '')}/${b}` : a);

function unreachableCode(e: unknown): string | null {
  const code = errorCode(e);
  return code === 'BAD_PATH' || code === 'DENIED' ? code : null;
}

/**
 * Walk every skill root (global defaults + absolute/"~/" entries from opencode.json) via host.listDir,
 * resolving symlink ('other') entries with host.stat. Missing roots/dirs are ignored; BAD_PATH and
 * DENIED are collected in `unreachable` rather than throwing.
 */
export async function discoverSkills(host: FileHost, opencodeText: string | null): Promise<DiscoveryResult> {
  const roots = skillRoots(opencodeText);
  const perRoot: SkillRef[][] = roots.map(() => []);
  const unreachable: Unreachable[] = [];
  // The guest API can't tell us the home folder (a guess from project paths can't be verified),
  // so an absolute source might be "~/…" spelled out, and a SKILL.md directly in "~" has no known
  // name. Source order is then uncertain: report it instead of guessing.
  for (const r of roots) {
    if (r === '~' || (r.startsWith('/') && r !== '/')) unreachable.push({ path: r, code: 'NO_HOME' });
  }

  // The guest API has no realpath, so symlink loops are bounded by depth and a per-source listing
  // budget (per source, so one huge source cannot starve a higher-precedence one).
  const walkRoot = async (root: string): Promise<SkillRef[]> => {
    const refs: SkillRef[] = [];
    let budget = SKILL_SCAN_BUDGET;
    let truncated = false;
    let frontier: string[] = [''];
    while (frontier.length) {
      const nextFrontier: string[] = [];
      await pool(frontier, 8, async (rel) => {
        const dir = join(root, rel);
        if (budget-- <= 0) { truncated = true; return; }
        let entries: { name: string; kind: 'file' | 'directory' | 'other' }[];
        try {
          entries = (await host.listDir(dir)).entries;
        } catch (e) {
          if (isNotFound(e)) return;
          const code = unreachableCode(e);
          if (code) { unreachable.push({ path: dir, code }); return; }
          throw e;
        }

        const resolved: DirEntry[] = [];
        const others: string[] = [];
        for (const e of entries) {
          if (skipName(e.name)) continue;
          if (e.kind === 'file' || e.kind === 'directory') resolved.push({ name: e.name, kind: e.kind });
          else if (e.kind === 'other') others.push(e.name);
        }

        if (others.length) {
          await pool(others, 8, async (name) => {
            const p = join(dir, name);
            try {
              const { kind } = await host.stat(p);
              if (kind === 'file' || kind === 'directory') resolved.push({ name, kind });
            } catch (e) {
              if (isNotFound(e)) return;
              const code = unreachableCode(e);
              if (code) { unreachable.push({ path: p, code }); return; }
              throw e;
            }
          });
        }

        const { skills, subdirs } = classifySkillDir(root, rel, resolved);
        refs.push(...skills);
        nextFrontier.push(...subdirs);
      });
      frontier = nextFrontier;
    }
    if (truncated) unreachable.push({ path: `${root}: stopped after ${SKILL_SCAN_BUDGET} folders (symlink loop?)`, code: 'TRUNCATED' });
    return refs;
  };

  await pool(roots.map((root, i) => [root, i] as const), 4, async ([root, i]) => {
    perRoot[i] = await walkRoot(root);
  });

  return { skills: mergeSkillRefs(perRoot), unreachable };
}
