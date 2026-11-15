// bun test shared/test/panel-dom.test.js — popup placement and the drag controller on a tiny
// stub DOM (no DOM library in this workspace).
import { afterEach, beforeEach, expect, test } from "bun:test";

class El {
  constructor(tag, attrs = {}) {
    this.tag = tag;
    this.dataset = { ...(attrs.dataset ?? {}) };
    this.parent = null;
    this.style = {};
    this.zone = attrs.zone ?? false;
    this.rect = attrs.rect ?? { left: 0, top: 0, width: 100, height: 50 };
    this.listeners = {};
    this.captured = new Set();
    const cls = new Set();
    this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), has: (c) => cls.has(c) };
  }
  closest(sel) {
    for (let n = this; n; n = n.parent) if (sel === ".zone" && n.zone) return n;
    return null;
  }
  cloneNode() { return new El(this.tag, { dataset: this.dataset }); }
  appendChild(c) { c.parent = this; return c; }
  remove() { this.parent = null; this.removed = true; }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  addEventListener(t, f) { (this.listeners[t] ??= new Set()).add(f); }
  removeEventListener(t, f) { this.listeners[t]?.delete(f); }
}

let doc;
let under; // element "under the pointer"
beforeEach(() => {
  under = null;
  const listeners = {};
  doc = {
    body: new El("body"),
    listeners,
    addEventListener: (t, f) => (listeners[t] ??= new Set()).add(f),
    removeEventListener: (t, f) => listeners[t]?.delete(f),
    elementFromPoint: () => under,
    dispatch: (t, e) => [...(listeners[t] ?? [])].forEach((f) => f(e)),
  };
  globalThis.document = doc;
  globalThis.window = { innerWidth: 300, innerHeight: 200 };
});
afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
});

const ptr = (type, x, y, extra = {}) => ({ type, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: "mouse", altKey: false, ...extra });

test("place keeps the menu inside the viewport and flips near edges", async () => {
  const { place } = await import("../panel/popup.ts");
  const m = new El("div", { rect: { left: 0, top: 0, width: 100, height: 50 } });
  place(m, 10, 10);
  expect([m.style.left, m.style.top]).toEqual(["10px", "10px"]);
  place(m, 280, 190); // would overflow right and bottom: flips to the other side
  expect([m.style.left, m.style.top]).toEqual(["180px", "140px"]);
  place(m, 50, 30);
  expect([m.style.left, m.style.top]).toEqual(["50px", "30px"]);
});

test("drag: mouse move past 5px starts, drop on another zone calls onDrop and cleans up", async () => {
  const { createDrag } = await import("../panel/drag.ts");
  const drops = [], clicks = [];
  let ended = 0;
  const ctl = createDrag({
    zoneSelector: ".zone", zoneKey: "zone",
    canDrag: () => true,
    onDrop: (...a) => drops.push(a), onClick: (id) => clicks.push(id), onEnd: () => ended++,
  });
  const from = new El("div", { zone: true, dataset: { zone: "A" } });
  const to = new El("div", { zone: true, dataset: { zone: "B" } });
  const item = from.appendChild(new El("span"));
  ctl.onPointerDown({ ...ptr("pointerdown", 0, 0), currentTarget: item }, "x", "A");
  expect(ctl.isDragging()).toBe(true);
  under = to;
  doc.dispatch("pointermove", ptr("pointermove", 20, 0));
  expect(to.classList.has("drop")).toBe(true);
  ctl.deferRender();
  doc.dispatch("pointerup", ptr("pointerup", 20, 0, { altKey: true }));
  expect(drops).toEqual([["x", "A", "B", true]]);
  expect(clicks).toEqual([]);
  expect(ended).toBe(1);
  expect(ctl.isDragging()).toBe(false);
  expect(to.classList.has("drop")).toBe(false);
  expect(doc.listeners.pointermove.size).toBe(0); // listeners removed at end
  ctl.dispose();
});

test("drag: no movement is a click; canDrag=false never drags; other pointers are ignored", async () => {
  const { createDrag } = await import("../panel/drag.ts");
  const drops = [], clicks = [];
  const ctl = createDrag({
    zoneSelector: ".zone", zoneKey: "zone",
    canDrag: (id) => id !== "locked",
    onDrop: (...a) => drops.push(a), onClick: (id) => clicks.push(id), onEnd: () => {},
  });
  const item = new El("span");
  ctl.onPointerDown({ ...ptr("pointerdown", 0, 0), currentTarget: item }, "x", "A");
  doc.dispatch("pointerup", ptr("pointerup", 1, 1));
  ctl.onPointerDown({ ...ptr("pointerdown", 0, 0), currentTarget: item }, "locked", "A");
  under = new El("div", { zone: true, dataset: { zone: "B" } });
  doc.dispatch("pointermove", ptr("pointermove", 50, 0));
  doc.dispatch("pointerup", ptr("pointerup", 50, 0, { pointerId: 2 })); // other pointer: ignored
  expect(ctl.isDragging()).toBe(true);
  doc.dispatch("pointerup", ptr("pointerup", 50, 0));
  expect(clicks).toEqual(["x", "locked"]);
  expect(drops).toEqual([]);
  ctl.dispose();
});

test("drag: Escape cancels and removes the ghost", async () => {
  const { createDrag } = await import("../panel/drag.ts");
  const drops = [];
  const ctl = createDrag({ zoneSelector: ".zone", zoneKey: "zone", canDrag: () => true, onDrop: (...a) => drops.push(a), onClick: () => {}, onEnd: () => {} });
  const item = new El("span");
  ctl.onPointerDown({ ...ptr("pointerdown", 0, 0), currentTarget: item }, "x", "A");
  under = new El("div", { zone: true, dataset: { zone: "B" } });
  doc.dispatch("pointermove", ptr("pointermove", 30, 0));
  doc.dispatch("keydown", { key: "Escape" });
  expect(ctl.isDragging()).toBe(false);
  expect(drops).toEqual([]);
  expect(item.classList.has("dragging")).toBe(false);
  ctl.dispose();
});
