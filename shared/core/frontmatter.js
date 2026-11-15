/**
 * @module shared/core/frontmatter
 * Conservative, surgical editing of YAML frontmatter (`---` … `---` at the top of a Markdown file).
 * Never re-serializes YAML: reads and edits single lines and key blocks, keeps every other byte
 * (CRLF, comments, nested maps). Layouts it can't edit safely are reported in `info.error`; call
 * requireSupported() before trusting or writing. Supported: block maps at column 0, one level of
 * child maps for the names in `opts.maps`, compact `- x` lists under a valueless key, plain,
 * single-line quoted and block (| >) scalars. Refused: tabs, indented roots, flow maps for `maps`,
 * multi-line quoted scalars, trailing backslashes, duplicate keys, quoted spellings of `reserved`
 * names, quoted keys with backslashes.
 * Pure, no I/O; runs in browser and Node.
 */

/**
 * @typedef {{reserved?: string[], maps?: string[]}} AnalyzeOptions
 *   reserved: key names whose quoted spelling is refused; maps: root keys parsed as child maps
 * @typedef {{start: number, stop: number}} Block  line range [start, stop) of a root key incl. continuation
 * @typedef {{start: number, stop: number, childIndent: number, children: {line: number, key: string}[]}} MapBlock
 * @typedef {{error: string|null, roots: Map<string, Block>, maps: Record<string, MapBlock>, flow: Record<string, string>}} Info
 * @typedef {{eol: string, lines: string[], end: number, info: Info|null}} Frontmatter  end = index of closing `---`, -1 if none
 */

/** Splits a document into lines; `end` is the closing `---` line index, or -1 without frontmatter. */
export function splitDoc(md) {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.split(/\r?\n/);
  if (lines[0]?.replace(/^\uFEFF/, "").trimEnd() !== "---") return { eol, lines, end: -1 };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") return { eol, lines, end: i };
  }
  return { eol, lines, end: -1 };
}

