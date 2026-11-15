# shared/

Reusable building blocks for the extensions in this repo. Each extension links it in as
`<ext>/shared -> ../shared` (a git symlink), so it imports e.g. `../shared/core/json-splice.js`.
`scripts/release.sh` dereferences the link, so a published repo carries a real copy and needs
nothing from this workspace. Panel code is bundled into `panel/main.js`, so it just works.

| Folder | What | Runs in |
|---|---|---|
| `core/` | pure, I/O-free JS: JSON top-level splice, YAML frontmatter primitives, lock protocol | browser + Node |
| `node/` | Node file safety: injected `io`, atomic mode-preserving writes, symlinks, lock with reclaim, rescue files, all-or-nothing publish | Node (CLIs) |
| `panel/` | OpenChamber panel pieces (TS): write queue, panel lock, transactional writes with rollback, popup menu, drag controller, project picker, toast helper | panel (bundled) |
| `test/` | test kit (`fake-host.js` for panels, `fault-io.js` for Node CLIs) + tests: `core-*`/`node-*` run with `node --test`, `panel-*` with `bun test` | node:test / bun test |

Rules: no extension-specific names or paths in here (pass them in); every module has tests in
`shared/test/`; keep `core/` free of I/O so the panel can bundle it.
