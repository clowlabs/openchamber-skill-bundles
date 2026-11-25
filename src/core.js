import { replaceTopLevelValue, spliceTopLevelArray } from "../shared/core/json-splice.js";
import { createLockProtocol } from "../shared/core/lock.js";
import { splitDoc, stripComment, yamlQuote, parseFrontmatter, requireSupported, readKey, setKey, removeKey } from "../shared/core/frontmatter.js";
import { filterProjects, shortenDir } from "../shared/core/projects.js";

export { filterProjects, shortenDir };

export const BUNDLES_PATH = "~/.config/opencode/skill-bundles.json";
export const OPENCODE_PATH = "~/.config/opencode/opencode.json";
export const SKILLS_DIR = "~/.config/opencode/skills";
export const BUILTIN_SKILLS = ["opencode", "report"];
export const UNBUNDLED_ID = "__unbundled";
export const MODES = ["auto", "called", "off"];

export const CHARS_PER_SKILL = 180;

export function isBuiltin(id) {
  return BUILTIN_SKILLS.includes(id);
}

// Daily backup file name for opencode.json, by local calendar date.
export function backupName(date = new Date()) {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  return `opencode.json.skill-bundles-${ymd}`;
}
const hasOwn = (o, k) => o != null && Object.hasOwn(o, k);
// Null-prototype copy so ids like "__proto__" / "constructor" are plain data keys.
function copyOverrides(src) {
  const out = Object.create(null);
  if (src) for (const k of Object.keys(src)) out[k] = src[k];
  return out;
}
const uniq = (arr) => [...new Set(arr)];

// ---------- bundles state ----------

