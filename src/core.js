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
const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
// Null-prototype copy so ids like "__proto__" / "constructor" are plain data keys.
function copyOverrides(src) {
  const out = Object.create(null);
  if (src) for (const k of Object.keys(src)) out[k] = src[k];
  return out;
}
const uniq = (arr) => [...new Set(arr)];

// ---------- bundles state ----------

export function parseBundles(text) {
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
    return { id: b.id, name: b.name || b.id, enabled: b.enabled === true, skills: uniq(skills) };
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
  return out;
}

export function serializeBundles(state) {
  const out = {
    version: 1,
    bundles: state.bundles.map((b) => ({ id: b.id, name: b.name, enabled: !!b.enabled, skills: [...b.skills] })),
    overrides: copyOverrides(state.overrides),
  };
  const pc = parseProjectCopies(state.projectCopies);
  if (pc) out.projectCopies = pc;
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

function normalizeDir(dir) {
  if (typeof dir !== "string" || !(dir.startsWith("/") || dir.startsWith("~/"))) {
    throw new Error(`Project directory must be absolute: ${JSON.stringify(dir)}`);
  }
  const d = dir.replace(/\/+$/, "") || "/";
  if (d.split("/").some((s) => s === "..")) throw new Error(`Project directory must not contain "..": ${dir}`);
  return d;
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

/** Short label for a directory: `~/…` under home, else the last two segments. */
export function shortenDir(dir, home) {
  const d = String(dir ?? "").replace(/\/+$/, "");
  if (home) {
    const h = home.replace(/\/+$/, "");
    if (d === h) return "~";
    if (d.startsWith(h + "/")) return "~" + d.slice(h.length);
  }
  const segs = d.split("/").filter(Boolean);
  return segs.length <= 2 ? d || "/" : `…/${segs.slice(-2).join("/")}`;
}

/** Case-insensitive match on name or directory. */
export function filterProjects(projects, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [...projects];
  return projects.filter((p) => p.name.toLowerCase().includes(q) || p.directory.toLowerCase().includes(q));
}

/** True when text read as UTF-8 looks like it was not text (replacement chars or NULs). */
export function looksBinary(text) {
  return text.includes("\uFFFD") || text.includes("\0");
}

export function effectiveMode(state, id) {
  const ov = hasOwn(state.overrides, id) && MODES.includes(state.overrides[id]) ? state.overrides[id] : undefined;
  let mode = ov ?? (state.bundles.some((b) => b.enabled && b.skills.includes(id)) ? "auto" : "off");
  if (mode === "called" && isBuiltin(id)) mode = "auto";
  return mode;
}

// Counts over allIds; `chars` estimates prompt size (only auto skills are advertised).
export function summary(state, allIds) {
  let auto = 0, called = 0;
  for (const id of allIds) {
    const m = effectiveMode(state, id);
    if (m === "auto") auto++;
    else if (m === "called") called++;
  }
  return { on: auto + called, auto, called, chars: auto * CHARS_PER_SKILL };
}

export function groups(state, allIds) {
  const inAny = new Set(state.bundles.flatMap((b) => b.skills));
  const unbundled = uniq(allIds.filter((id) => !inAny.has(id))).sort();
  return [
    ...state.bundles.map((b) => ({ id: b.id, name: b.name, enabled: b.enabled, skills: [...b.skills] })),
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
  return { ...mapBundle(state, bundleId, (x) => ({ ...x, enabled: !!on })), overrides };
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

export function applyPermissions(opencodeText, state, allIds) {
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
  const kept = existing.filter((r) => !(r && r.action === "skill"));
  const ids = uniq([...allIds, ...BUILTIN_SKILLS]).sort();
  const allows = ids
    .filter((id) => effectiveMode(state, id) !== "off")
    .map((id) => ({ action: "skill", resource: id, effect: "allow" }));
  const permissions = [...kept, { action: "skill", resource: "*", effect: "deny" }, ...allows];
  return replaceTopLevelValue(opencodeText, "permissions", permissions);
}

// Textual edit: replace (or append) one top-level key's value, leaving every other byte intact.
function replaceTopLevelValue(text, key, value) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const skipString = () => {
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
  };
  const skipValue = () => {
    ws();
    const c = text[i];
    if (c === '"') return skipString();
    if (c === "{" || c === "[") {
      let depth = 0;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '"') { skipString(); continue; }
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") { depth--; if (depth === 0) { i++; return; } }
        i++;
      }
      return;
    }
    while (i < text.length && !/[,}\]\s]/.test(text[i])) i++;
  };
  const lineIndent = (pos) => {
    const start = text.lastIndexOf("\n", pos - 1) + 1;
    return /^[ \t]*/.exec(text.slice(start))[0];
  };
  const render = (indent) => JSON.stringify(value, null, 2).split("\n").join(eol + indent);

  ws();
  i++; // {
  let lastValueEnd = -1;
  let keyIndent = null;
  let hit = null;
  const seen = new Set();
  for (;;) {
    ws();
    if (text[i] === "}") break;
    const keyStart = i;
    skipString();
    const k = JSON.parse(text.slice(keyStart, i));
    if (seen.has(k)) throw new Error(`opencode.json: duplicate top-level key ${JSON.stringify(k)}; fix it by hand`);
    seen.add(k);
    if (keyIndent === null) keyIndent = lineIndent(keyStart);
    ws();
    i++; // :
    ws();
    const vStart = i;
    skipValue();
    if (k === key) hit = { keyStart, vStart, vEnd: i };
    lastValueEnd = i;
    ws();
    if (text[i] === ",") i++;
  }
  if (hit) return text.slice(0, hit.vStart) + render(lineIndent(hit.keyStart)) + text.slice(hit.vEnd);
  const close = i;
  const indent = keyIndent ?? "  ";
  const entry = `${JSON.stringify(key)}: ${render(indent)}`;
  if (lastValueEnd < 0) {
    const out = `${text.slice(0, close).replace(/\s*$/, "")}${eol}${indent}${entry}${eol}${text.slice(close)}`;
    return out.endsWith("\n") ? out : out + eol;
  }
  return `${text.slice(0, lastValueEnd)},${eol}${indent}${entry}${text.slice(lastValueEnd)}`;
}

