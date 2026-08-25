#!/bin/sh
# Deterministic guard for the pr-merge cron: silent while there is nothing to do.
#
# The server runs this WITHOUT an LLM. It prints only when the agent has a reason
# to wake, and its output is prepended to the prompt. A quiet repository costs
# zero tokens.
#
# The target is NAMED explicitly (--repo), not inferred from a `cd`: an earlier
# version did `cd "$HOME/projects/shadok-ai" || exit 0`, and the day $HOME moved
# (a container recreate is enough) the cd failed — empty output, rc=0, a
# guard that looked healthy while watching nothing. A silent guard and a quiet
# repository must stay distinguishable.
#
# TWO KINDS OF NEWS, and they do not deserve the same treatment:
#
#   ACT   — a non-draft PR onto main, not a fork, not conflicted. The loop can
#           merge it, so print it EVERY time: repeated wakes are self-limiting,
#           the PR disappears once merged.
#
#   TELL  — a fork (a "Tweak Shadok-AI" delivery is one, and on a public repo
#           anyone can open one) or a conflicted PR. The loop never merges these;
#           the human decides. Print them only when their state CHANGED, or a
#           single stuck PR wakes the agent every minute forever to answer "not
#           mine" — which is exactly what happened at a one-minute cadence.
#
# Filtering forks out entirely was the first fix, and it went too far: it removed
# the noise by removing the signal, so a Tweak delivery sat unseen. Change
# detection keeps both.
#
# Silence discipline (invariant 16): a transient gh/network failure exits 0
# without printing. Only real news wakes the agent. Note that "no open PRs" is
# also empty output — hence the exit-status check, so a broken gh is not read as
# a calm repository.
set -u

repo=shadok-ai/shadok-ai
# ABSOLUTE, not $HOME-relative. This guard has now been broken twice by $HOME
# moving under it (it became /root when the container was rebuilt), and each time
# the failure was silent: no state written, no state read, no complaint.
# Under /root/.shadok-ai (the mounted volume), never /Users/... : only /root/.claude
# and /root/.shadok-ai survive a container recreate. The scripts themselves lived
# under /Users once and were wiped on 2026-08-10, taking every guard down at once.
state_file="$HOME/.shadok-ai/checks/pr-open.state"