export function parseBundles(text, { home } = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`skill-bundles.json is not valid JSON: ${e.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("skill-bundles.json must be a JSON object");
  }
  if (raw.version !== 1) {
    throw new Error(`skill-bundles.json: unsupported version ${JSON.stringify(raw.version)} (expected 1)`);
  }
  if (!Array.isArray(raw.bundles)) throw new Error("skill-bundles.json: \"bundles\" must be an array");
  const seen = new Set();
  const bundles = raw.bundles.map((b, i) => {
    const where = `skill-bundles.json: bundles[${i}]`;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error(`${where} must be an object`);
    if (typeof b.id !== "string" || !b.id) throw new Error(`${where}.id must be a non-empty string`);
    if (b.id === UNBUNDLED_ID) throw new Error(`${where}.id "${UNBUNDLED_ID}" is reserved`);
    if (seen.has(b.id)) throw new Error(`${where}.id "${b.id}" is duplicated`);
    seen.add(b.id);
    if (b.name !== undefined && typeof b.name !== "string") throw new Error(`${where}.name must be a string`);
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new Error(`${where}.enabled must be a boolean`);
    const skills = b.skills ?? [];
    if (!Array.isArray(skills) || skills.some((s) => typeof s !== "string" || !s)) {
      throw new Error(`${where}.skills must be an array of non-empty strings`);
    }
    const out = { id: b.id, name: b.name || b.id, enabled: b.enabled === true, skills: uniq(skills) };
    const projects = parseDirList(b.projects, `${where}.projects`, home);
    if (projects) out.projects = projects;
    const excludedProjects = parseDirList(b.excludedProjects, `${where}.excludedProjects`, home);
    if (excludedProjects) out.excludedProjects = excludedProjects;
    return out;
  });
  const ov = raw.overrides ?? {};
  if (!ov || typeof ov !== "object" || Array.isArray(ov)) throw new Error("skill-bundles.json: \"overrides\" must be an object");
  const overrides = Object.create(null);
  for (const [k, v] of Object.entries(ov)) {
    if (!MODES.includes(v)) throw new Error(`skill-bundles.json: overrides["${k}"] must be one of ${MODES.join(", ")}`);
    overrides[k] = v;
  }
  const out = { version: 1, bundles, overrides };
  const pc = parseProjectCopies(raw.projectCopies);
  if (pc) out.projectCopies = pc;
  const mp = parseDirList(raw.managedProjects, "skill-bundles.json: managedProjects", home);
  if (mp) out.managedProjects = mp;
  return out;
}

export function serializeBundles(state) {
  const out = {
    version: 1,
    bundles: state.bundles.map((b) => {
      const o = { id: b.id, name: b.name, enabled: !!b.enabled, skills: [...b.skills] };
      if (b.projects?.length) o.projects = dirList(b.projects);
      if (b.excludedProjects?.length) o.excludedProjects = dirList(b.excludedProjects);
      return o;
    }),
    overrides: copyOverrides(state.overrides),
  };
  const pc = parseProjectCopies(state.projectCopies);
  if (pc) out.projectCopies = pc;
  if (state.managedProjects?.length) out.managedProjects = dirList(state.managedProjects);
  return JSON.stringify(out, null, 2) + "\n";
}

// ---------- project copies (optional; "send skill to project") ----------

// Optional map { [skillId]: [projectDir, ...] }. Absent or empty → undefined, so files without it round-trip unchanged.
function parseProjectCopies(pc) {
  if (pc === undefined || pc === null) return undefined;
  if (typeof pc !== "object" || Array.isArray(pc)) throw new Error("skill-bundles.json: \"projectCopies\" must be an object");
  const out = Object.create(null);
  for (const [k, v] of Object.entries(pc)) {
    if (!Array.isArray(v) || v.some((d) => typeof d !== "string" || !d)) {
      throw new Error(`skill-bundles.json: projectCopies["${k}"] must be an array of non-empty strings`);
    }
    if (v.length) out[k] = uniq(v);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Record that `id` was copied into `projectDir`. Returns NEW state. */
export function addProjectCopy(state, id, projectDir) {
  if (typeof id !== "string" || !id) throw new Error("Skill id must be a non-empty string");
  const dir = normalizeDir(projectDir);
  const pc = Object.create(null);
  if (state.projectCopies) for (const k of Object.keys(state.projectCopies)) pc[k] = [...state.projectCopies[k]];
  pc[id] = uniq([...(pc[id] ?? []), dir]);
  return { ...state, projectCopies: pc };
}

/** Move to a project: record the copy and turn the global skill off. */
export function markMovedToProject(state, id, projectDir) {
  return setOverride(addProjectCopy(state, id, projectDir), id, "off");
}

// Pre-normalize `home` once per loop/call; null when absent or not an absolute directory.
function normalizeHome(home) {
  if (typeof home !== "string" || !home.startsWith("/")) return null;
  const h = normalizeDirWithHome(home, null);
  return h === "/" ? null : h;
}

// Normalized, deduped, sorted dir list.
function dirList(dirs, home) {
  const h = normalizeHome(home);
  return uniq(dirs.map((d) => normalizeDirWithHome(d, h))).sort();
}

// Optional dir list from a file: undefined when absent or empty. Stored aliases are migrated
// to their canonical spelling and deduped.
function parseDirList(v, where, home) {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((d) => typeof d !== "string" || !d)) throw new Error(`${where} must be an array of directory strings`);
  let out;
  try {
    out = dirList(v, home);
  } catch (e) {
    throw new Error(`${where}: ${e.message}`);
  }
  return out.length ? out : undefined;
}

// Canonical spelling with a pre-normalized `home` (`null` = none): "." segments, repeated and
// trailing slashes collapsed; ".." refused. Under `home`, spelled "~/…" (home itself "~").
function normalizeDirWithHome(dir, h) {
  if (typeof dir !== "string" || !(dir.startsWith("/") || dir === "~" || dir.startsWith("~/"))) {
    throw new Error(`Project directory must be absolute: ${JSON.stringify(dir)}`);
  }
  const tilde = dir === "~" || dir.startsWith("~/");
  const segs = (tilde ? dir.slice(1) : dir).split("/").filter((x) => x !== "" && x !== ".");
  if (segs.includes("..")) throw new Error(`Project directory must not contain "..": ${dir}`);
  let d = tilde ? (segs.length ? `~/${segs.join("/")}` : "~") : `/${segs.join("/")}`;
  if (!tilde && h !== null && (d === h || d.startsWith(h + "/"))) {
    d = d === h ? "~" : `~${d.slice(h.length)}`;
  }
  return d;
}

function normalizeDir(dir, home) {
  return normalizeDirWithHome(dir, normalizeHome(home));
}

/** `<projectDir>/.opencode/skills/<id>` */
export function projectSkillDir(projectDir, id) {
  if (typeof id !== "string" || !id || id.includes("/") || id === "." || id === "..") throw new Error(`Bad skill id ${JSON.stringify(id)}`);
  const d = normalizeDir(projectDir);
  return `${d === "/" ? "" : d}/.opencode/skills/${id}`;
}

/** OpenChamber's synthetic per-chat directories are not real projects. */
export function isChatsDir(dir) {
  return /(^|\/)\.config\/openchamber\/chats(\/|$)/.test(String(dir ?? ""));
}

/** True when text read as UTF-8 looks like it was not text (replacement chars or NULs). */
export function looksBinary(text) {
  return text.includes("\uFFFD") || text.includes("\0");
}

function normalizeScopeWithHome(dir, h) {
  if (!dir || isChatsDir(dir)) return null;
  try {
    const d = normalizeDirWithHome(dir, h);
    return d === "~" || d === "/" ? null : d;
  } catch {
    return null;
  }
}

/** Normalized project dir when `dir` is a real project scope (not null, chats dir, "~", "/", or invalid); else null. */
export function normalizeScopeDir(dir, { home } = {}) {
  try {
    return normalizeScopeWithHome(dir, normalizeHome(home));
  } catch {
    return null;
  }
}

function sameDirWithNormalizedTarget(x, normalizedTarget, h) {
  try {
    return normalizeDirWithHome(x, h) === normalizedTarget;
  } catch {
    return false;
  }
}

/** True when `a` and `b` normalize to the same project directory (falling back to strict equality on invalid paths). */
export function sameProjectDir(a, b, { home } = {}) {
  try {
    const h = normalizeHome(home);
    return normalizeDirWithHome(a, h) === normalizeDirWithHome(b, h);
  } catch {
    return a === b;
  }
}

const hasNormalizedDir = (list, d, h) => (list ?? []).some((x) => sameDirWithNormalizedTarget(x, d, h));
const isBundleActiveInNormalizedDir = (b, d, h) =>
  hasNormalizedDir(b.projects, d, h) || (!!b.enabled && !hasNormalizedDir(b.excludedProjects, d, h));

function resolveScope(opts) {
  if (!opts?.projectDir || isChatsDir(opts.projectDir)) return { scopeDir: null, h: null };
  try {
    const h = normalizeHome(opts.home);
    return { scopeDir: normalizeScopeWithHome(opts.projectDir, h), h };
  } catch {
    return { scopeDir: null, h: null };
  }
}

/** True when `bundle` is active in `projectDir` (or globally when `projectDir` is not a project scope). */
export function isBundleActive(bundle, opts = {}) {
  const { scopeDir, h } = resolveScope(opts);
  return scopeDir === null ? !!bundle.enabled : isBundleActiveInNormalizedDir(bundle, scopeDir, h);
}

/** Turn `bundleId` on or off in `projectDir` (or globally when `projectDir` is not a project scope). */
export function setBundleInScope(state, bundleId, on, { projectDir, home } = {}) {
  const d = normalizeScopeDir(projectDir, { home });
  if (d === null) return setBundleGlobal(state, bundleId, on);
  const b = requireBundle(state, bundleId);
  const hOpt = home ? { home } : {};
  if (on) return includeBundleProject(state, bundleId, d, hOpt);
  return b.enabled ? excludeBundleProject(state, bundleId, d, hOpt) : removeBundleProject(state, bundleId, d, hOpt);
}

function effectiveModeInScope(state, id, scopeDir, h) {
  const ov = hasOwn(state.overrides, id) && MODES.includes(state.overrides[id]) ? state.overrides[id] : undefined;
  let mode = ov ?? (
    state.bundles.some(
      (b) => b.skills.includes(id) && (scopeDir === null ? !!b.enabled : isBundleActiveInNormalizedDir(b, scopeDir, h)),
    )
      ? "auto"
      : "off"
  );
  if (mode === "called" && isBuiltin(id)) mode = "auto";
  return mode;
}

export function effectiveMode(state, id, opts) {
  const { scopeDir, h } = resolveScope(opts);
  return effectiveModeInScope(state, id, scopeDir, h);
}

// Precompute bundle membership once for callers looking up many skills.
function modeLookup(state, opts) {
  const { scopeDir, h } = resolveScope(opts);
  const activeSkills = new Set();
  for (const b of state.bundles) {
    if (scopeDir === null ? !!b.enabled : isBundleActiveInNormalizedDir(b, scopeDir, h)) {
      for (const s of b.skills) activeSkills.add(s);
    }
  }
  return (id) => {
    const ov = hasOwn(state.overrides, id) && MODES.includes(state.overrides[id]) ? state.overrides[id] : undefined;
    let m = ov ?? (activeSkills.has(id) ? "auto" : "off");
    if (m === "called" && isBuiltin(id)) m = "auto";
    return m;
  };
}

// Counts over allIds; `chars` estimates prompt size (only auto skills are advertised).
export function summary(state, allIds, opts) {
  const mode = modeLookup(state, opts);
  let auto = 0, called = 0;
  for (const id of allIds) {
    const m = mode(id);
    if (m === "auto") auto++;
    else if (m === "called") called++;
  }
  return { on: auto + called, auto, called, chars: auto * CHARS_PER_SKILL };
}

export function groups(state, allIds) {
  const inAny = new Set(state.bundles.flatMap((b) => b.skills));
  const unbundled = uniq(allIds.filter((id) => !inAny.has(id))).sort();
  return [
    ...state.bundles.map((b) => ({
      id: b.id,
      name: b.name,
      enabled: b.enabled,
      skills: [...b.skills],
      ...(b.projects?.length ? { projects: [...b.projects] } : {}),
      ...(b.excludedProjects?.length ? { excludedProjects: [...b.excludedProjects] } : {}),
    })),
    { id: UNBUNDLED_ID, name: "Unbundled", enabled: false, skills: unbundled, synthetic: true },
  ];
}

function requireBundle(state, id) {
  const b = state.bundles.find((x) => x.id === id);
  if (!b) throw new Error(`Unknown bundle "${id}"`);
  return b;
}

const mapBundle = (state, id, fn) => ({
  ...state,
  bundles: state.bundles.map((b) => (b.id === id ? fn(b) : b)),
});

export function setBundleEnabled(state, bundleId, on) {
  const b = requireBundle(state, bundleId);
  const overrides = copyOverrides(state.overrides);
  for (const s of b.skills) delete overrides[s];
  return { ...setBundleGlobal(state, bundleId, on), overrides };
}

export function setBundleGlobal(state, bundleId, on) {
  requireBundle(state, bundleId);
  const flag = !!on;
  return mapBundle(state, bundleId, (x) => {
    const next = { ...x, enabled: flag };
    if (!flag) delete next.excludedProjects;
    return next;
  });
}

export function setOverride(state, id, mode) {
  const overrides = copyOverrides(state.overrides);
  if (mode === null || mode === undefined) delete overrides[id];
  else if (!MODES.includes(mode)) throw new Error(`Invalid mode "${mode}" (expected ${MODES.join(", ")})`);
  else overrides[id] = mode;
  return { ...state, overrides };
}

export function moveSkill(state, id, fromBundle, toBundle, { copy = false } = {}) {
  const from = fromBundle === UNBUNDLED_ID ? null : fromBundle ?? null;
  const to = toBundle === UNBUNDLED_ID ? null : toBundle ?? null;
  if (from === to) return state;
  if (from) requireBundle(state, from);
  if (to) requireBundle(state, to);
  return {
    ...state,
    bundles: state.bundles.map((b) => {
      if (b.id === to) return b.skills.includes(id) ? b : { ...b, skills: [...b.skills, id] };
      if (b.id === from && !copy && b.skills.includes(id)) return { ...b, skills: b.skills.filter((s) => s !== id) };
      return b;
    }),
  };
}

function kebab(name) {
  return String(name).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bundle";
}

export function createBundle(state, name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("Bundle name must not be empty");
  const base = kebab(trimmed);
  const taken = new Set([...state.bundles.map((b) => b.id), UNBUNDLED_ID]);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return { ...state, bundles: [...state.bundles, { id, name: trimmed, enabled: false, skills: [] }] };
}

export function renameBundle(state, id, name) {
  requireBundle(state, id);
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("Bundle name must not be empty");
  return mapBundle(state, id, (b) => ({ ...b, name: trimmed }));
}

export function deleteBundle(state, id) {
  requireBundle(state, id);
  return { ...state, bundles: state.bundles.filter((b) => b.id !== id) };
}

// ---------- opencode.json ----------

/** Every skill id a state mentions (bundle members and overrides). */
function stateIds(state) {
  return uniq([...state.bundles.flatMap((b) => b.skills), ...Object.keys(state.overrides ?? {})]);
}

export function applyPermissions(opencodeText, state, allIds, { prevState = null } = {}) {
  let cfg;
  try {
    cfg = JSON.parse(opencodeText);
  } catch (e) {
    throw new Error(`opencode.json is not valid JSON: ${e.message}`);
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("opencode.json must be a JSON object");
  if (hasOwn(cfg, "permissions") && !Array.isArray(cfg.permissions)) {
    throw new Error("opencode.json: \"permissions\" exists but is not an array; fix it by hand");
  }
  const existing = cfg.permissions ?? [];
  const ids = uniq([...allIds, ...BUILTIN_SKILLS]).sort();
  const mode = modeLookup(state);
  if (prevState) {
    const prevMode = modeLookup(prevState);
    // Ids the bundles mention count too: an undiscovered skill can still be switched on or off.
    ids.push(...stateIds(prevState), ...stateIds(state));
    ids.splice(0, ids.length, ...uniq(ids).sort());
    // Discovery was incomplete, so rules may cover skills we could not see. Keep every rule in
    // order and only restate the ids whose mode this change actually flips (last rule wins).
    const changed = ids.filter((id) => (prevMode(id) === "off") !== (mode(id) === "off"));
    if (!changed.length) return opencodeText;
    const set = new Set(changed);
    const keep = (r) => !(r && r.action === "skill" && set.has(r.resource));
    const add = changed.map((id) => ({ action: "skill", resource: id, effect: mode(id) === "off" ? "deny" : "allow" }));
    return spliceTopLevelArray(opencodeText, "permissions", { keep, add, label: "opencode.json" });
  }
  const kept = existing.filter((r) => !(r && r.action === "skill"));
  const allows = ids
    .filter((id) => mode(id) !== "off")
    .map((id) => ({ action: "skill", resource: id, effect: "allow" }));
  const permissions = [...kept, { action: "skill", resource: "*", effect: "deny" }, ...allows];
  return replaceTopLevelValue(opencodeText, "permissions", permissions, { label: "opencode.json" });
}

// ---------- SKILL.md frontmatter (built on shared/core/frontmatter) ----------

const FM = { reserved: ["metadata", "description", "opencode/autoinvoke", "disable-model-invocation"], maps: ["metadata"], label: "SKILL.md" };
const AUTO = { parent: "metadata" };

const isFalse = (v) => /^(false|no|off)$/i.test(stripComment(v).replace(/^["']|["']$/g, "").trim());
const isTrue = (v) => /^(true|yes|on)$/i.test(stripComment(v).replace(/^["']|["']$/g, "").trim());

function parseSkill(md) {
  const fm = parseFrontmatter(md, FM);
  if (fm.info) requireSupported(fm.info, FM.label);
  return fm;
}

// opencode/autoinvoke wins; otherwise disable-model-invocation: true means false.
function readAutoinvoke(fm) {
  const a = readKey(fm, "opencode/autoinvoke", AUTO);
  if (a) return !isFalse(a.raw);
  const d = readKey(fm, "disable-model-invocation");
  return !(d && isTrue(d.raw));
}

export function readFrontmatter(skillMd) {
  const fm = parseSkill(skillMd);
  if (!fm.info) return { description: "", autoinvoke: true, hasFrontmatter: false };
  return { description: readKey(fm, "description")?.value ?? "", autoinvoke: readAutoinvoke(fm), hasFrontmatter: true };
}

export function setAutoinvoke(skillMd, on) {
  const fm = parseSkill(skillMd);
  if (!fm.info) return on ? skillMd : setKey(skillMd, "opencode/autoinvoke", "false", { ...FM, ...AUTO });
  if (on) {
    // disable-model-invocation: true would still block auto-invocation; flip it in place.
    const d = readKey(fm, "disable-model-invocation");
    let text = skillMd;
    if (d && isTrue(d.raw)) {
      const out = [...fm.lines];
      out[d.line] = out[d.line].replace(/:\s*.*$/, ": false");
      text = out.join(fm.eol);
    }
    return removeKey(text, "opencode/autoinvoke", { ...FM, ...AUTO });
  }
  if (!readAutoinvoke(fm)) return skillMd;
  return setKey(skillMd, "opencode/autoinvoke", "false", { ...FM, ...AUTO });
}

export function setDescription(skillMd, text) {
  const single = String(text ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
  return setKey(skillMd, "description", yamlQuote(single), { ...FM, after: "name" });
}

// ---------- sync ----------

// Conservative textual probe for an explicit "don't auto-invoke" we could not parse safely.
function mentionsDisable(md) {
  const { lines, end } = splitDoc(md);
  const fm = end < 0 ? [] : lines.slice(1, end);
  // Conservative: any mention at all (escapes decoded) counts as an opt-out we cannot vouch for.
  return fm.some((raw) => {
    // decode escapes and drop quotes/backslashes so "opencode\/autoinvoke" or \u0073 spellings still match
    const l = raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/[\\"']/g, "");
    return /autoinvoke|disable-model-invocation/i.test(l);
  });
}

export function syncPlan(state, allIds, skillMds, unreadable = []) {
  const skillEdits = [];
  const skipped = [];
  const blind = new Set(unreadable);
  const lookup = modeLookup(state);
  for (const id of uniq(allIds)) {
    if (isBuiltin(id)) continue;
    const text = hasOwn(skillMds, id) ? skillMds[id] : undefined;
    const mode = lookup(id);
    if (mode === "off") continue;
    if (typeof text !== "string") {
      // No text: "called" needs an edit we cannot make; "auto" may hide an opt-out. Never silent,
      // whether the file was unreadable or simply not read (vanished, or an adapter skipped it).
      const why = blind.has(id) ? "could not be read" : "was not read";
      if (mode === "called") throw Object.assign(new Error(`${id}: SKILL.md ${why}, so it cannot be set to "when called"`), { id });
      skipped.push({ id, reason: `SKILL.md ${why}` });
      continue;
    }
    const want = mode !== "called";
    let next;
    try {
      next = setAutoinvoke(text, want);
    } catch (e) {
      // "auto" needs no SKILL.md change unless the file opts out in a way we can't remove.
      if (want && !mentionsDisable(text)) {
        skipped.push({ id, reason: e.message });
        continue;
      }
      throw new Error(`skills/${id}/SKILL.md: ${e.message}`);
    }
    if (next !== text) skillEdits.push({ id, next });
  }
  return { opencode: (text, opts) => applyPermissions(text, state, allIds, opts), skillEdits, skipped };
}

// ---------- save planner (shared by CLI and panel) ----------

/** Publication order for every adapter: SKILL.md, project opencode.json files, global opencode.json, skill-bundles.json. */
export const PUBLISH_ORDER = ["skill", "project", "opencode", "bundles"];

const tag = (e, file, id) => Object.assign(e instanceof Error ? e : new Error(String(e)), { file, ...(id ? { id } : {}) });

/**
 * Pure: everything that must be written to move from `prev` (texts as read) to `next`.
 * prev.bundlesText null = file absent (seeding). Errors carry `.file` ("opencode" | "skill").
 */
export function planChange(prev, next, allIds, projectTexts, { home } = {}) {
  next = canonicalizeProjects(next, { home }); // one write per physical spelling of a dir
  if (typeof prev?.opencodeText !== "string") throw tag(new Error("opencode.json not found"), "opencode");
  const mds = prev.skillMds ?? Object.create(null);
  const ptexts = projectTexts ?? Object.create(null);
  let plan;
  try {
    plan = syncPlan(next, allIds, mds, prev.unreadable ?? []);
  } catch (e) {
    throw tag(e, "skill", e?.id);
  }
  let prevState = null;
  if (prev.incomplete) {
    if (typeof prev.bundlesText !== "string") throw tag(new Error("Some skill folders could not be read; create skill-bundles.json once they can be"), "skill");
    prevState = parseBundles(prev.bundlesText, { home });
    // An unscanned folder may hold a higher-precedence copy of any skill, so changes that depend
    // on which SKILL.md is used ("when called" either way) are refused. On/off stays available.
    const blocked = uniq([...allIds, ...stateIds(prevState), ...stateIds(next)]).filter((id) => {
      const a = effectiveMode(prevState, id), b = effectiveMode(next, id);
      return a !== b && (a === "called" || b === "called");
    }).sort();
    if (blocked.length) {
      throw tag(new Error(`Some skill folders could not be read, so it is unclear which SKILL.md ${blocked.join(", ")} uses; "when called" can't be changed until they can. On/off still works.`), "skill", blocked[0]);
    }
  }
  if (prevState && plan.skillEdits.length) {
    // Permission-only while incomplete: no SKILL.md is touched, since it may be the wrong copy.
    for (const { id } of plan.skillEdits) plan.skipped.push({ id, reason: "some skill folders could not be read, so SKILL.md was left alone" });
    plan.skillEdits = [];
  }
  let opencodeAfter;
  try {
    opencodeAfter = plan.opencode(prev.opencodeText, prevState ? { prevState } : undefined);
  } catch (e) {
    throw tag(e, "opencode");
  }
  const writes = [];
  for (const { id, next: after } of [...plan.skillEdits].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const before = hasOwn(mds, id) ? mds[id] : undefined;
    const path = hasOwn(prev.skillPaths, id) ? prev.skillPaths[id] : `${SKILLS_DIR}/${id}/SKILL.md`;
    if (before !== undefined && after !== before) writes.push({ kind: "skill", id, path, before, after });
  }
  // project files: every target dir; managedProjects follows what is actually written
  const managed = new Set(next.managedProjects ?? []);
  for (const dir of projectTargets(next)) {
    if (!hasOwn(ptexts, dir)) throw tag(new Error(`project file for ${dir} was not read`), "project", dir);
    const before = ptexts[dir];
    const { allowIds, denyIds } = projectRuleSet(next, dir);
    let after;
    try {
      after = applyProjectPermissions(before, allowIds, { denyIds });
    } catch (e) {
      throw tag(new Error(`${projectConfigPath(dir)}: ${e.message}`), "project", dir);
    }
    if (after !== null && after !== before) {
      writes.push({ kind: "project", dir, path: projectConfigPath(dir), before, after });
    }
    const inBundle = (allowIds.length > 0 || denyIds.length > 0) && next.bundles.some(
      (b) => (b.projects ?? []).includes(dir) || (b.excludedProjects ?? []).includes(dir),
    );
    if (inBundle && after !== null) managed.add(dir);
    else if (!inBundle) managed.delete(dir); // rules removed by this plan (or none were there)
  }
  const finalState = { ...next, managedProjects: [...managed].sort() };
  if (!finalState.managedProjects.length) delete finalState.managedProjects;
  if (opencodeAfter !== prev.opencodeText) {
    writes.push({ kind: "opencode", path: OPENCODE_PATH, before: prev.opencodeText, after: opencodeAfter });
  }
  const bundlesAfter = serializeBundles(finalState);
  const bundlesBefore = prev.bundlesText ?? null;
  if (bundlesAfter !== bundlesBefore) writes.push({ kind: "bundles", path: BUNDLES_PATH, before: bundlesBefore, after: bundlesAfter });
  return { writes, skipped: plan.skipped, order: [...PUBLISH_ORDER], state: finalState };
}

