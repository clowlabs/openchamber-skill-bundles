import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterProjects, shortenDir } from "../core/projects.js";

describe("shortenDir", () => {
  it("replaces home with ~ and strips trailing slashes", () => {
    assert.equal(shortenDir("/home/u", "/home/u"), "~");
    assert.equal(shortenDir("/home/u/", "/home/u/"), "~");
    assert.equal(shortenDir("/home/u/Projects/app", "/home/u"), "~/Projects/app");
    assert.equal(shortenDir("/home/u/Projects/app/", "/home/u/"), "~/Projects/app");
  });

  it("does not treat sibling user prefixes as under home", () => {
    assert.equal(shortenDir("/home/user2/work/app", "/home/user"), "…/work/app");
    assert.equal(shortenDir("/home/user2", "/home/user"), "/home/user2");
  });

  it("keeps short paths and truncates deeper paths outside home to last two segments", () => {
    assert.equal(shortenDir(null), "/");
    assert.equal(shortenDir(undefined), "/");
    assert.equal(shortenDir(""), "/");
    assert.equal(shortenDir("/"), "/");
    assert.equal(shortenDir("///"), "/");
    assert.equal(shortenDir("/srv"), "/srv");
    assert.equal(shortenDir("/srv/app/"), "/srv/app");
    assert.equal(shortenDir("/srv/team/work/app"), "…/work/app");
    assert.equal(shortenDir("~/a"), "~/a");
    assert.equal(shortenDir("~/a/b/c"), "…/b/c");
  });
});

describe("filterProjects", () => {
  const list = [
    { id: "1", name: "Alpha Web", directory: "/home/u/projects/web" },
    { id: "2", name: "Backend", directory: "/srv/alpha-api" },
    { id: "3", name: "Docs", directory: "/home/u/docs" },
  ];

  it("returns a shallow copy when query is empty or whitespace", () => {
    for (const q of ["", "   ", null, undefined]) {
      const res = filterProjects(list, q);
      assert.deepEqual(res, list);
      assert.notEqual(res, list);
    }
  });

  it("matches case-insensitively against name or directory with trimmed query", () => {
    assert.deepEqual(
      filterProjects(list, "  ALPHA ").map((p) => p.id),
      ["1", "2"],
    );
    assert.deepEqual(
      filterProjects(list, "U/DOCS").map((p) => p.id),
      ["3"],
    );
    assert.deepEqual(filterProjects(list, "missing"), []);
  });
});
