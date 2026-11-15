// Skill discovery, the way OpenCode V2 finds skills (https://opencode.ai/docs/skills/#discovery).
// Pure: adapters (CLI, panel) do the listing and feed each listed directory to classifySkillDir.

/** Global sources, lower to higher precedence (a later source wins an id). */
export const GLOBAL_SKILL_ROOTS = ["~/.claude/skills", "~/.agents/skills", "~/.config/opencode/skills"];
/** Search stops this many directories below a source root. */
export const SKILL_SCAN_DEPTH = 6;
export const SKILL_FILE = "SKILL.md";

// OpenCode's FSUtil.ignoredDirectories plus hidden entries.
const IGNORED = ["node_modules", ".git", ".venv", "venv", "__pycache__"];
export const skipName = (name) => name.startsWith(".") || IGNORED.includes(name);
const join = (a, b) => (!a ? b : b ? `${a.replace(/\/+$/, "")}/${b}` : a);

/**
 * A config `skills` entry as a root, or null when it is not a global local source. Like OpenCode,
 * only "/…" and "~/…" are absolute; URLs (HTTP catalogs) and anything else (relative, bare "~")
 * resolve from the working directory and are left out. "." segments and repeated slashes are
 * collapsed; ".." is refused. Home itself is "~", the filesystem root "/".
 */
export function normalizeRoot(entry) {
  if (typeof entry !== "string") return null;
  const v = entry.trim();
  if (!v || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return null;
  const tilde = v.startsWith("~/");
  if (!tilde && !v.startsWith("/")) return null;
  const segs = (tilde ? v.slice(2) : v).split("/").filter((x) => x !== "" && x !== ".");
  if (segs.includes("..")) return null;
  return tilde ? (segs.length ? `~/${segs.join("/")}` : "~") : `/${segs.join("/")}`;
}

/** Local `skills` entries of an opencode.json text, normalized, in array order. Bad JSON → []. */
export function configSkillRoots(opencodeText) {
  let cfg;
  try {
    cfg = JSON.parse(opencodeText);
  } catch {
    return [];
  }
  const list = cfg && typeof cfg === "object" && Array.isArray(cfg.skills) ? cfg.skills : [];
  return list.map(normalizeRoot).filter((r) => r !== null);
}

/** OpenCode's compatibility layer: loaded first, so lowest precedence. */
const COMPAT_ROOTS = GLOBAL_SKILL_ROOTS.slice(0, 2);

/**
 * Every global root to scan, lower to higher precedence. OpenCode loads `.claude`/`.agents` in a
 * compatibility layer, then its own sources (~/.config/opencode/skills, then config entries), where
 * a repeated source keeps its first position. A config entry naming a compatibility root therefore
 * re-adds it at the higher position; since a later root wins, the lower copy is dropped here.
 */
export function skillRoots(opencodeText, { home } = {}) {
  // Compare expanded spellings, so "~/x" and "/home/me/x" are one source (first spelling kept).
  const key = (r) => (home && (r === "~" || r.startsWith("~/")) ? `${home.replace(/\/+$/, "")}${r.slice(1)}` || "/" : r);
  const own = [];
  const ownKeys = [];
  for (const r of [GLOBAL_SKILL_ROOTS[2], ...(opencodeText == null ? [] : configSkillRoots(opencodeText))]) {
    if (ownKeys.includes(key(r))) continue;
    own.push(r);
    ownKeys.push(key(r));
  }
  return [...COMPAT_ROOTS.filter((r) => !ownKeys.includes(key(r))), ...own];
}

/**
 * One listed directory of a source. `rel` is the path below `root` ("" for the root itself).
 * `entries` kinds must already be resolved ('file' | 'directory'; drop anything else, and
 * resolve symlinks with a stat first).
 * Returns:
 *   skills:  SkillRefs found here (a SKILL.md folder, or root-level *.md files)
 *   subdirs: rel paths to list next (empty once this dir is a skill or the depth limit is hit)
 * A SkillRef is { id, root, path, dir }: `path` the markdown file, `dir` the skill's folder
 * (null for a flat root-level .md file).
 */
export function classifySkillDir(root, rel, entries, { home } = {}) {
  const here = join(root, rel);
  const visible = entries.filter((e) => !skipName(e.name));
  if (visible.some((e) => e.kind === "file" && e.name === SKILL_FILE)) {
    // A SKILL.md at the source root makes the root itself one skill, named after its folder.
    // For home ("~") that is home's own name, so it needs `home`; "/" has none and is skipped.
    const base = rel || (root === "~" ? (home ?? "") : root);
    const id = base.replace(/\/+$/, "").split("/").pop();
    return { skills: id && id !== "~" ? [{ id, root, path: join(here, SKILL_FILE), dir: here }] : [], subdirs: [] };
  }
  const skills = [];
  if (!rel) {
    for (const e of visible) {
      if (e.kind !== "file" || !e.name.endsWith(".md") || e.name === SKILL_FILE) continue;
      const id = e.name.slice(0, -3);
      if (id) skills.push({ id, root, path: join(here, e.name), dir: null });
    }
  }
  const depth = rel ? rel.split("/").length : 0;
  const subdirs = depth < SKILL_SCAN_DEPTH
    ? visible.filter((e) => e.kind === "directory").map((e) => join(rel, e.name))
    : [];
  return { skills, subdirs };
}

/**
 * Merge per-root results given in precedence order (lower first). Like OpenCode, each root's refs
 * are taken in sorted path order and every later ref overwrites an earlier one with the same id,
 * so a later root wins and, within a root, the last path in sort order wins.
 * Returns a null-prototype id → SkillRef map.
 */
export function mergeSkillRefs(perRoot) {
  const byId = Object.create(null);
  for (const refs of perRoot) {
    for (const r of [...refs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) byId[r.id] = r;
  }
  return byId;
}

/**
 * Most directories one source may list, so symlink loops stay cheap. Per source, so a huge
 * low-precedence source cannot starve a higher one. Hitting it makes discovery incomplete.
 */
export const SKILL_SCAN_BUDGET = 2000;
