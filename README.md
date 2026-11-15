# Skill Bundles

An [OpenChamber](https://openchamber.dev) extension and a `skills` command that turn
[OpenCode](https://opencode.ai) skills on and off in named bundles.

Every skill you have is listed in every OpenCode prompt, and that list can grow to more than
30,000 characters on each request. Skill Bundles lets you keep only the skills you use turned on and
switch the rest on in groups when you need them.

## What it does

- **Bundles:** group skills ("Dev & coding", "Media", "NVIDIA", …) and turn a whole group on or
  off with one switch.
- **Drag and drop:** drag a skill pill into another bundle to move it, or hold Alt/⌥ while you
  drop it to copy it there instead.
- **Per-skill mode:** Automatically (listed in every prompt), When called (loads only when you type
  `@skill-id`) or Off. Click a skill to edit its description and see its SKILL.md.
- **All skills list:** one row per skill. Use ↑/↓ to move between rows and A / C / O to set the mode.
- **Send to project:** right-click a skill (two-finger click on a Mac) and pick a project. A click
  moves the skill into `<project>/.opencode/skills/`, and Alt/⌥-click copies it there instead.
- **`skills` command:** everything the panel does, from the terminal, with `--dry-run`.

## How it works

Nothing is deleted or moved out of your skills folder. Skill Bundles changes only:

| File | What changes |
|---|---|
| `~/.config/opencode/skill-bundles.json` | your bundles (created on first use) |
| `~/.config/opencode/opencode.json` | the `permissions` rules with `action: "skill"`, and nothing else |
| `~/.config/opencode/skills/<id>/SKILL.md` | the `opencode/autoinvoke` line, only for skills set to "When called"; also the description, if you edit it in the panel |

Safety:
- It makes a daily backup (`opencode.json.skill-bundles-YYYYMMDD`).
- Each save is all-or-nothing, and keeps your file permissions.
- A lock file stops the panel and the command from writing at the same time.
- A save stops if a file changed on disk since it was loaded.
- It won't edit a SKILL.md whose layout it can't edit safely. That skill gets a "manual edit
  needed" badge instead.

## Install

Requirements: OpenChamber 2.7.1 or newer, and OpenCode V2. The `skills` command also needs Node 18
or newer.

**[Open in OpenChamber](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2Fnightshine8%2Fopenchamber-skill-bundles)** (desktop app),
or:

1. In OpenChamber, open **Settings → Extensions**, paste
   `https://github.com/nightshine8/openchamber-skill-bundles`, and click **Add**.
2. Approve the permissions (see below), then open **Skill Bundles** from the rail or the Pages
   section.
3. Click **Create from defaults**. You get 12 starter bundles, with only "Dev & coding" and
   "Research & architecture" turned on. Edit them however you like.

Installed from the URL, OpenChamber offers updates in Settings → Extensions whenever a new version
is pushed.

For the `skills` command, clone the repo and link it onto your PATH:

```bash
git clone https://github.com/nightshine8/openchamber-skill-bundles
ln -s "$PWD/openchamber-skill-bundles/bin/skills" ~/.local/bin/skills
```

### Permissions it asks for

- **Files:** your skills folder, `opencode.json` and its backups, `skill-bundles.json`, the lock
  file, and `.opencode/skills/` folders inside projects. Those project folders can be under your
  home folder or anywhere on disk, so you can send skills to any project.
- **sessions:** reads your OpenChamber project list for "Send to project".

No network access, no background service, no OpenCode plugin.

## Updating

- **Extension:** if you installed from the GitHub URL, OpenChamber checks for new versions on its
  own (soon after it opens, then every few hours) and shows **Update** on the card in
  Settings → Extensions. If a new version asks for more permissions, you approve them again there.
- **`skills` command:** run `git pull` in the folder you cloned. The link on your PATH keeps
  pointing at it.

## The `skills` command

```
skills list                         bundles, counts, estimated prompt size
skills on <bundle...> | off <bundle...>
skills set <skill> auto|called|off|clear
skills move <skill> <bundle> [--from <bundle>] [--copy]
skills new <name> | rename <bundle> <name> | rm <bundle>
skills show <bundle> | status | sync
--dry-run                           show the diff, write nothing
```

## Limits

- The extension can't delete files (the OpenChamber SDK has no delete call). "Move to project" copies the skill and turns the
  global copy off. Delete the global folder yourself if you want it gone.
- Built-in skills (`opencode`, `report`) can only be Automatically or Off.
- If you run the panel and the command at the very same moment, there's a very small window where
  both could take the lock. Both re-check every file before saving, so a collision is caught before
  anything is written.

## Develop

```bash
bun install
bun run build       # panel/main.ts → panel/main.js (IIFE)
npm test            # node tests (core + CLI) and bun tests (panel I/O)
```

The rules are in `docs/SPEC.md`. `src/core.js` holds the shared logic the panel and the CLI both
use.
