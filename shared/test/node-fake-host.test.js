// The fake host enforces the real host's storage limits, so panel tests see what OpenChamber refuses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeHost } from "./fake-host.js";

test("fake host storage refuses a value over 64 KiB UTF-8 like the SDK, and keeps the old value", async () => {
  const fx = createFakeHost();
  try {
    await fx.host.storage.set("k", { a: 1 });
    const big = "é".repeat(32_768); // 65,536 bytes of UTF-8 plus quotes
    await assert.rejects(fx.host.storage.set("k", big), (e) => e.code === "HOST_REJECTED");
    assert.deepEqual(await fx.host.storage.get("k"), { a: 1 });
    await fx.host.storage.set("k", "x".repeat(65_534)); // exactly 65,536 bytes with quotes
  } finally {
    fx.cleanup();
  }
});