// ---------- writer lock protocol (shared by CLI and panel; I/O stays in the adapters) ----------

export const LOCK_PATH = "~/.config/opencode/.skill-bundles.lock";
/** A panel lock is held for at most this long after its time (or mtime, whichever is later). */
export const PANEL_LOCK_TTL_MS = 60_000;
/** An unparseable lock, or one from another host, is reclaimable once its mtime is this old. */
export const LOCK_UNPARSEABLE_STALE_MS = 10 * 60_000;
const LOCK = createLockProtocol({ ownerName: "panel", ttlMs: PANEL_LOCK_TTL_MS, unparseableStaleMs: LOCK_UNPARSEABLE_STALE_MS });
const KIND = { process: "cli", holder: "panel" };

/** What the panel writes to release (it cannot delete). Counts as free. */
export const RELEASED_MARKER = LOCK.releasedMarker;

/** The exact text the panel writes to take the lock. */
export function panelLockRecord(token, now) {
  return LOCK.makeHolderRecord(token, now);
}

/** Lock file text → { kind: "cli" | "panel" | "released" | "invalid", ... }. */
export function parseLock(text) {
  const info = LOCK.parseLock(text);
  return KIND[info.kind] ? { ...info, kind: KIND[info.kind] } : info;
}

const UNKIND = { cli: "process", panel: "holder" };