# A `hold` label means a human is deciding: the PR is deliberately parked, so
# waking the agent for it every minute is the noise this guard exists to avoid.
# `--jq` rather than `--template` because a label test needs list membership,
# which Go templates only reach through an assignment loop — the five TAB-
# separated fields the awk below expects are unchanged.
rows=$(gh pr list --repo "$repo" --state open --limit 50 \
    --json number,title,mergeStateStatus,isDraft,baseRefName,isCrossRepository,labels \
    --jq '.[]
          | select(.isDraft | not)
          | select(.baseRefName == "main")
          | select([.labels[].name] | index("hold") | not)
          | [ (if (.isCrossRepository | not) and .mergeStateStatus != "DIRTY" then "ACT" else "TELL" end),
              "#\(.number)", .mergeStateStatus,
              (if .isCrossRepository then "fork" else "" end), .title ]
          | @tsv' 2>/dev/null) || exit 0

printf '%s\n' "$rows" | awk -F'\t' -v state="$state_file" '
  $1 == "ACT"  { act = act sprintf("%s %s — %s\n", $2, $3, $5) }
  $1 == "TELL" { tell[$2] = sprintf("%s %s (%s, awaiting a human) — %s", $2, $3, ($4 == "fork" ? "fork" : "conflict"), $5)
                 seen = seen sprintf("%s=%s%s\n", $2, $3, $4) }
  END {
    # A watched PR is news the first time it is seen and whenever its state
    # moves; unchanged, it stays silent.
    while ((getline line < state) > 0) prev[line] = 1
    close(state)
    out = act
    n = split(seen, rows_, "\n")
    for (i = 1; i <= n; i++) {
      if (rows_[i] == "" || rows_[i] in prev) continue
      split(rows_[i], kv, "=")
      out = out tell[kv[1]] "\n"
    }
    printf "%s", out
    # Rewrite the state unconditionally: a PR that left the list must be
    # forgotten, or reopening it later would be silently swallowed.
    printf "" > state
    for (i = 1; i <= n; i++) if (rows_[i] != "") print rows_[i] > state
  }'

# ── The release path, which nothing else watches ────────────────────────────
#
# A failed publish is SILENT: `verify` was green on the PR, the merge went
# through, and the version simply never appears on npm. 0.4.115 died that way
# and nobody noticed for four merges — the loop watches open PRs, and by the
# time a publish fails the PR is closed.
#
# Only the LAST run matters, and only while it is failing: an old failure that a
# later run fixed is history, not news. Reported once per failing run id, so a
# broken release does not re-wake the agent every minute.
pub_state="$HOME/.shadok-ai/checks/publish.state"
gap_state="$HOME/.shadok-ai/checks/publish-gap.state"
# The checkout to read history from. Derived from this script's own location
# (<repo>/.claude/skills/pr-merge/scripts/), so it follows the repo instead of
# naming one machine's home — the very trap this file's header describes, which
# a hardcoded absolute path reproduced. SHADOK_REPO_DIR overrides it. No git
# repo, no news: exit 0 rather than guess.
repo_dir=${SHADOK_REPO_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." 2>/dev/null && pwd)}
# `git rev-parse`, not `[ -d .git ]`: inside a WORKTREE .git is a FILE, so the
# directory test would fail and this guard would go silent — the exact failure
# the header above describes.
[ -n "$repo_dir" ] && git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1 || exit 0
pub=$(gh api repos/shadok-ai/shadok-ai/actions/workflows/publish.yml/runs \
        --jq '.workflow_runs[0] | select(.status=="completed" and .conclusion!="success")
              | "\(.id)\t\(.conclusion)\t\(.display_title)"' 2>/dev/null) || exit 0
if [ -z "$pub" ]; then
  : > "$pub_state" 2>/dev/null   # no failing run: forget the past
  #
  # A FAILING run is not the only way a version fails to ship — a merge can
  # trigger NO run at all. #123 landed on main and neither Publish nor CI ever
  # started: nothing was failing, and nothing was published. Watching runs
  # cannot see that; comparing the two ends can.
  #
  # npm records the commit each version was published from (`gitHead`), so this
  # needs no knowledge of the numbering rule: if the tip of main is not that
  # commit and is not behind it, something did not ship.
  #
  # GRACE PERIOD: a publish takes a few minutes, so a fresh tip is normal and
  # not news. Only a tip older than 15 minutes counts — without that, this would
  # fire after every single merge, which is the noise the guard exists to avoid.
  head=$(git -C "$repo_dir" rev-parse origin/main 2>/dev/null) || exit 0
  [ -n "$head" ] || exit 0
  [ "$(cat "$gap_state" 2>/dev/null)" = "$head" ] && exit 0
  committed=$(git -C "$repo_dir" log -1 --format=%ct "$head" 2>/dev/null) || exit 0
  [ -n "$committed" ] || exit 0
  [ $(( $(date +%s) - committed )) -lt 900 ] && exit 0
  # The NEWEST published version, not the `alpha` tag: a publish that completes
  # late sets the tag to its own, older version (0.6.1 landed after 0.6.2 and
  # dragged `alpha` backwards), so the tag is not a reliable high-water mark.
  a=$(npm view shadok-ai versions --json 2>/dev/null \
        | node -pe "try{const v=JSON.parse(require('fs').readFileSync(0,'utf8'));(Array.isArray(v)?v[v.length-1]:v)||''}catch(e){''}")
  [ -n "$a" ] || exit 0
  from=$(npm view "shadok-ai@$a" gitHead 2>/dev/null)
  [ -n "$from" ] || exit 0                                  # not recorded: never guess
  git -C "$repo_dir" cat-file -e "$from" 2>/dev/null || exit 0
  behind=$(git -C "$repo_dir" rev-list --count "$from..$head" 2>/dev/null)
  case "$behind" in ''|0) exit 0 ;; esac
  printf '%s' "$head" > "$gap_state" 2>/dev/null
  printf '⚠️ main is %s commit(s) ahead of npm (newest published %s, from %s): a merge did not ship\n' \
    "$behind" "$a" "$(printf '%s' "$from" | cut -c1-7)"
  exit 0
fi

id=$(printf '%s' "$pub" | cut -f1)
[ "$(cat "$pub_state" 2>/dev/null)" = "$id" ] && exit 0
printf '%s' "$id" > "$pub_state" 2>/dev/null
printf '⚠️ publish %s — %s (run %s): the version did NOT ship\n' \
  "$(printf '%s' "$pub" | cut -f2)" "$(printf '%s' "$pub" | cut -f3)" "$id"
