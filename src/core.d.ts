export type Mode = "auto" | "called" | "off";

export interface Bundle {
  id: string;
  name: string;
  enabled: boolean;
  skills: string[];
  /** v0.2: normalized project dirs (absolute or "~/…"), sorted; absent when none. */
  projects?: string[];
}

export interface State {
  version: 1;
  bundles: Bundle[];
  /** Null-prototype record; read with own-property checks. */
  overrides: Record<string, Mode>;
  /** Optional { [skillId]: projectDir[] }; absent when empty. */
  projectCopies?: Record<string, string[]>;
  /** v0.2: every project dir whose file we have written skill rules into; absent when empty. */
  managedProjects?: string[];
}

export interface ProjectRef {
  name: string;
  directory: string;
}

export interface Group extends Bundle {
  synthetic?: true;
}

export interface Frontmatter {
  description: string;
  autoinvoke: boolean;
  hasFrontmatter: boolean;
}

export interface SkillEdit {
  id: string;
  next: string;
}

export interface Skipped {
  id: string;
  reason: string;
}

export interface SyncPlan {
  opencode: (text: string) => string;
  skillEdits: SkillEdit[];
  skipped: Skipped[];
}

export interface Summary {
  on: number;
  auto: number;
  called: number;
  chars: number;
}

export const BUNDLES_PATH: "~/.config/opencode/skill-bundles.json";
export const OPENCODE_PATH: "~/.config/opencode/opencode.json";
export const SKILLS_DIR: "~/.config/opencode/skills";
export const BUILTIN_SKILLS: string[];
export const UNBUNDLED_ID: "__unbundled";
export const MODES: Mode[];
export const CHARS_PER_SKILL: 180;

export function isBuiltin(id: string): boolean;
export function backupName(date?: Date): string;
export function summary(state: State, allIds: string[]): Summary;

export interface HomeOption {
  /** Absolute home dir. When given, project dirs under it are stored as "~/…". */
  home?: string;
}

/** With opts.home, stored project-dir aliases are migrated to canonical form and deduped. */
export function parseBundles(text: string, opts?: HomeOption): State;
export function serializeBundles(state: State): string;
export function effectiveMode(state: State, id: string): Mode;
export function groups(state: State, allIds: string[]): Group[];
export function setBundleEnabled(state: State, bundleId: string, on: boolean): State;
export function setOverride(state: State, id: string, mode: Mode | null): State;
export function moveSkill(
  state: State,
  id: string,
  fromBundle: string | null,
  toBundle: string | null,
  opts?: { copy?: boolean },
): State;
export function createBundle(state: State, name: string): State;
export function renameBundle(state: State, id: string, name: string): State;
export function deleteBundle(state: State, id: string): State;

export function applyPermissions(opencodeText: string, state: State, allIds: string[]): string;
export function readFrontmatter(skillMd: string): Frontmatter;
export function setAutoinvoke(skillMd: string, on: boolean): string;
export function setDescription(skillMd: string, text: string): string;
export function syncPlan(state: State, allIds: string[], skillMds: Record<string, string>): SyncPlan;

export function addProjectCopy(state: State, id: string, projectDir: string): State;
export function markMovedToProject(state: State, id: string, projectDir: string): State;
export function projectSkillDir(projectDir: string, id: string): string;
export function isChatsDir(dir: string | null | undefined): boolean;
export function shortenDir(dir: string | null | undefined, home?: string): string;
export function filterProjects<T extends ProjectRef>(projects: T[], query: string | null | undefined): T[];
export function looksBinary(text: string): boolean;

// ---------- save planner ----------

export type WriteKind = "skill" | "project" | "opencode" | "bundles";

export interface PlannedWrite {
  kind: WriteKind;
  /** Present when kind === "skill". */
  id?: string;
  /** Present when kind === "project": the normalized project dir. */
  dir?: string;
  /** SKILLS_DIR/<id>/SKILL.md, "<dir>/.opencode/opencode.json", OPENCODE_PATH or BUNDLES_PATH ("~/…" or absolute). */
  path: string;
  /** Text as read; null for a file that does not exist yet (bundles when seeding, a new project file). */
  before: string | null;
  after: string;
}