// ---------- SKILL.md frontmatter ----------

function splitDoc(md) {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.split(/\r?\n/);
  if (lines[0]?.replace(/^\uFEFF/, "").trimEnd() !== "---") return { eol, lines, end: -1 };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") return { eol, lines, end: i };
  }
  return { eol, lines, end: -1 };
}

const DMI_RE = /^disable-model-invocation\s*:\s*(.*?)\s*$/;
const AUTO_KEY_RE = /^opencode\/autoinvoke\s*:\s*(.*?)\s*$/;

function stripComment(v) {
  return v.replace(/\s+#.*$/, "");
}

function yamlScalar(v) {
  v = v.trim();
  if (v.startsWith('"')) {
    const q = /^"((?:[^"\\]|\\.)*)"/.exec(v);
    const body = q ? q[1] : v.slice(1);
    try { return JSON.parse(`"${body}"`); } catch { return body.replace(/\\(.)/g, "$1"); }
  }
  if (v.startsWith("'")) {
    const q = /^'((?:[^']|'')*)'/.exec(v);
    return (q ? q[1] : v.slice(1)).replace(/''/g, "'");
  }
  return stripComment(v).trim();
}

const isFalse = (v) => /^(false|no|off)$/i.test(stripComment(v).replace(/^["']|["']$/g, "").trim());
const isTrue = (v) => /^(true|yes|on)$/i.test(stripComment(v).replace(/^["']|["']$/g, "").trim());

const indentOf = (l) => /^[ \t]*/.exec(l)[0];
const isBlank = (l) => l.trim() === "";
const isComment = (l) => /^\s*#/.test(l);
const isContent = (l) => !isBlank(l) && !isComment(l);

// Indentation-aware view of the frontmatter between lines[1] and lines[end-1].
// `error` is set for layouts we refuse to edit (writers throw it; readers stay lenient).
function analyze(lines, end) {
  const info = { error: null, desc: null, meta: null, flowMeta: null, dmi: null };
  const fail = (msg) => { if (!info.error) info.error = msg; };
  const rootKeys = new Map();
  const RESERVED = ["metadata", "description", "opencode/autoinvoke", "disable-model-invocation"];
  // Conservative: any quoted key with a backslash, or one that spells a reserved name, is refused.
  const checkQuoted = (key, i) => {
    if (!/^["']/.test(key)) return;
    const q = /^(["'])(.*)\1$/.exec(key);
    if (!q || key.includes("\\")) { fail(`quoted key ${key} on line ${i + 1}`); return; }
    const plain = q[1] === "'" ? q[2].replace(/''/g, "'") : q[2];
    if (RESERVED.includes(plain)) fail(`quoted key ${key} on line ${i + 1}`);
  };
  checkScalars(lines, end, fail);
  // Compact sequence items ("- x" at column 0) are valid only under a valueless root key.
  const compact = new Set();
  let seqOk = false;
  for (let i = 1; i < end; i++) {
    const l = lines[i];
    if (!isContent(l)) continue;
    const ind = indentOf(l);
    if (ind.includes("\t")) { fail(`tab indentation on line ${i + 1}`); continue; }
    if (ind.length > 0) continue; // belongs to the preceding root key
    if (/^-(\s|$)/.test(l)) {
      if (seqOk) compact.add(i);
      else fail(`top-level list on line ${i + 1}`);
      continue;
    }
    const m = /^([^\s:#][^:]*?)\s*:(\s|$)/.exec(l);
    if (!m) { fail(`unrecognised line ${i + 1}`); seqOk = false; continue; }
    seqOk = /^\s*(#.*)?$/.test(l.slice(m[0].length));
    const key = m[1];
    checkQuoted(key, i);
    if (rootKeys.has(key)) fail(`duplicate top-level key "${key}"`);
    rootKeys.set(key, i);
  }
  // first content line must be at column 0, otherwise root keys are uniformly indented
  const first = lines.slice(1, end).find(isContent);
  if (first && indentOf(first).length > 0) fail("frontmatter keys are indented");

  const blockEnd = (start) => {
    let stop = start + 1;
    while (stop < end && (!isContent(lines[stop]) || indentOf(lines[stop]).length > 0 || compact.has(stop))) stop++;
    while (stop > start + 1 && !isContent(lines[stop - 1])) stop--;
    return stop;
  };

  if (rootKeys.has("description")) {
    const i = rootKeys.get("description");
    info.desc = { start: i, stop: blockEnd(i) };
  }
  if (rootKeys.has("disable-model-invocation")) info.dmi = rootKeys.get("disable-model-invocation");
  if (rootKeys.has("metadata")) {
    const start = rootKeys.get("metadata");
    const rest = /^metadata\s*:(.*)$/.exec(lines[start])[1].trim();
    if (rest && !rest.startsWith("#")) {
      info.flowMeta = { start, text: rest };
      fail(rest.startsWith("{") ? "flow-style `metadata: {...}` is not supported" : "`metadata:` is not a mapping");
    } else {
      const stop = blockEnd(start);
      const children = [];
      let childIndent = null;
      const seen = new Set();
      for (let j = start + 1; j < stop; j++) {
        const l = lines[j];
        if (!isContent(l)) continue;
        if (compact.has(j)) { fail("`metadata:` is a list, not a mapping"); continue; }
        const ind = indentOf(l).length;
        if (childIndent === null) childIndent = ind;
        if (ind < childIndent) { fail(`inconsistent indentation under metadata on line ${j + 1}`); continue; }
        if (ind > childIndent) continue;
        const key = /^\s*([^\s:#][^:]*?)\s*:(\s|$)/.exec(l)?.[1];
        if (!key) { fail(`unrecognised metadata line ${j + 1}`); continue; }
        checkQuoted(key, j);
        if (seen.has(key)) fail(`duplicate metadata key "${key}"`);
        seen.add(key);
        children.push({ line: j, key });
      }
      info.meta = { start, stop, childIndent: childIndent ?? 2, children };
    }
  }
  return info;
}

// Value part of a frontmatter line: after indentation, "- " markers and an optional `key:`.
function valueOf(line) {
  let v = line.replace(/^\s*/, "");
  while (/^-(\s|$)/.test(v)) v = v.slice(1).replace(/^\s*/, "");
  if (/^["']/.test(v)) {
    // quoted key followed by ":"?
    const k = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(\s|$)/.exec(v);
    if (k) return v.slice(k[0].length).trim();
    return v;
  }
  const k = /^[^\s#][^:]*?:(\s|$)/.exec(v);
  return k ? v.slice(k[0].length).trim() : v;
}

function quoteClosed(v) {
  if (v.startsWith('"')) return /^"(?:[^"\\]|\\.)*"\s*(#.*)?$/.test(v);
  if (v.startsWith("'")) return /^'(?:[^']|'')*'\s*(#.*)?$/.test(v);
  return true;
}

// Multi-line quoted scalars and backslash line endings are refused outright.
// Block-scalar (| / >) bodies are opaque text and are skipped.
function checkScalars(lines, end, fail) {
  let blockIndent = -1;
  for (let i = 1; i < end; i++) {
    const l = lines[i];
    if (!isContent(l) && !(blockIndent >= 0 && isComment(l))) {
      if (blockIndent < 0 && /\\\s*$/.test(l)) fail(`line ${i + 1} ends with a backslash`);
      continue;
    }
    const ind = indentOf(l).length;
    if (blockIndent >= 0) {
      if (ind > blockIndent || l.trim() === "") continue;
      blockIndent = -1;
    }
    if (/\\\s*$/.test(l)) { fail(`line ${i + 1} ends with a backslash`); continue; }
    const v = valueOf(l);
    if (/^[|>][-+0-9]*\s*(#.*)?$/.test(v)) { blockIndent = ind; continue; }
    if (/^["']/.test(v) && !quoteClosed(v)) fail(`multi-line quoted scalar on line ${i + 1}`);
    const key = l.replace(/^\s*(-\s+)*/, "");
    if (/^["']/.test(key) && !/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(\s|$)/.test(key) && !quoteClosed(key)) {
      fail(`unterminated quoted key on line ${i + 1}`);
    }
  }
}

function autoLine(lines, info) {
  const c = info.meta?.children.find((x) => x.key === "opencode/autoinvoke");
  return c ? c.line : -1;
}

function requireSupported(info) {
  if (info.error) throw new Error(`SKILL.md frontmatter layout not supported (${info.error}); edit it by hand`);
}

// opencode/autoinvoke wins; otherwise disable-model-invocation: true means false.
function readAutoinvoke(lines, info) {
  const al = autoLine(lines, info);
  if (al >= 0) return !isFalse(AUTO_KEY_RE.exec(lines[al].trim())[1]);
  const dmi = info.dmi !== null ? DMI_RE.exec(lines[info.dmi])?.[1] ?? null : null;
  return !(dmi !== null && isTrue(dmi));
}

export function readFrontmatter(skillMd) {
  const { lines, end } = splitDoc(skillMd);
  if (end < 0) return { description: "", autoinvoke: true, hasFrontmatter: false };
  const info = analyze(lines, end);
  requireSupported(info);
  let description = "";
  if (info.desc) {
    const { start, stop } = info.desc;
    const v = /^description\s*:(.*)$/.exec(lines[start])[1].trim();
    const cont = lines.slice(start + 1, stop).filter((l) => !isComment(l));
    if (/^[>|][-+0-9]*$/.test(v)) {
      const parts = cont.map((l) => l.trim());
      description = v.startsWith(">") ? parts.join(" ").replace(/\s+/g, " ").trim() : parts.join("\n").trim();
    } else if (cont.some(isContent)) {
      const joined = [v, ...cont.map((l) => l.trim())].filter(Boolean).join(" ");
      description = yamlScalar(joined);
    } else description = yamlScalar(v);
  }
  return { description, autoinvoke: readAutoinvoke(lines, info), hasFrontmatter: true };
}

export function setAutoinvoke(skillMd, on) {
  const { eol, lines, end } = splitDoc(skillMd);
  if (end < 0) {
    if (on) return skillMd;
    const body = skillMd.replace(/^\uFEFF/, "");
    return ["---", "metadata:", "  opencode/autoinvoke: false", "---", ""].join(eol) + body;
  }
  const info = analyze(lines, end);
  requireSupported(info);
  const al = autoLine(lines, info);
  if (on) {
    const out = lines.map((l, i) => {
      // disable-model-invocation: true would still block auto-invocation; flip it in place.
      if (i === info.dmi && isTrue(DMI_RE.exec(l)[1])) return l.replace(/:\s*.*$/, ": false");
      return l;
    });
    if (al >= 0) out.splice(al, 1);
    return out.join(eol);
  }
  if (!readAutoinvoke(lines, info)) return skillMd;
  const out = [...lines];
  if (al >= 0) {
    out[al] = out[al].replace(/:\s*.*$/, ": false");
  } else if (info.meta) {
    out.splice(info.meta.start + 1, 0, `${" ".repeat(info.meta.childIndent)}opencode/autoinvoke: false`);
  } else {
    out.splice(end, 0, "metadata:", "  opencode/autoinvoke: false");
  }
  return out.join(eol);
}

function yamlQuote(text) {
  const needs =
    text === "" ||
    /: /.test(text) || /:$/.test(text) || /#/.test(text) || /["']/.test(text) ||
    /^[-?:,[\]{}&*!|>%@`\s]/.test(text) || /\s$/.test(text) ||
    /^(true|false|yes|no|on|off|null|~|[-+]?\d[\d._]*(e[-+]?\d+)?)$/i.test(text);
  return needs ? JSON.stringify(text) : text;
}

export function setDescription(skillMd, text) {
  const single = String(text ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
  const line = `description: ${yamlQuote(single)}`;
  const { eol, lines, end } = splitDoc(skillMd);
  if (end < 0) {
    return ["---", line, "---", ""].join(eol) + skillMd.replace(/^\uFEFF/, "");
  }
  const info = analyze(lines, end);
  requireSupported(info);
  const out = [...lines];
  if (!info.desc) {
    const nameIdx = lines.findIndex((l, i) => i > 0 && i < end && /^name\s*:/.test(l));
    out.splice(nameIdx >= 0 ? nameIdx + 1 : end, 0, line);
    return out.join(eol);
  }
  // replaces the key line plus every continuation line (block scalar, quoted or plain multi-line)
  const { start, stop } = info.desc;
  out.splice(start, stop - start, line);
  return out.join(eol);
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

export function syncPlan(state, allIds, skillMds) {
  const skillEdits = [];
  const skipped = [];
  for (const id of uniq(allIds)) {
    if (isBuiltin(id)) continue;
    const text = hasOwn(skillMds, id) ? skillMds[id] : undefined;
    if (typeof text !== "string") continue;
    const mode = effectiveMode(state, id);
    if (mode === "off") continue;
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
  return { opencode: (text) => applyPermissions(text, state, allIds), skillEdits, skipped };
}

// ---------- save planner (shared by CLI and panel) ----------

/** Publication order for every adapter: SKILL.md files, then opencode.json, then skill-bundles.json. */
export const PUBLISH_ORDER = ["skill", "opencode", "bundles"];

const tag = (e, file, id) => Object.assign(e instanceof Error ? e : new Error(String(e)), { file, ...(id ? { id } : {}) });

/**
 * Pure: everything that must be written to move from `prev` (texts as read) to `next`.
 * prev.bundlesText null = file absent (seeding). Errors carry `.file` ("opencode" | "skill").
 */
export function planChange(prev, next, allIds) {
  if (typeof prev?.opencodeText !== "string") throw tag(new Error("opencode.json not found"), "opencode");
  const mds = prev.skillMds ?? Object.create(null);
  let plan;
  try {
    plan = syncPlan(next, allIds, mds);
  } catch (e) {
    throw tag(e, "skill");
  }
  let opencodeAfter;
  try {
    opencodeAfter = plan.opencode(prev.opencodeText);
  } catch (e) {
    throw tag(e, "opencode");
  }
  const writes = [];
  for (const { id, next: after } of [...plan.skillEdits].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const before = hasOwn(mds, id) ? mds[id] : undefined;
    if (before !== undefined && after !== before) writes.push({ kind: "skill", id, path: `${SKILLS_DIR}/${id}/SKILL.md`, before, after });
  }
  if (opencodeAfter !== prev.opencodeText) {
    writes.push({ kind: "opencode", path: OPENCODE_PATH, before: prev.opencodeText, after: opencodeAfter });
  }
  const bundlesAfter = serializeBundles(next);
  const bundlesBefore = prev.bundlesText ?? null;
  if (bundlesAfter !== bundlesBefore) writes.push({ kind: "bundles", path: BUNDLES_PATH, before: bundlesBefore, after: bundlesAfter });
  return { writes, skipped: plan.skipped, order: [...PUBLISH_ORDER] };
}

// ---------- writer lock protocol (shared by CLI and panel; I/O stays in the adapters) ----------

export const LOCK_PATH = "~/.config/opencode/.skill-bundles.lock";
/** A panel lock is held for at most this long after its time (or mtime, whichever is later). */
export const PANEL_LOCK_TTL_MS = 60_000;
/** An unparseable lock, or one from another host, is reclaimable once its mtime is this old. */
export const LOCK_UNPARSEABLE_STALE_MS = 10 * 60_000;
/** What the panel writes to release (it cannot delete). Counts as free. */
export const RELEASED_MARKER = '{"owner":"panel","released":true,"time":0}';

/** The exact text the panel writes to take the lock. */
export function panelLockRecord(token, now) {
  return JSON.stringify({ owner: "panel", host: "panel", pid: 0, token, time: now });
}

/** Lock file text → { kind: "cli" | "panel" | "released" | "invalid", ... }. */
export function parseLock(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { kind: "invalid" };
  const time = Number.isFinite(v.time) ? v.time : null;
  const token = typeof v.token === "string" ? v.token : null;
  if (v.owner === "panel" && v.released === true) return { kind: "released" };
  if (v.owner === "panel") return { kind: "panel", token, time, host: typeof v.host === "string" ? v.host : null };
  if (Number.isInteger(v.pid) && v.pid > 0 && typeof v.host === "string" && v.host) {
    return { kind: "cli", pid: v.pid, host: v.host, token, time };
  }
  return { kind: "invalid" };
}

/**
 * parsed lock (null = no lock file) → "free" | "held" | "stale". "stale" may be reclaimed.
 * opts: now and mtimeMs in ms; host = this machine; pidAlive(pid) probes a local pid.
 * A CLI lock is judged by its pid only when it is from `host` and pidAlive is given; otherwise
 * by the 10-minute mtime rule, like an unparseable lock.
 */
export function classifyLock(info, { now, mtimeMs, pidAlive, host } = {}) {
  if (!info || info.kind === "released") return "free";
  const age = (t) => (Number.isFinite(t) ? now - t : Infinity);
  if (info.kind === "panel") {
    const t = info.time !== null && Number.isFinite(info.time) ? Math.max(info.time, mtimeMs ?? -Infinity) : mtimeMs;
    return age(t) > PANEL_LOCK_TTL_MS ? "stale" : "held";
  }
  if (info.kind === "cli" && host && info.host === host && typeof pidAlive === "function") {
    return pidAlive(info.pid) ? "held" : "stale";
  }
  return age(mtimeMs) > LOCK_UNPARSEABLE_STALE_MS ? "stale" : "held";
}
