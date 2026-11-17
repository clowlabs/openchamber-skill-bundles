// Pure project-directory helpers shared by Node/CLI cores and browser panels (zero I/O).

/**
 * Short label for a directory: `~/…` under `home`, else the last two segments (`…/a/b`).
 * @param {string | null | undefined} dir
 * @param {string} [home]
 * @returns {string}
 */
export function shortenDir(dir, home) {
  const d = String(dir ?? "").replace(/\/+$/, "");
  if (home) {
    const h = home.replace(/\/+$/, "");
    if (d === h) return "~";
    if (d.startsWith(h + "/")) return "~" + d.slice(h.length);
  }
  const segs = d.split("/").filter(Boolean);
  return segs.length <= 2 ? d || "/" : `…/${segs.slice(-2).join("/")}`;
}

/**
 * Case-insensitive substring match on project `name` or `directory`.
 * @template {{ name: string; directory: string }} T
 * @param {readonly T[]} projects
 * @param {string | null | undefined} query
 * @returns {T[]}
 */
export function filterProjects(projects, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [...projects];
  return projects.filter((p) => p.name.toLowerCase().includes(q) || p.directory.toLowerCase().includes(q));
}