/** Drops a trailing ` # comment`. */
export function stripComment(v) {
  return v.replace(/\s+#.*$/, "");
}

/** Value of a single-line YAML scalar: unquotes "…" (JSON escapes) and '…' (''), else strips comments. */
export function yamlScalar(v) {
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

/** Single-line YAML spelling of `text`, double-quoted (JSON) when plain would be misread. */
export function yamlQuote(text) {
  const needs =
    text === "" ||
    /: /.test(text) || /:$/.test(text) || /#/.test(text) || /["']/.test(text) ||
    /^[-?:,[\]{}&*!|>%@`\s]/.test(text) || /\s$/.test(text) ||
    /^(true|false|yes|no|on|off|null|~|[-+]?\d[\d._]*(e[-+]?\d+)?)$/i.test(text);
  return needs ? JSON.stringify(text) : text;
}

export const indentOf = (l) => /^[ \t]*/.exec(l)[0];
const isBlank = (l) => l.trim() === "";
export const isComment = (l) => /^\s*#/.test(l);
export const isContent = (l) => !isBlank(l) && !isComment(l);

/** Value part of a line: after indentation, `- ` markers and an optional (possibly quoted) `key:`. */
export function valueOf(line) {
  let v = line.replace(/^\s*/, "");
  while (/^-(\s|$)/.test(v)) v = v.slice(1).replace(/^\s*/, "");
  if (/^["']/.test(v)) {
    const k = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(\s|$)/.exec(v);
    if (k) return v.slice(k[0].length).trim();
    return v;
  }
  const k = /^[^\s#][^:]*?:(\s|$)/.exec(v);
  return k ? v.slice(k[0].length).trim() : v;
}

/** True unless `v` opens a quote it does not close on the same line. */
export function quoteClosed(v) {
  if (v.startsWith('"')) return /^"(?:[^"\\]|\\.)*"\s*(#.*)?$/.test(v);
  if (v.startsWith("'")) return /^'(?:[^']|'')*'\s*(#.*)?$/.test(v);
  return true;
}

/**
 * Refuses multi-line quoted scalars, unterminated quoted keys and backslash line endings.
 * Block-scalar (| >) bodies are opaque and skipped. Calls fail(msg) for each problem.
 */
export function checkScalars(lines, end, fail) {
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

/**
 * Indentation-aware view of lines[1 .. end-1]. Never throws; problems go to `info.error` (first one).
 * @param {string[]} lines
 * @param {number} end
 * @param {AnalyzeOptions} [opts]
 * @returns {Info}
 */
export function analyze(lines, end, { reserved = [], maps = [] } = {}) {
  const info = { error: null, roots: new Map(), maps: Object.create(null), flow: Object.create(null) };
  const fail = (msg) => { if (!info.error) info.error = msg; };
  const checkQuoted = (key, i) => {
    if (!/^["']/.test(key)) return;
    const q = /^(["'])(.*)\1$/.exec(key);
    if (!q || key.includes("\\")) { fail(`quoted key ${key} on line ${i + 1}`); return; }
    const plain = q[1] === "'" ? q[2].replace(/''/g, "'") : q[2];
    if (reserved.includes(plain)) fail(`quoted key ${key} on line ${i + 1}`);
  };
  checkScalars(lines, end, fail);
  const rootKeys = new Map();
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
  const first = lines.slice(1, end).find(isContent);
  if (first && indentOf(first).length > 0) fail("frontmatter keys are indented");

  const blockEnd = (start) => {
    let stop = start + 1;
    while (stop < end && (!isContent(lines[stop]) || indentOf(lines[stop]).length > 0 || compact.has(stop))) stop++;
    while (stop > start + 1 && !isContent(lines[stop - 1])) stop--;
    return stop;
  };
  for (const [key, start] of rootKeys) info.roots.set(key, { start, stop: blockEnd(start) });

  for (const name of maps) {
    if (!rootKeys.has(name)) continue;
    const start = rootKeys.get(name);
    const rest = lines[start].slice(lines[start].indexOf(":") + 1).trim();
    if (rest && !rest.startsWith("#")) {
      info.flow[name] = rest;
      fail(rest.startsWith("{") ? `flow-style \`${name}: {...}\` is not supported` : `\`${name}:\` is not a mapping`);
      continue;
    }
    const stop = blockEnd(start);
    const children = [];
    let childIndent = null;
    const seen = new Set();
    for (let j = start + 1; j < stop; j++) {
      const l = lines[j];
      if (!isContent(l)) continue;
      if (compact.has(j)) { fail(`\`${name}:\` is a list, not a mapping`); continue; }
      const ind = indentOf(l).length;
      if (childIndent === null) childIndent = ind;
      if (ind < childIndent) { fail(`inconsistent indentation under ${name} on line ${j + 1}`); continue; }
      if (ind > childIndent) continue;
      const key = /^\s*([^\s:#][^:]*?)\s*:(\s|$)/.exec(l)?.[1];
      if (!key) { fail(`unrecognised ${name} line ${j + 1}`); continue; }
      checkQuoted(key, j);
      if (seen.has(key)) fail(`duplicate ${name} key "${key}"`);
      seen.add(key);
      children.push({ line: j, key });
    }
    info.maps[name] = { start, stop, childIndent: childIndent ?? 2, children };
  }
  return info;
}

/**
 * Throws when the layout is unsupported.
 * @param {Info|null} info
 * @param {string} [label] e.g. "Doc" → "Doc frontmatter layout not supported (…); edit it by hand"
 */
export function requireSupported(info, label = "document") {
  if (info?.error) throw new Error(`${label} frontmatter layout not supported (${info.error}); edit it by hand`);
}

/** splitDoc + analyze. info is null when there is no frontmatter. */
export function parseFrontmatter(text, opts) {
  const doc = splitDoc(text);
  return { ...doc, info: doc.end < 0 ? null : analyze(doc.lines, doc.end, opts) };
}

const keyLineRe = (key) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*:(.*)$`);

/**
 * Reads `key` (a root key, or a direct child of map `parent`). Does not validate; call
 * requireSupported first. Root values fold block scalars (> joins, | keeps lines) and plain or
 * single-line quoted continuations; child values are single-line.
 * @returns {{line: number, raw: string, value: string}|null} raw = text after the colon, trimmed
 */
export function readKey(fm, key, { parent } = {}) {
  if (!fm.info) return null;
  const { lines, info } = fm;
  if (parent) {
    const c = info.maps[parent]?.children.find((x) => x.key === key);
    if (!c) return null;
    const raw = keyLineRe(key).exec(lines[c.line])[1].trim();
    return { line: c.line, raw, value: yamlScalar(raw) };
  }
  const b = info.roots.get(key);
  if (!b) return null;
  const raw = keyLineRe(key).exec(lines[b.start])[1].trim();
  const cont = lines.slice(b.start + 1, b.stop).filter((l) => !isComment(l));
  let value;
  if (/^[>|][-+0-9]*$/.test(raw)) {
    const parts = cont.map((l) => l.trim());
    value = raw.startsWith(">") ? parts.join(" ").replace(/\s+/g, " ").trim() : parts.join("\n").trim();
  } else if (cont.some(isContent)) {
    value = yamlScalar([raw, ...cont.map((l) => l.trim())].filter(Boolean).join(" "));
  } else value = yamlScalar(raw);
  return { line: b.start, raw, value };
}

/**
 * Sets `key: rawValue` (rawValue is already valid YAML, e.g. from yamlQuote). Validates first.
 * - root key: replaces its whole block; if missing, inserts after root key `after` (if present)
 *   or before the closing `---`.
 * - child of `parent`: rewrites the child line; if missing, inserts it as the first child (at the
 *   map's child indent); if the map is missing, adds `parent:` + child before the closing `---`.
 * - no frontmatter: creates one holding just this key.
 * @param {string} text
 * @param {string} key
 * @param {string} rawValue
 * @param {{parent?: string, after?: string, label?: string} & AnalyzeOptions} [opts]
 */
/** `parent` is always analyzed as a child map, so edits under it can't append a duplicate mapping. */
function withParent(aopts, parent) {
  if (!parent) return aopts;
  const maps = aopts.maps ?? [];
  return maps.includes(parent) ? aopts : { ...aopts, maps: [...maps, parent] };
}

export function setKey(text, key, rawValue, { parent, after, label, ...aopts } = {}) {
  const fm = parseFrontmatter(text, withParent(aopts, parent));
  const { eol, lines, end, info } = fm;
  if (!info) {
    const body = text.replace(/^\uFEFF/, "");
    const block = parent ? [`${parent}:`, `  ${key}: ${rawValue}`] : [`${key}: ${rawValue}`];
    return ["---", ...block, "---", ""].join(eol) + body;
  }
  requireSupported(info, label);
  const out = [...lines];
  if (parent) {
    const hit = readKey(fm, key, { parent });
    const map = info.maps[parent];
    if (hit) out[hit.line] = out[hit.line].replace(/:\s*.*$/, `: ${rawValue}`);
    else if (map) out.splice(map.start + 1, 0, `${" ".repeat(map.childIndent)}${key}: ${rawValue}`);
    else out.splice(end, 0, `${parent}:`, `  ${key}: ${rawValue}`);
    return out.join(eol);
  }
  const line = `${key}: ${rawValue}`;
  const b = info.roots.get(key);
  if (b) {
    out.splice(b.start, b.stop - b.start, line);
    return out.join(eol);
  }
  const afterIdx = after ? info.roots.get(after)?.start ?? -1 : -1;
  out.splice(afterIdx >= 0 ? afterIdx + 1 : end, 0, line);
  return out.join(eol);
}

/**
 * Removes `key` (root block, or the single child line under `parent`). Validates first.
 * Returns text unchanged when the key is absent or there is no frontmatter.
 */
export function removeKey(text, key, { parent, label, ...aopts } = {}) {
  const fm = parseFrontmatter(text, withParent(aopts, parent));
  if (!fm.info) return text;
  requireSupported(fm.info, label);
  const out = [...fm.lines];
  if (parent) {
    const hit = readKey(fm, key, { parent });
    if (!hit) return text;
    out.splice(hit.line, 1);
  } else {
    const b = fm.info.roots.get(key);
    if (!b) return text;
    out.splice(b.start, b.stop - b.start);
  }
  return out.join(fm.eol);
}
