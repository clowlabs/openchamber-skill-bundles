#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NAMES=()
RESULTS=()
FAILURES=0

check() {
	local name="$1"
	shift
	printf '\n==> %s\n' "$name"
	NAMES+=("$name")
	if "$@"; then
		RESULTS+=("PASS")
	else
		RESULTS+=("FAIL")
		FAILURES=$((FAILURES + 1))
	fi
}

check Typecheck bun run typecheck
check Tests bun run test
check "Shared tests (node)" node --test shared/test/core-*.test.js shared/test/node-*.test.js
check "Shared tests (bun)" bun test shared/test/panel-
check Lint bun run lint
check "SDK check" bunx openchamber-guest-check .

printf '\n%-24s %s\n' "Check" "Result"
for i in "${!NAMES[@]}"; do
	printf '%-24s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"
done
if [[ "$FAILURES" -gt 0 ]]; then
	printf '\n%d check(s) failed.\n' "$FAILURES" >&2
	exit 1
fi
