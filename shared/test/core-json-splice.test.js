import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanTopLevel,
  findDuplicateTopLevelKey,
  replaceTopLevelValue,
  arrayElementSpans,
  spliceTopLevelArray,
} from "../core/json-splice.js";

test("scanTopLevel: keys and offsets; nested and escaped content skipped", () => {
  const t = '{ "a": 1, "b": {"x": [1, "]}"]}, "c\\"q": "v\\"," }';
  const { keys } = scanTopLevel(t);
  assert.deepEqual(keys.map((k) => k.key), ["a", "b", 'c"q']);
  assert.equal(t.slice(keys[1].vStart, keys[1].vEnd), '{"x": [1, "]}"]}');
  assert.deepEqual(scanTopLevel("{}").keys, []);
});

test("duplicate top-level keys are refused, including escaped spellings", () => {
  assert.throws(() => scanTopLevel('{"k":1,"k":2}', { label: "cfg.json" }), /^Error: cfg\.json: duplicate top-level key "k"; fix it by hand$/);
  assert.throws(() => replaceTopLevelValue('{"ab":1,"a\\u0062":2}', "x", 1), /duplicate top-level key "ab"/);
  assert.equal(findDuplicateTopLevelKey('{"a":1,"\\u0061":2}'), "a");
  assert.equal(findDuplicateTopLevelKey('{"a":{"a":1,"a":2}}'), null); // nested is fine
});

test("replaceTopLevelValue: only the value changes; insert keeps layout", () => {
  const t = '{\n  "x": "\\u00b7",\n  "k": [1],\n  "z": true\n}\n';
  assert.equal(replaceTopLevelValue(t, "k", [2, 3]), '{\n  "x": "\\u00b7",\n  "k": [\n    2,\n    3\n  ],\n  "z": true\n}\n');
  assert.equal(replaceTopLevelValue(t, "n", 1), '{\n  "x": "\\u00b7",\n  "k": [1],\n  "z": true,\n  "n": 1\n}\n');
  assert.equal(replaceTopLevelValue("{}", "n", 1), '{\n  "n": 1\n}\n');
  assert.equal(replaceTopLevelValue('{\r\n  "k": 0\r\n}\r\n', "k", { a: 1 }), '{\r\n  "k": {\r\n    "a": 1\r\n  }\r\n}\r\n');
  const custom = replaceTopLevelValue('{"k": [1]}', "k", null, { renderExisting: (old) => old.replace("1", "9") });
  assert.equal(custom, '{"k": [9]}');
  assert.equal(replaceTopLevelValue('{"k": 1}', "k", 2, { renderExisting: () => null }), '{"k": 2}');
});

test("arrayElementSpans: raw text per element; null when unsplittable", () => {
  assert.deepEqual(arrayElementSpans('[ {"a": "x,]"} , 2,"s" ,[1,[2]] ]'), ['{"a": "x,]"}', "2", '"s"', "[1,[2]]"]);
  assert.deepEqual(arrayElementSpans("[]"), []);
  assert.equal(arrayElementSpans("{}"), null);
  assert.equal(arrayElementSpans('[1, "open'), null);
});

test("spliceTopLevelArray: keeps raw spans of kept entries, appends `add`, idempotent", () => {
  const t = '{\n  "rules": [\n    {"t":"keep","v":"\\u002a"},\n    { "t": "ours", "v": 1 },\n    { "t": "keep",   "v": 2 }\n  ],\n  "other": 1\n}\n';
  const keep = (e) => e.t !== "ours";
  const out = spliceTopLevelArray(t, "rules", { keep, add: [{ t: "ours", v: 9 }] });
  assert.equal(
    out,
    '{\n  "rules": [\n    {"t":"keep","v":"\\u002a"},\n    { "t": "keep",   "v": 2 },\n    {\n      "t": "ours",\n      "v": 9\n    }\n  ],\n  "other": 1\n}\n',
  );
  assert.equal(spliceTopLevelArray(out, "rules", { keep, add: [{ t: "ours", v: 9 }] }), out);
  assert.equal(spliceTopLevelArray('{"rules":[{"t":"ours"}]}', "rules", { keep, add: [] }), '{"rules":[]}');
  // missing key: appended
  assert.deepEqual(JSON.parse(spliceTopLevelArray('{"a":1}', "rules", { keep, add: [1] })), { a: 1, rules: [1] });
  // preserveRaw false re-renders kept entries
  const flat = spliceTopLevelArray('{"rules": [ {"t":"keep"} ]}', "rules", { keep, add: [], preserveRaw: false });
  assert.equal(flat, '{"rules": [\n  {\n    "t": "keep"\n  }\n]}');
});