/**
 * parsed lock (null = no lock file) → "free" | "held" | "stale". "stale" may be reclaimed.
 * opts: now and mtimeMs in ms; host = this machine; pidAlive(pid) probes a local pid.
 * A CLI lock is judged by its pid only when it is from `host` and pidAlive is given; otherwise
 * by the 10-minute mtime rule, like an unparseable lock.
 */
export function classifyLock(info, opts = {}) {
  return LOCK.classifyLock(info && UNKIND[info.kind] ? { ...info, kind: UNKIND[info.kind] } : info, opts);
}

// ---------- per-project bundles (v0.2) ----------

export const PROJECT_CONFIG_REL = ".opencode/opencode.json";

/** Normalized project dir (absolute or "~/…", no "..", no trailing "/"); throws otherwise. */
export function normalizeProjectDir(dir, { home } = {}) {
  return normalizeDir(dir, home);
}

/** `<dir>/.opencode/opencode.json` for a normalized dir. */
export function projectConfigPath(dir) {
  const d = normalizeDir(dir);
  return `${d === "/" ? "" : d}/${PROJECT_CONFIG_REL}`;
}

const withProjects = (b, dirs) => {
  const { projects, ...rest } = b;
  return dirs.length ? { ...rest, projects: dirs } : rest;
};

