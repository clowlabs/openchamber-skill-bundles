export interface SkillRef {
  /** Path-derived id (folder name, or file name without .md). */
  id: string;
  /** Source root it was found under ("~/…" or absolute). */
  root: string;
  /** The markdown file: "<dir>/SKILL.md" or "<root>/<id>.md". */
  path: string;
  /** The skill folder, or null for a flat root-level .md file. */
  dir: string | null;
}

export interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

export const GLOBAL_SKILL_ROOTS: string[];
export const SKILL_SCAN_DEPTH: 6;
export const SKILL_FILE: "SKILL.md";
export const SKILL_SCAN_BUDGET: number;
/** Hidden entries and the folders OpenCode never searches (node_modules, .git, venv, …). */
export function skipName(name: string): boolean;
export function join(a: string, b: string): string;

export function normalizeRoot(entry: unknown): string | null;
export function configSkillRoots(opencodeText: string): string[];
export function skillRoots(opencodeText: string | null, opts?: { home?: string }): string[];
export function classifySkillDir(root: string, rel: string, entries: DirEntry[], opts?: { home?: string }): { skills: SkillRef[]; subdirs: string[] };
export function mergeSkillRefs(perRoot: SkillRef[][]): Record<string, SkillRef>;
