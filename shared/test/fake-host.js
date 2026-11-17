// A filesystem-backed fake OpenChamber host for panel tests (bun test or node:test).
//
//   const fx = createFakeHost();          // temp "home" folder
//   fx.put("~/a.txt", "hi"); fx.host.readFile("~/a.txt")
//   fx.failOn = (path, op) => op === "write" && path.endsWith(".json");
//   fx.writes  → paths written, in order;  fx.toasts → toast requests
//   fx.cleanup()
//
// Paths starting with "~/" map into the temp home; absolute paths are used as given.
// Errors are HostRequestError-shaped ({ code: "NOT_FOUND" | "DENIED", message }).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class FakeHostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "HostRequestError";
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.home] existing folder to use as home (default: a new temp folder)
 * @param {(code: string, message: string) => Error} [opts.makeError] e.g. SDK HostRequestError
 * @param {{ id: string, name: string, directory: string }[] | ((home: string) => any[])} [opts.projects]
 *   listProjects() result; default: one OpenChamber chats folder under home
 */
export function createFakeHost(opts = {}) {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "oc-fake-host-"));
  const makeError = opts.makeError ?? ((code, message) => new FakeHostError(code, message));
  const real = (p) => (p.startsWith("~/") ? path.join(home, p.slice(2)) : p === "~" ? home : p);

  const fx = {
    home,
    real,
    /** paths written, in order */
    writes: [],
    /** toast requests */
    toasts: [],
    /** (path, op: "read"|"write"|"list"|"stat") => boolean: throw DENIED */
    failOn: () => false,
    /** listProjects() result */
    projects: typeof opts.projects === "function" ? opts.projects(home)
      : opts.projects ?? [{ id: "chats", name: "chats", directory: `${home}/.config/openchamber/chats/2026-01-01/s1` }],
    projectsState: "ready",
    /** onProjects listeners */
    projectListeners: new Set(),
    /** in-memory extension storage (instance + device scopes) */
    storage: new Map(),

    put(p, text) {
      fs.mkdirSync(path.dirname(real(p)), { recursive: true });
      fs.writeFileSync(real(p), text);
    },
    read(p) {
      return fs.readFileSync(real(p), "utf8");
    },
    exists(p) {
      return fs.existsSync(real(p));
    },
    mkdir(p) {
      fs.mkdirSync(real(p), { recursive: true });
    },
    /** push a new project snapshot to onProjects listeners */
    emitProjects() {
      const snap = { kind: "projects", state: fx.projectsState, projects: fx.projects };
      for (const l of fx.projectListeners) l(snap);
    },
    cleanup() {
      if (!opts.home) fs.rmSync(home, { recursive: true, force: true });
    },

    host: {
      async readFile(p) {
        if (fx.failOn(p, "read")) throw makeError("DENIED", `refused ${p}`);
        try {
          return { content: fs.readFileSync(real(p), "utf8") };
        } catch (e) {
          if (e.code === "ENOENT") throw makeError("NOT_FOUND", p);
          throw e;
        }
      },
      async writeFile(p, content) {
        if (fx.failOn(p, "write")) throw makeError("DENIED", `refused ${p}`);
        fs.mkdirSync(path.dirname(real(p)), { recursive: true });
        fs.writeFileSync(real(p), content);
        fx.writes.push(p);
        return { written: true };
      },
      async listDir(p) {
        if (fx.failOn(p, "list")) throw makeError("DENIED", `refused ${p}`);
        let names;
        try {
          names = fs.readdirSync(real(p), { withFileTypes: true });
        } catch (e) {
          if (e.code === "ENOENT") throw makeError("NOT_FOUND", p);
          throw e;
        }
        return {
          entries: names
            .map((d) => ({ name: d.name, kind: d.isDirectory() ? "directory" : d.isFile() ? "file" : "other" }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        };
      },
      async stat(p) {
        if (fx.failOn(p, "stat")) throw makeError("DENIED", `refused ${p}`);
        try {
          const s = fs.statSync(real(p));
          return { kind: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other", size: s.size, mtime: s.mtimeMs };
        } catch {
          return { kind: "missing", size: 0, mtime: 0 };
        }
      },
      async toast(t) {
        fx.toasts.push(t);
      },
      async listProjects() {
        return { kind: "projects", state: fx.projectsState, projects: fx.projects };
      },
      async onProjects(listener) {
        fx.projectListeners.add(listener);
        return () => fx.projectListeners.delete(listener);
      },
      storage: {
        async get(key, options) {
          const k = `${options?.scope ?? "instance"}:${key}`;
          return fx.storage.has(k) ? structuredClone(fx.storage.get(k)) : undefined;
        },
        async set(key, value, options) {
          const k = `${options?.scope ?? "instance"}:${key}`;
          fx.storage.set(k, structuredClone(value));
        },
        async delete(key, options) {
          const k = `${options?.scope ?? "instance"}:${key}`;
          fx.storage.delete(k);
        },
        async keys(options) {
          const prefix = `${options?.scope ?? "instance"}:`;
          return [...fx.storage.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((k) => k.slice(prefix.length))
            .sort();
        },
      },
    },
  };
  return fx;
}
