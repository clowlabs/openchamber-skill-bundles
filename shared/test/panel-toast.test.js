// bun test shared/test/panel-toast.test.js
import { expect, test } from "bun:test";
import { capText, fitList, fitToast, TOAST_COPY_MAX, TOAST_MESSAGE_MAX } from "../panel/toast.ts";

test("fitList shows what fits, then 'and N more'", () => {
  expect(fitList("Skipped: ", ["a", "b"])).toBe("Skipped: a, b");
  const ids = Array.from({ length: 200 }, (_, i) => `item-number-${i}`);
  const msg = fitList("Skipped 200: ", ids);
  expect(msg.length).toBeLessThanOrEqual(480);
  expect(msg).toMatch(/ and \d+ more$/);
  expect(fitList("x".repeat(479), ["long-id"])).toBe(`${"x".repeat(479)}1 more`);
});

test("capText and fitToast respect the host limits", () => {
  expect(capText("short")).toBe("short");
  const big = "y".repeat(TOAST_COPY_MAX + 10);
  const c = capText(big);
  expect(c.length).toBeLessThanOrEqual(TOAST_COPY_MAX);
  expect(c.endsWith("\n…")).toBe(true);
  const m = fitToast("z".repeat(TOAST_MESSAGE_MAX + 50));
  expect(m.length).toBe(TOAST_MESSAGE_MAX);
  expect(m.endsWith("…")).toBe(true);
  expect(fitToast("ok")).toBe("ok");
});
