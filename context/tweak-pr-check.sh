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

state_dir="$HOME/.shadok-ai/tweak-pr"
mkdir -p "$state_dir" 2>/dev/null || exit 0
key=$(printf '%s' "$pr" | tr -c 'A-Za-z0-9' '-')
state_file="$state_dir/$key.state"

now=$(gh pr view "$pr" --repo "$repo" \
        --json state,mergeable,reviewDecision,statusCheckRollup \
        --template '{{.state}}|{{.mergeable}}|{{.reviewDecision}}|{{range .statusCheckRollup}}{{.name}}={{.conclusion}} {{end}}' \
        2>/dev/null) || exit 0
# gh can succeed and print nothing (rate limit, transient auth): treat as no news
# rather than as "everything vanished".
[ -n "$now" ] || exit 0

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
