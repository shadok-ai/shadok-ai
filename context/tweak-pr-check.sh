#!/bin/sh
# Cron guard for a tweak pull request. Prints NOTHING while nothing changed, one
# short line when it does — so the agent is woken only when there is news, and a
# quiet PR costs zero tokens (see the shadok-scheduler skill).
#
# Usage: tweak-pr-check.sh <pr-url-or-number> [repo]
#
# Lives OUTSIDE the agent's worktree on purpose. Once the tweak agent has
# committed and pushed, its tree is clean, so closing the session prunes the
# checkout — a guard stored in there would vanish and start failing every slot.
#
# Silence discipline (invariant 16): a transient gh/network failure must stay
# quiet and exit 0. Only a REAL change prints. Writing to stderr would wake the
# agent every five minutes, which is the failure this guard exists to avoid.
set -u

pr=${1:-}
[ -n "$pr" ] || exit 0
repo=${2:-shadok-ai/shadok-ai}

# Reads the PR JSON on stdin. `pr_field head` prints the head sha; `pr_field
# state <checks-json>` prints the same state line shape the gh path produces, so
# a state file written by one backend stays comparable with the other.
pr_field() {
  python3 -c '
import json, sys
mode = sys.argv[1]
checks_raw = sys.argv[2] if len(sys.argv) > 2 else ""
try:
    p = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if mode == "head":
    print(p.get("head", {}).get("sha", ""))
    sys.exit(0)
if checks_raw:
    try:
        runs = json.loads(checks_raw).get("check_runs", [])
        checks = " ".join("%s=%s" % (c["name"], c.get("conclusion") or c.get("status")) for c in runs) or "no-checks"
    except Exception:
        checks = "checks-unknown"
else:
    checks = "checks-unknown"
print("|".join([str(p.get("state")), str(p.get("mergeable")), str(p.get("mergeable_state") or ""), checks]))
' "$@"
}

state_dir="$HOME/.shadok-ai/tweak-pr"
mkdir -p "$state_dir" 2>/dev/null || exit 0
key=$(printf '%s' "$pr" | tr -c 'A-Za-z0-9' '-')
state_file="$state_dir/$key.state"

now=""
if command -v gh >/dev/null 2>&1; then
  now=$(gh pr view "$pr" --repo "$repo" \
          --json state,mergeable,reviewDecision,statusCheckRollup \
          --template '{{.state}}|{{.mergeable}}|{{.reviewDecision}}|{{range .statusCheckRollup}}{{.name}}={{.conclusion}} {{end}}' \
          2>/dev/null) || exit 0
else
  # No gh on this host. Falling through to `|| exit 0` would leave the guard
  # PERMANENTLY silent — it would pass the "prints nothing, exits 0" check while
  # never being able to fire, which reads as coverage and is worse than no watch
  # at all. The public API answers the same questions without any credential.
  api="https://api.github.com/repos/$repo"
  body=$(curl -sf --max-time 20 "$api/pulls/$pr" 2>/dev/null) || exit 0
  [ -n "$body" ] || exit 0
  head=$(printf '%s' "$body" | pr_field head 2>/dev/null) || exit 0
  [ -n "$head" ] || exit 0
  checks=$(curl -sf --max-time 20 "$api/commits/$head/check-runs" 2>/dev/null) || checks=""
  now=$(printf '%s' "$body" | pr_field state "$checks" 2>/dev/null) || exit 0
fi
# A backend can succeed and print nothing (rate limit, transient auth): treat as
# no news rather than as "everything vanished".
[ -n "$now" ] || exit 0

# GitHub computes mergeability lazily and answers UNKNOWN/null meanwhile. Left
# alone, UNKNOWN -> MERGEABLE -> UNKNOWN wakes the agent three times for one
# non-event, so a still-computing slot is skipped rather than reported.
case "$now" in
  *"|UNKNOWN|"*|*"|None|"*) exit 0 ;;
  *checks-unknown) exit 0 ;;
esac

prev=""
[ -f "$state_file" ] && prev=$(cat "$state_file" 2>/dev/null)

# First sighting: record and stay silent. Announcing a PR the agent just opened
# would wake it for something it already knows.
if [ -z "$prev" ]; then
  printf '%s' "$now" > "$state_file" 2>/dev/null
  exit 0
fi

[ "$now" = "$prev" ] && exit 0
printf '%s' "$now" > "$state_file" 2>/dev/null
echo "PR $pr changed: $now (was: $prev)"
