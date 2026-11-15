/**
 * @module shared/core/json-splice
 * Byte-preserving edits of one top-level key in a JSON object document. Every byte outside the
 * edited value stays as it was (escapes, spacing, key order). Duplicate top-level keys, including
 * escaped spellings such as "a\u0062", are refused because JSON.parse would keep only the last one.
 * Pure, no I/O; runs in browser and Node.
 */

/**
 * Scans the top level of a JSON object text. Returns its keys with their source offsets.
 * @param {string} text JSON object text (assumed valid; validate with JSON.parse first)
 * @param {{label?: string}} [opts] label prefixes the duplicate-key error ("<label>: duplicate …")
 * @returns {{keys: {key: string, keyStart: number, vStart: number, vEnd: number}[], close: number, keyIndent: string|null}}
 */
export function scanTopLevel(text, { label = "JSON" } = {}) {
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
  ws();
  i++; // {
  const keys = [];
  const seen = new Set();
  let keyIndent = null;
  for (;;) {
    ws();
    if (text[i] === "}" || i >= text.length) break;
    const keyStart = i;
    skipString();
    const key = JSON.parse(text.slice(keyStart, i));
    if (seen.has(key)) throw new Error(`${label}: duplicate top-level key ${JSON.stringify(key)}; fix it by hand`);
    seen.add(key);
    if (keyIndent === null) keyIndent = lineIndent(text, keyStart);
    ws();
    i++; // :
    ws();
    const vStart = i;
    skipValue();
    keys.push({ key, keyStart, vStart, vEnd: i });
    ws();
    if (text[i] === ",") i++;
  }
  return { keys, close: i, keyIndent };
}

/** First duplicate top-level key, or null. */
export function findDuplicateTopLevelKey(text) {
  try {
    scanTopLevel(text, { label: "\0" });
    return null;
  } catch (e) {
    const m = /^\0: duplicate top-level key (.*); fix it by hand$/.exec(e.message);
    if (m) return JSON.parse(m[1]);
    throw e;
  }
}

function lineIndent(text, pos) {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))[0];
}

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

/**
 * Replaces (or appends) the value of top-level `key`; every other byte is kept.
 * New values are rendered with 2-space JSON indented to the key's column, in the file's line ending.
 * @param {string} text
 * @param {string} key
 * @param {unknown} value
 * @param {{label?: string, renderExisting?: (oldValueText: string, indent: string, eol: string) => string|null}} [opts]
 *   renderExisting may return replacement text for an existing value (null = default render)
 */
export function replaceTopLevelValue(text, key, value, { label, renderExisting } = {}) {
  const eol = eolOf(text);
  const { keys, close, keyIndent } = scanTopLevel(text, { label });
  const render = (indent) => JSON.stringify(value, null, 2).split("\n").join(eol + indent);
  const hit = keys.find((k) => k.key === key);
  if (hit) {
    const indent = lineIndent(text, hit.keyStart);
    const raw = renderExisting?.(text.slice(hit.vStart, hit.vEnd), indent, eol);
    return text.slice(0, hit.vStart) + (raw ?? render(indent)) + text.slice(hit.vEnd);
  }
  const indent = keyIndent ?? "  ";
  const entry = `${JSON.stringify(key)}: ${render(indent)}`;
  if (!keys.length) {
    const out = `${text.slice(0, close).replace(/\s*$/, "")}${eol}${indent}${entry}${eol}${text.slice(close)}`;
    return out.endsWith("\n") ? out : out + eol;
  }
  const lastEnd = keys[keys.length - 1].vEnd;
  return `${text.slice(0, lastEnd)},${eol}${indent}${entry}${text.slice(lastEnd)}`;
}

/**
 * Raw source text of each element of a JSON array literal, or null if it can't be split safely.
 * @param {string} arr
 * @returns {string[]|null}
 */
export function arrayElementSpans(arr) {
  let i = 0;
  const out = [];
  const ws = () => { while (i < arr.length && /\s/.test(arr[i])) i++; };
  ws();
  if (arr[i] !== "[") return null;
  i++;
  for (;;) {
    ws();
    if (arr[i] === "]") return out;
    const start = i;
    let depth = 0;
    while (i < arr.length) {
      const c = arr[i];
      if (c === '"') {
        i++;
        while (i < arr.length && arr[i] !== '"') i += arr[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
      i++;
    }
    if (i >= arr.length) return null;
    out.push(arr.slice(start, i).trimEnd());
    if (arr[i] === ",") i++;
  }
}

/**
 * Rewrites top-level array `key` as [...entries where keep(entry), ...add].
 * The caller has validated that `text` is a JSON object whose `key`, if present, is an array.
 * With preserveRaw (default true), kept entries keep their exact source text; only `add` is
 * rendered. preserveRaw false re-renders the whole array.
 * @param {string} text
 * @param {string} key
 * @param {{keep: (entry: any) => boolean, add?: unknown[], preserveRaw?: boolean, label?: string}} opts
 */
export function spliceTopLevelArray(text, key, { keep, add = [], preserveRaw = true, label } = {}) {
  const cfg = JSON.parse(text);
  const existing = Array.isArray(cfg?.[key]) && Object.prototype.hasOwnProperty.call(cfg, key) ? cfg[key] : [];
  const kept = existing.filter((e) => keep(e));
  const renderExisting = preserveRaw
    ? (arrText, indent, eol) => {
        const spans = arrayElementSpans(arrText);
        if (!spans || spans.length !== existing.length) return null;
        const items = spans.filter((_, i) => keep(existing[i]));
        const inner = indent + "  ";
        const ours = add.map((r) => JSON.stringify(r, null, 2).split("\n").join(eol + inner));
        const all = [...items, ...ours];
        return all.length ? `[${eol}${all.map((x) => inner + x).join("," + eol)}${eol}${indent}]` : "[]";
      }
    : undefined;
  return replaceTopLevelValue(text, key, [...kept, ...add], { label, renderExisting });
}
