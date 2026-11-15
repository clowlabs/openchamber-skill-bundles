# Skill Bundles — spec (source of truth for all workers)

OpenChamber extension + CLI that turns OpenCode skills on/off in named bundles, and edits a
single skill's settings (description, "Agents use it", SKILL.md) in the same page.

## Files on the user's machine

| Path | Owner | Notes |
|---|---|---|
| `~/.config/opencode/skill-bundles.json` | us | bundle definitions + per-skill overrides (schema below) |
| `~/.config/opencode/opencode.json` | user (plain JSON, no comments) | we rewrite ONLY entries in `permissions` whose `action === "skill"` |
| `~/.config/opencode/skills/<id>/SKILL.md` | user | frontmatter `metadata.opencode/autoinvoke` and `description` |

Skill IDs = directory names under `~/.config/opencode/skills` (195 today, skip dotfiles) plus
built-ins `opencode` and `report` (no SKILL.md; can only be auto/off; `called` → treat as `auto`).

## skill-bundles.json schema (version 1)

```json
{
  "version": 1,
  "bundles": [
    { "id": "dev", "name": "Dev & coding", "enabled": true, "skills": ["ast-grep", "vite"] }
  ],
  "overrides": { "context7-docs": "called", "comfyui": "auto" }
}
```

- A skill may sit in several bundles. Skills in no bundle appear under a synthetic
  "Unbundled" group (id `__unbundled`, never stored, always disabled unless overridden).
- `overrides[id]` is `"auto" | "called" | "off"` and beats bundle state.

## Effective mode (one function, used everywhere)

```
mode(id) = overrides[id] ?? (any bundle containing id is enabled ? "auto" : "off")
```

## How modes are written

- `opencode.json` `permissions`: drop every existing rule with `action:"skill"`, keep all
  other rules in their original order, then append:
  1. `{ "action":"skill", "resource":"*", "effect":"deny" }`
  2. one `{ "action":"skill", "resource":"<id>", "effect":"allow" }` per skill whose mode is
     `auto` or `called`, sorted by id.
  Preserve every other top-level key and their order; write with 2-space indent + trailing newline.
- `called` additionally needs SKILL.md frontmatter `metadata:` → `opencode/autoinvoke: false`.
  `auto` must ensure that key is absent (remove it; remove an emptied `metadata:` block only if
  we created it — simplest: only touch the single `opencode/autoinvoke` line).
  Frontmatter edits must be surgical text edits (no YAML re-serialisation; files have nested
  YAML like `metadata.info.tags`). If `metadata:` exists, insert `  opencode/autoinvoke: false`
  as its first child line; if not, add `metadata:\n  opencode/autoinvoke: false` before the
  closing `---`. Builtin `opencode` with `called` → treat as `auto`.
- Never delete skill folders.

## Core module — `src/core.js` (pure ESM, zero deps, no fs; I/O injected)

Exports (exact names; CLI and panel both import these):

```js
export const BUNDLES_PATH = "~/.config/opencode/skill-bundles.json"
export const OPENCODE_PATH = "~/.config/opencode/opencode.json"
export const SKILLS_DIR = "~/.config/opencode/skills"
export const BUILTIN_SKILLS = ["opencode", "report"]
export function parseBundles(text)            // -> normalized state; throws Error with clear msg on bad schema
export function serializeBundles(state)       // -> string (2-space, trailing \n)
export function effectiveMode(state, id)      // -> "auto"|"called"|"off"
export function groups(state, allIds)         // -> [{id,name,enabled,skills,synthetic?}] incl. __unbundled
export function setBundleEnabled(state, bundleId, on)   // returns NEW state (immutable); clears overrides for that bundle's skills
export function setOverride(state, id, mode|null)        // null removes override
export function moveSkill(state, id, fromBundle, toBundle, {copy=false})
export function createBundle(state, name)  renameBundle(state, id, name)  deleteBundle(state, id)
export function applyPermissions(opencodeText, state, allIds)  // -> new opencode.json text
export function readFrontmatter(skillMd)      // -> { description, autoinvoke: boolean, hasFrontmatter }
export function setAutoinvoke(skillMd, bool)  // -> new text (true = remove line)
export function setDescription(skillMd, text) // -> new text (single-line `description:`; quote if needed)
export function syncPlan(state, allIds, skillMds) // -> { opencode: fn(text)->text, skillEdits: [{id, next}] } for changed SKILL.md only
```

`skillMds` is `{ [id]: text }`.

## CLI — `bin/skills` (Node ≥18 ESM, `#!/usr/bin/env node`, a stub calling `runCli` from ../src/cli.js)

`src/cli.js` exports `runCli(argv, {io?, env?, stdout?, stderr?}) → exitCode` and `createNodeIO()`;
all persistence goes through the `io` object, so tests inject faults without env hooks.

```
skills list                      # bundles with on/off + counts, then totals and est. prompt chars
skills show <bundle>
skills on <bundle...>  | off <bundle...>
skills set <skill> auto|called|off|clear
skills move <skill> <toBundle> [--from <b>] [--copy]
skills new <name> | rename <bundle> <name> | rm <bundle>
skills sync                      # re-apply files from skill-bundles.json
skills status                    # mode of every skill, grouped
```
Every mutating command: load → mutate via core → `core.planChange` → publish its writes
(atomic write: temp + rename) → print one-line summary.