const withExcluded = (b, dirs) => {
  const { excludedProjects, ...rest } = b;
  return dirs.length ? { ...rest, excludedProjects: dirs } : rest;
};

function canonicalizeProjectsWithHome(state, h) {
  const dirListWithHome = (dirs) => uniq(dirs.map((d) => normalizeDirWithHome(d, h))).sort();
  let changed = false;
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const bundles = state.bundles.map((b) => {
    let cur = b;
    if (cur.projects) {
      const list = dirListWithHome(cur.projects);
      if (!same(list, cur.projects)) { changed = true; cur = withProjects(cur, list); }
    }
    if (cur.excludedProjects) {
      const list = dirListWithHome(cur.excludedProjects);
      if (!same(list, cur.excludedProjects)) { changed = true; cur = withExcluded(cur, list); }
    }
    return cur;
  });
  let managed = state.managedProjects;
  if (managed) {
    const list = dirListWithHome(managed);
    if (!same(list, managed)) { changed = true; managed = list; }
  }
  if (!changed) return state;
  const out = { ...state, bundles };
  if (managed?.length) out.managedProjects = managed;
  else delete out.managedProjects;
  return out;
}

/**
 * Every bundle's projects, excludedProjects and managedProjects in canonical spelling (aliases merged, deduped).
 * Returns `state` itself when nothing changes.
 */
