import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitDoc, stripComment, yamlScalar, yamlQuote, valueOf, quoteClosed, checkScalars,
  analyze, requireSupported, parseFrontmatter, readKey, setKey, removeKey,
} from "../core/frontmatter.js";

const OPTS = { reserved: ["meta", "title"], maps: ["meta"], label: "Doc" };

test("splitDoc finds the closing --- (BOM, CRLF, none)", () => {
  assert.deepEqual(splitDoc("---\na: 1\n---\nbody").end, 2);
  assert.equal(splitDoc("\uFEFF---\r\na: 1\r\n---\r\n").eol, "\r\n");
  assert.equal(splitDoc("\uFEFF---\r\na: 1\r\n---\r\n").end, 2);
  assert.equal(splitDoc("# no fm").end, -1);
  assert.equal(splitDoc("---\nnever closed").end, -1);
});

test("scalar helpers", () => {
  assert.equal(stripComment("x # c"), "x");
  assert.equal(stripComment("a#b"), "a#b");
  assert.equal(yamlScalar('"a: \\"b\\" # c" # comment'), 'a: "b" # c');
  assert.equal(yamlScalar("'it''s'"), "it's");
  assert.equal(yamlScalar("plain # c"), "plain");
  for (const t of ["a: b", "# x", "- x", 'q"', "true", "12", "", " lead", "trail "]) {
    assert.equal(yamlScalar(yamlQuote(t)), t, t);
    assert.ok(yamlQuote(t).startsWith('"'), t);
  }
  assert.equal(yamlQuote("plain words"), "plain words");
  assert.equal(valueOf("  - key: v"), "v");
  assert.equal(valueOf('"k": v'), "v");
  assert.equal(valueOf("- item"), "item");
  assert.ok(quoteClosed('"a" # c') && quoteClosed("'it''s'") && quoteClosed("plain"));
  assert.ok(!quoteClosed('"open') && !quoteClosed("'open"));
});

test("checkScalars refuses multi-line quotes and backslash endings; block bodies are opaque", () => {
  const errs = (text) => {
    const { lines, end } = splitDoc(text);
    const out = [];
    checkScalars(lines, end, (m) => out.push(m));
    return out;
  };
  assert.match(errs('---\na: "x\n  y"\n---\n')[0], /multi-line quoted/);
  assert.match(errs("---\na: x \\\n---\n")[0], /backslash/);
  assert.match(errs('---\n"k\n---\n')[0], /unterminated quoted key|multi-line/);
  assert.deepEqual(errs("---\na: |\n  \"open\n  ends \\\nb: 1\n---\n"), []);
});

test("analyze: roots, child maps, compact lists; refusals", () => {
  const md = "---\nname: n\nmeta:\n  one: 1\n# c\n  two: 2\ntags:\n- a\n- b\ntitle: t\n  more\n---\n";
  const { lines, end } = splitDoc(md);
  const info = analyze(lines, end, OPTS);
  assert.equal(info.error, null);
  assert.deepEqual([...info.roots.keys()], ["name", "meta", "tags", "title"]);
  assert.deepEqual(info.roots.get("title"), { start: 9, stop: 11 });
  assert.deepEqual(info.roots.get("tags"), { start: 6, stop: 9 });
  assert.deepEqual(info.maps.meta.children.map((c) => c.key), ["one", "two"]);
  assert.equal(info.maps.meta.childIndent, 2);
  const err = (text, o = OPTS) => { const d = splitDoc(text); return analyze(d.lines, d.end, o).error; };
  assert.match(err("---\nmeta: {a: 1}\n---\n"), /flow-style `meta: \{\.\.\.\}`/);
  assert.match(err("---\nmeta: x\n---\n"), /not a mapping/);
  assert.match(err("---\nmeta:\n- a\n---\n"), /is a list/);
  assert.match(err("---\n  a: 1\n---\n"), /indented/);
  assert.match(err("---\na:\n\tb: 1\n---\n"), /tab/);
  assert.match(err("---\na: 1\na: 2\n---\n"), /duplicate top-level key "a"/);
  assert.match(err("---\nmeta:\n  x: 1\n  x: 2\n---\n"), /duplicate meta key "x"/);
  assert.match(err("---\nmeta:\n    a: 1\n  b: 2\n---\n"), /inconsistent indentation under meta/);
  assert.match(err("---\n- a\n---\n"), /top-level list/);
  assert.match(err('---\n"title": x\n---\n'), /quoted key/);
  assert.match(err('---\n"ti\\u0074le": x\n---\n'), /quoted key/); // backslash in quoted key
  assert.equal(err('---\n"title": x\n---\n', { reserved: [] }), null);
  assert.throws(() => requireSupported({ error: "tab" }, "Doc"), /^Error: Doc frontmatter layout not supported \(tab\); edit it by hand$/);
  assert.doesNotThrow(() => requireSupported(null));
});