**Publication order (CLI and panel):** changed SKILL.md files (by id), then opencode.json, then
skill-bundles.json last. `planChange(prev, next, allIds)` returns `writes` already in this order
(`core.PUBLISH_ORDER = ["skill","opencode","bundles"]`). skill-bundles.json is last so that it only
records the new state once the files that enforce it are in place; any failure before that
leaves the old state file, and a re-run (`skills sync`) converges.
Back up opencode.json once per day to `opencode.json.skill-bundles-<YYYYMMDD>` before first write.
`--dry-run` prints the diff instead of writing. `--home <dir>` overrides `~` (tests use it).

## Panel — OpenChamber extension (`package.json` openchamber block, `panel/`)

- SDK `@openchamber/sdk` 2.7.1, docs in `../docs/sdk/`. Built IIFE `panel/main.js` from
  `panel/main.ts` (`bunx openchamber-guest-bundle panel/main.ts panel/main.js`). Core is bundled in.
- Manifest: id `skill-bundles`, name `Skill Bundles`, icon `stack`, `panel.entry panel/index.html`,
  `page: true`, `filesystem`: the three paths above (`~/.config/opencode/skills/**`).
  No `service`, no network, no extra capabilities.
- I/O via `host.readFile/writeFile/listDir`. Skill list = `listDir(SKILLS_DIR)` directories.
- UI (matches approved mockup): left = search + legend + bundle groups with on/off switch and
  draggable pills (pointer events; Alt-drop = copy; drop zone highlight), pill colour by mode
  (auto=success tint, called=info tint, off=muted); toolbar "All skills" tab = flat sorted list.
  Right = detail of selected skill: id, path, bundle badges, "+ bundle", Description textarea
  (save on blur), "Agents use it" segmented Automatically / When called / Off, note when it
  overrides its bundle, read-only SKILL.md preview. New / rename / delete bundle controls.
- Every change saves immediately (same write path as CLI) and shows a toast on error.
- Use `@openchamber/sdk/ui` + `applyHostReady` theme tokens; own CSS only where the kit lacks.

## Lock

Writers (CLI and panel) serialise through `~/.config/opencode/.skill-bundles.lock` (mode 0600),
taken before loading state and released (only if it still holds the writer's own content) when done.

```json
{ "pid": 4242, "host": "my-host", "time": 1763100000000, "token": "k3j2…" }                 // CLI
{ "owner": "panel", "host": "my-host", "pid": 0, "token": "k3j2…", "time": 1763100000000 }  // panel
```

- CLI creates it with `O_EXCL`. The panel (no `O_EXCL`) writes it only when it stats as missing,
  then reads it back and proceeds only if the token matches.
- `owner: "panel"` → live for 60 s from `time` (or mtime if later); reclaimable after that, never earlier.
- Otherwise, same host + `pid > 0` → live while that pid is alive; reclaimable once it is dead.
- Unparseable, no host, or another host → reclaimable only when the file is older than 10 min.
- Release: the CLI deletes the lock if it still holds its own content. The panel cannot delete,
  so it releases by overwriting the file with exactly `{"owner":"panel","released":true,"time":0}`.
  That marker counts as **free**.
- Taking over a free/stale lock: read it and judge it, rename it aside to a private name, and compare.
  If the content is still what was judged, discard it and create a fresh lock with `O_EXCL`.
  Otherwise someone re-acquired in between: link theirs back (never overwriting) and report "busy".
- The rules live in core: `parseLock(text)` → `{kind: "cli"|"panel"|"released"|"invalid"}` and
  `classifyLock(info, {now, mtimeMs, pidAlive?, host?})` → `"free"|"held"|"stale"`, with
  `PANEL_LOCK_TTL_MS`, `LOCK_UNPARSEABLE_STALE_MS`, `RELEASED_MARKER` and `panelLockRecord(token, now)`.
  "released" requires `owner: "panel"` **and** `released === true`. Adapters keep their own I/O
  (CLI: pid probe, O_EXCL, reclaim; panel: polling).
- `--dry-run` takes no lock and writes nothing.

## Defaults

`data/default-bundles.json` is the seed (11 bundles covering every current skill). If
`skill-bundles.json` is missing, CLI and panel copy the seed in, then run `sync`.
The seed's enabled bundles (dev + plan) reproduce today's hand-written rules exactly
(minus `report`/`duckduckgo-search`, which are in disabled bundles).

## Layout & ownership (one worker per row — do not touch other rows' files)

| Worker | Files |
|---|---|
| core | `src/core.js`, `test/core.test.js` |
| cli | `bin/skills`, `test/cli.test.js`, `test/fixtures/**` |
| panel | `package.json`, `panel/**`, `icon.svg` (optional) |
| workspace | repo root of `~/Projects/Extensions` except `skill-bundles/` |

Tests: `node --test skill-bundles/test/` (built-in runner, no deps).
