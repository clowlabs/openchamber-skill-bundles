// bun test shared/test/panel-host.test.js
import { expect, test } from "bun:test";
import { isUnreadable } from "../panel/host.ts";

test("isUnreadable matches DENIED, BAD_PATH, and FILE_TOO_LARGE only", () => {
  for (const code of ["DENIED", "BAD_PATH", "FILE_TOO_LARGE"]) {
    expect(isUnreadable(Object.assign(new Error("fail"), { code }))).toBe(true);
  }
  expect(isUnreadable(Object.assign(new Error("missing"), { code: "NOT_FOUND" }))).toBe(false);
  expect(isUnreadable(new Error("generic"))).toBe(false);
  expect(isUnreadable(null)).toBe(false);
});