export interface PrevFiles {
  /** null when skill-bundles.json does not exist yet. */
  bundlesText: string | null;
  opencodeText: string;
  /** SKILL.md texts by skill id, as read. */
  skillMds: Record<string, string>;
}

export interface ChangePlan {
  /** Already in PUBLISH_ORDER; skills sorted by id. */
  writes: PlannedWrite[];
  skipped: Skipped[];
  order: WriteKind[];
  /** `next` with managedProjects updated to what this plan writes; the bundles write serializes it. */
  state: State;
}

/** Errors thrown by planChange carry which file they concern. */
export interface PlanError extends Error {
  file: "opencode" | "skill" | "project";
  /** Project dir when file === "project". */
  id?: string;
}

export const PUBLISH_ORDER: ["skill", "project", "opencode", "bundles"];
/**
 * projectTexts: text of "<dir>/.opencode/opencode.json" for every dir in projectTargets(next)
 * (null = missing). Required when next has any project targets.
 */
export function planChange(
  prev: PrevFiles,
  next: State,
  allIds: string[],
  projectTexts?: Record<string, string | null>,
  opts?: HomeOption,
): ChangePlan;

// ---------- writer lock protocol ----------

export type LockInfo =
  | { kind: "cli"; pid: number; host: string; token: string | null; time: number | null }
  | { kind: "panel"; token: string | null; time: number | null; host: string | null }
  | { kind: "released" }
  | { kind: "invalid" };

export type LockVerdict = "free" | "held" | "stale";

export interface ClassifyLockOptions {
  /** Current time, ms. */
  now: number;
  /** Lock file mtime, ms. */
  mtimeMs: number;
  /** Probe a local pid (CLI only). Without it, CLI locks fall back to the 10-minute rule. */
  pidAlive?: (pid: number) => boolean;
  /** This machine's hostname; a CLI lock is judged by pid only when its host matches. */
  host?: string;
}

export const LOCK_PATH: "~/.config/opencode/.skill-bundles.lock";
export const PANEL_LOCK_TTL_MS: 60000;
export const LOCK_UNPARSEABLE_STALE_MS: 600000;
export const RELEASED_MARKER: '{"owner":"panel","released":true,"time":0}';
export function panelLockRecord(token: string, now: number): string;
export function parseLock(text: string): LockInfo;
/** info null = no lock file. "free" and "stale" may both be taken over. */
export function classifyLock(info: LockInfo | null, opts: ClassifyLockOptions): LockVerdict;

// ---------- per-project bundles (v0.2) ----------

/** ".opencode/opencode.json" */
export const PROJECT_CONFIG_REL: ".opencode/opencode.json";
/**
 * Canonical spelling. Absolute or "~/…"; "." segments, repeated and trailing "/" collapsed; ".."
 * throws. With opts.home, a dir under home becomes "~/…" (home itself "~").
 */
export function normalizeProjectDir(dir: string, opts?: HomeOption): string;
/** "<dir>/.opencode/opencode.json" */
export function projectConfigPath(dir: string): string;
export function setBundleProjects(state: State, bundleId: string, dirs: string[], opts?: HomeOption): State;
export function addBundleProject(state: State, bundleId: string, dir: string, opts?: HomeOption): State;
/** Removes the dir under any spelling that canonicalizes to the same dir. */
export function removeBundleProject(state: State, bundleId: string, dir: string, opts?: HomeOption): State;
/** Canonical project dirs where the skill is allowed (through any bundle listing the dir), sorted. */
export function projectsFor(state: State, skillId: string, opts?: HomeOption): string[];
/** Canonical dirs whose project file must be read and planned: bundle projects ∪ managedProjects, sorted. */
export function projectTargets(state: State, opts?: HomeOption): string[];
/** All stored project dirs in canonical form, aliases merged. Returns `state` itself if already canonical. */
export function canonicalizeProjects(state: State, opts?: HomeOption): State;
/** Rename dirs per `aliases` (dir → dir to keep), e.g. after an adapter finds two are one folder. */
export function mergeProjectDirs(state: State, aliases: Record<string, string>): State;
/** Pure. Replaces only skill rules with one allow per id (no deny). null in + no ids → null out. */
export function applyProjectPermissions(text: string | null, skillIds: string[]): string | null;