test("readKey: root folding and child keys", () => {
  const fm = parseFrontmatter("---\na: >\n  one\n  two\nb: |\n  l1\n  l2\nc: x\n  y\nd: 'q'\nmeta:\n  k: \"v # w\"\n---\n", OPTS);
  assert.equal(readKey(fm, "a").value, "one two");
  assert.equal(readKey(fm, "b").value, "l1\nl2");
  assert.equal(readKey(fm, "c").value, "x y");
  assert.equal(readKey(fm, "d").value, "q");
  assert.deepEqual(readKey(fm, "k", { parent: "meta" }), { line: 11, raw: '"v # w"', value: "v # w" });
  assert.equal(readKey(fm, "missing"), null);
  assert.equal(readKey(fm, "k"), null);
  assert.equal(readKey(parseFrontmatter("no fm"), "a"), null);
});

test("setKey / removeKey: surgical, idempotent, CRLF, refusals", () => {
  const md = "---\nname: n\nmeta:\n  deep:\n    k: 1\n  other: 2\n---\nbody\n";
  const on = setKey(md, "flag", "false", { ...OPTS, parent: "meta" });
  assert.equal(on, "---\nname: n\nmeta:\n  flag: false\n  deep:\n    k: 1\n  other: 2\n---\nbody\n");
  assert.equal(setKey(on, "flag", "false", { ...OPTS, parent: "meta" }), on);
  assert.equal(removeKey(on, "flag", { ...OPTS, parent: "meta" }), md);
  assert.equal(removeKey(md, "k", { ...OPTS, parent: "meta" }), md); // nested deeper: not a child
  // missing parent map → added before closing ---
  assert.equal(setKey("---\nname: n\n---\n", "flag", "x", { ...OPTS, parent: "meta" }), "---\nname: n\nmeta:\n  flag: x\n---\n");
  // child indent respected
  assert.equal(setKey("---\nmeta:\n    a: 1\n---\n", "f", "1", { ...OPTS, parent: "meta" }), "---\nmeta:\n    f: 1\n    a: 1\n---\n");
  // root: replace whole block, insert after, or before close
  assert.equal(setKey("---\nname: n\ntitle: >\n  old\n  text\nz: 1\n---\n", "title", "new", OPTS), "---\nname: n\ntitle: new\nz: 1\n---\n");
  assert.equal(setKey("---\nname: n\nz: 1\n---\n", "title", "t", { ...OPTS, after: "name" }), "---\nname: n\ntitle: t\nz: 1\n---\n");
  assert.equal(setKey("---\nz: 1\n---\n", "title", "t", { ...OPTS, after: "name" }), "---\nz: 1\ntitle: t\n---\n");
  assert.equal(removeKey("---\na: 1\ntitle: x\n  y\nb: 2\n---\n", "title", OPTS), "---\na: 1\nb: 2\n---\n");
  // no frontmatter: created
  assert.equal(setKey("body\n", "title", "t", OPTS), "---\ntitle: t\n---\nbody\n");
  assert.equal(setKey("\uFEFFbody", "f", "1", { ...OPTS, parent: "meta" }), "---\nmeta:\n  f: 1\n---\nbody");
  assert.equal(removeKey("body", "title", OPTS), "body");
  // CRLF preserved
  assert.equal(setKey("---\r\nmeta:\r\n  a: 1\r\n---\r\n", "f", "1", { ...OPTS, parent: "meta" }), "---\r\nmeta:\r\n  f: 1\r\n  a: 1\r\n---\r\n");
  // unsupported layout throws with label
  assert.throws(() => setKey("---\nmeta: {a: 1}\n---\n", "f", "1", { ...OPTS, parent: "meta" }), /^Error: Doc frontmatter layout not supported/);
  assert.throws(() => removeKey("---\na:\n\tb\n---\n", "a", OPTS), /tab/);
});

test("setKey/removeKey with only `parent` edit the existing map (no duplicate mapping)", () => {
  const src = "---\nname: x\nsettings:\n  theme: dark\n---\nbody\n";
  const out = setKey(src, "enabled", "false", { parent: "settings" });
  assert.equal(out.match(/^settings:/gm).length, 1);
  assert.match(out, /settings:\n  enabled: false\n  theme: dark\n/);
  const back = removeKey(out, "enabled", { parent: "settings" });
  assert.equal(back, src);
});
