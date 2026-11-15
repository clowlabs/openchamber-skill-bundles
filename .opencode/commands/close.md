---
description: Build, lint, typecheck, test and review changes before committing
---

Close out the current work in this extension repository.

1. Run `bun run build`, then `bun run check`. Fix failures and rerun the affected checks.
2. Verify the built panel and status bundles are current, and inspect `git status` and the diff for accidental files or secrets.
3. If the changed code has not had a cross-family review, run one and verify its findings.
4. Summarize the changes, verification and anything left open. Propose a commit message; do not commit or push without being asked.

$ARGUMENTS