export function canonicalizeProjects(state, { home } = {}) {
  return canonicalizeProjectsWithHome(state, normalizeHome(home));
}

/**
 * Merge dirs that callers found to be the same folder: `aliases` maps a canonical dir to the
 * canonical dir it should be stored as. Pure; adapters decide aliases (e.g. via realpath).
 */
export function mergeProjectDirs(state, aliases) {
  const to = (d) => (hasOwn(aliases, d) ? aliases[d] : d);
  const bundles = state.bundles.map((b) => {
    let cur = b;
    if (cur.projects) cur = withProjects(cur, uniq(cur.projects.map(to)).sort());
    if (cur.excludedProjects) cur = withExcluded(cur, uniq(cur.excludedProjects.map(to)).sort());
    return cur;
  });
  const out = { ...state, bundles };
  if (state.managedProjects) {
    const m = uniq(state.managedProjects.map(to)).sort();
    if (m.length) out.managedProjects = m;
    else delete out.managedProjects;
  }
  return out;
}

export function setBundleProjects(state, bundleId, dirs, { home } = {}) {
  requireBundle(state, bundleId);
  const list = dirList(dirs ?? [], home);
  return mapBundle(state, bundleId, (b) => withProjects(b, list));
}

export function addBundleProject(state, bundleId, dir, opts = {}) {
  const b = requireBundle(state, bundleId);
  const d = normalizeDir(dir, opts.home);
  const projects = dirList([...(b.projects ?? []), d], opts.home);
  const excluded = dirList((b.excludedProjects ?? []).filter((x) => normalizeDir(x, opts.home) !== d), opts.home);
  return mapBundle(state, bundleId, (x) => withExcluded(withProjects(x, projects), excluded));
}

