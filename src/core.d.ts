export type Mode = "auto" | "called" | "off";

export interface Bundle {
  id: string;
  name: string;
  enabled: boolean;
  skills: string[];
}

export interface State {
  version: 1;
  bundles: Bundle[];
  /** Null-prototype record; read with own-property checks. */
  overrides: Record<string, Mode>;
  /** Optional { [skillId]: projectDir[] }; absent when empty. */
  projectCopies?: Record<string, string[]>;
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

export function parseBundles(text: string): State;
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

export type WriteKind = "skill" | "opencode" | "bundles";

export interface PlannedWrite {
  kind: WriteKind;
  /** Present when kind === "skill". */
  id?: string;
  /** "~/"-relative path (SKILLS_DIR/<id>/SKILL.md, OPENCODE_PATH or BUNDLES_PATH). */
  path: string;
  /** Text as read; null only for a bundles file that does not exist yet (seeding). */
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
}

/** Errors thrown by planChange carry which file they concern. */
export interface PlanError extends Error {
  file: "opencode" | "skill";
  id?: string;
}

export const PUBLISH_ORDER: ["skill", "opencode", "bundles"];
export function planChange(prev: PrevFiles, next: State, allIds: string[]): ChangePlan;

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