export function removeBundleProject(state, bundleId, dir, opts = {}) {
  const b = requireBundle(state, bundleId);
  const d = normalizeDir(dir, opts.home);
  return setBundleProjects(state, bundleId, (b.projects ?? []).filter((x) => normalizeDir(x, opts.home) !== d), opts);
}

export function excludeBundleProject(state, bundleId, dir, opts = {}) {
  const b = requireBundle(state, bundleId);
  const d = normalizeDir(dir, opts.home);
  const projects = dirList((b.projects ?? []).filter((x) => normalizeDir(x, opts.home) !== d), opts.home);
  const excluded = b.enabled ? dirList([...(b.excludedProjects ?? []), d], opts.home) : [];
  return mapBundle(state, bundleId, (x) => withExcluded(withProjects(x, projects), excluded));
}

export function includeBundleProject(state, bundleId, dir, opts = {}) {
  const b = requireBundle(state, bundleId);
  const d = normalizeDir(dir, opts.home);
  const excluded = dirList((b.excludedProjects ?? []).filter((x) => normalizeDir(x, opts.home) !== d), opts.home);
  const projects = b.enabled ? dirList(b.projects ?? [], opts.home) : dirList([...(b.projects ?? []), d], opts.home);
  return mapBundle(state, bundleId, (x) => withExcluded(withProjects(x, projects), excluded));
}

/** Canonical project dirs where `skillId` is allowed (via any bundle that lists the dir), sorted. */
export function projectsFor(state, skillId, opts = {}) {
  if (hasOwn(state.overrides, skillId) && state.overrides[skillId] === "off") return [];
  const s = canonicalizeProjects(state, opts);
  return uniq(s.bundles.filter((b) => b.skills.includes(skillId)).flatMap((b) => b.projects ?? [])).sort();
}

/** Skill ids allowed in canonical `dir`, sorted (state must already be canonical). */
function projectSkills(state, dir) {
  return uniq(
    state.bundles
      .filter((b) => (b.projects ?? []).includes(dir))
      .flatMap((b) => b.skills)
      .filter((id) => !(hasOwn(state.overrides, id) && state.overrides[id] === "off")),
  ).sort();
}

/** Skill ids explicitly denied in canonical `dir` because every global bundle holding them excludes `dir` (state must already be canonical). */
function projectDenySkills(state, dir) {
  const candidateIds = uniq(
    state.bundles
      .filter((b) => b.enabled && (b.excludedProjects ?? []).includes(dir))
      .flatMap((b) => b.skills),
  );
  if (!candidateIds.length) return [];
  const activeInDir = new Set(
    state.bundles
      .filter((b) => (b.projects ?? []).includes(dir) || (b.enabled && !(b.excludedProjects ?? []).includes(dir)))
      .flatMap((b) => b.skills),
  );
  return candidateIds.filter((id) => {
    if (hasOwn(state.overrides, id)) return false;
    if (effectiveModeInScope(state, id, null, null) === "off") return false;
    return !activeInDir.has(id);
  }).sort();
}

/** Exact sorted allow and deny skill ids for `dir` (canonicalized with `opts.home`). */
export function projectRuleSet(state, dir, opts = {}) {
  const h = normalizeHome(opts.home);
  const s = canonicalizeProjectsWithHome(state, h);
  const d = normalizeDirWithHome(dir, h);
  return {
    allowIds: projectSkills(s, d),
    denyIds: projectDenySkills(s, d),
  };
}

/** Canonical dirs whose project file must be (re)written: bundle projects ∪ excludedProjects ∪ managedProjects. Sorted. */
export function projectTargets(state, opts = {}) {
  const s = canonicalizeProjects(state, opts);
  return uniq([
    ...s.bundles.flatMap((b) => b.projects ?? []),
    ...s.bundles.flatMap((b) => b.excludedProjects ?? []),
    ...(s.managedProjects ?? []),
  ]).sort();
}

const NEW_PROJECT_FILE = (rules) => JSON.stringify({ $schema: "https://opencode.ai/config.json", permissions: rules }, null, 2) + "\n";

/**
 * Pure: project opencode.json text with its skill rules replaced by denies then allows.
 * null text = file missing; returns null when there is nothing to write.
 */
export function applyProjectPermissions(text, skillIds, { denyIds = [] } = {}) {
  const denies = uniq(denyIds).sort().map((id) => ({ action: "skill", resource: id, effect: "deny" }));
  const allows = uniq(skillIds).sort().map((id) => ({ action: "skill", resource: id, effect: "allow" }));
  const rules = [...denies, ...allows];
  if (text === null || text === undefined) return rules.length ? NEW_PROJECT_FILE(rules) : null;
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON: ${e.message}`);
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("must be a JSON object");
  if (hasOwn(cfg, "permissions") && !Array.isArray(cfg.permissions)) {
    throw new Error("\"permissions\" exists but is not an array; fix it by hand");
  }
  const existing = cfg.permissions ?? [];
  const hadSkill = existing.some((r) => r && r.action === "skill");
  if (!rules.length && !hadSkill) return text; // nothing of ours to remove
  // Keep non-skill entries byte-for-byte; only our rules are freshly rendered.
  return spliceTopLevelArray(text, "permissions", { keep: (r) => !(r && r.action === "skill"), add: rules, label: "opencode.json" });
}
