#!/bin/sh
# Merge one reviewed PR, with the loop's refusals made mechanical.
#
# WHO RUNS THIS: the human, from the cockpit composer with the `!` prefix. In
# auto mode the classifier gates `gh pr merge` on the INTENT it reads in the
# conversation, not on the command's spelling, so an allow rule is not a pass
# and a wrapper script is not one either — measured, see SKILL.md. What a
# script can still do is make the human's one line shorter than the raw
# command AND safer than it, by refusing what the agent would have refused.
#
# Usage:
#   pr-merge.sh <N> [--head <sha>] [--fork-ok]
#
#   --head <sha>  refuse unless the PR's head is still EXACTLY this commit.
#                 This is the one guard a human cannot keep in their head: a
#                 PR can grow between the review and the merge, and then the
#                 thing that lands is not the thing anyone read. The agent
#                 prints the sha it verified; pass it back.
#   --fork-ok     allow a cross-repository (fork) PR. Off by default: the loop
#                 never merges a fork without a human's explicit word.
set -eu

# Resolve the repo, never assume it. `$HOME` is NOT the launch dir on every
# host (here it is /root while the checkout lives under /Users/...), and a
# hardcoded path is how a sibling guard quietly stopped matching reality.
# The cockpit runs a `!` command from the launch directory, so the current
# repo is the right answer whenever there is one.
resolve_repo() {
  if [ -n "${PR_MERGE_REPO:-}" ]; then printf '%s' "$PR_MERGE_REPO"; return; fi
  top=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$top" ] && [ -d "$top/.git" ]; then printf '%s' "$top"; return; fi
  for c in "$HOME/projects/shadok-ai" /Users/*/projects/shadok-ai; do
    [ -d "$c/.git" ] && { printf '%s' "$c"; return; }
  done
}
REPO_DIR=$(resolve_repo)
WHITELIST="shadok-ai-dev dependabot[bot] github-actions[bot]"

die() { printf '%s\n' "REFUSED: $*" >&2; exit 1; }

N=""; WANT_HEAD=""; FORK_OK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --head) WANT_HEAD="${2:-}"; shift 2 ;;
    --fork-ok) FORK_OK=1; shift ;;
    -*) die "unknown option $1" ;;
    *) N="$1"; shift ;;
  esac
done
[ -n "$N" ] || die "usage: pr-merge.sh <PR number> [--head <sha>] [--fork-ok]"

[ -n "$REPO_DIR" ] || die "cannot find the shadok-ai checkout — set PR_MERGE_REPO"
cd "$REPO_DIR" || die "no repo at $REPO_DIR"

J=$(gh pr view "$N" --json \
  number,title,author,isDraft,baseRefName,mergeStateStatus,headRefOid,labels,isCrossRepository,files,state) \
  || die "cannot read PR #$N"

get() { printf '%s' "$J" | python3 -c "import json,sys; print($1)"; }

STATE=$(get 'json.load(sys.stdin)["state"]')
[ "$STATE" = "OPEN" ] || die "#$N is $STATE, not OPEN"

TITLE=$(get 'json.load(sys.stdin)["title"]')
AUTHOR=$(get 'json.load(sys.stdin)["author"]["login"]')
HEAD=$(get 'json.load(sys.stdin)["headRefOid"]')
MSS=$(get 'json.load(sys.stdin)["mergeStateStatus"]')
DRAFT=$(get 'json.load(sys.stdin)["isDraft"]')
BASE=$(get 'json.load(sys.stdin)["baseRefName"]')
FORK=$(get 'json.load(sys.stdin)["isCrossRepository"]')
LABELS=$(get '" ".join(l["name"] for l in json.load(sys.stdin)["labels"])')
WORKFLOW_FILES=$(get 'sum(1 for f in json.load(sys.stdin)["files"] if f["path"].startswith(".github/"))')
NFILES=$(get 'len(json.load(sys.stdin)["files"])')

# The entry filter, in the skill's order.
[ "$DRAFT" = "False" ] || die "#$N is a draft"
[ "$BASE" = "main" ] || die "#$N targets '$BASE', not main"
case " $LABELS " in *" hold "*) die "#$N carries the 'hold' label" ;; esac
if [ "$FORK" = "True" ] && [ "$FORK_OK" -eq 0 ]; then
  die "#$N comes from a fork — re-run with --fork-ok once a human has said so"
fi
if [ "$FORK" != "True" ]; then
  case " $WHITELIST " in
    *" $AUTHOR "*) ;;
    *) die "author '$AUTHOR' is outside the whitelist" ;;
  esac
fi

# A red flag that is ALWAYS the human's call, even when the rest is clean:
# a workflow file decides what runs on every future merge, including this one.
[ "$WORKFLOW_FILES" = "0" ] || die "#$N touches $WORKFLOW_FILES file(s) under .github/ — a human reviews those, never a script"

# Never merge on a stale green.
[ "$MSS" = "CLEAN" ] || die "#$N is $MSS, not CLEAN (behind, conflicting, or checks not green)"

# The growth check: what lands must be what was read.
if [ -n "$WANT_HEAD" ]; then
  case "$HEAD" in
    "$WANT_HEAD"*) ;;
    *) die "#$N has grown: head is $HEAD, you pinned $WANT_HEAD — review the new commits first" ;;
  esac
fi

printf '#%s %s\n' "$N" "$TITLE"
printf '  author %s · head %s · %s file(s)\n' "$AUTHOR" "$HEAD" "$NFILES"
[ -n "$WANT_HEAD" ] && printf '  head matches the pinned %s\n' "$WANT_HEAD"

gh pr merge "$N" --squash --subject "$TITLE (#$N)"

# PAST THIS POINT NOTHING MAY FAIL THE SCRIPT. The merge is the irreversible
# act; everything below is reporting. A non-zero exit after a successful merge
# reads as "it did not happen", which is the one wrong answer available here.
report() {
  git fetch origin -q || return 0
  TIP=$(git rev-parse origin/main) || return 0
  printf 'merged; main is now %s (%s commits). waiting for the publish run...\n' \
    "$(git rev-parse --short origin/main)" "$(git rev-list --count origin/main)"

  i=0
  RUN=""
  while [ "$i" -lt "${PR_MERGE_WAIT_TRIES:-24}" ]; do
    RUN=$(gh run list --workflow publish.yml --limit 1 \
          --json databaseId,status,headSha \
          --jq "select(.[0].headSha==\"$TIP\" and .[0].status==\"completed\") | .[0].databaseId" 2>/dev/null || true)
    [ -n "$RUN" ] && break
    i=$((i + 1)); sleep "${PR_MERGE_WAIT_SLEEP:-15}"
  done
  if [ -z "$RUN" ]; then
    printf 'publish run not finished yet - check: gh run list --workflow publish.yml\n'
    return 0
  fi
  # Read the version off the run rather than recomputing CI's rule here and
  # being subtly wrong about it.
  V=$(gh run view "$RUN" --log 2>/dev/null \
      | grep -oE '(promoting|publishing) [0-9]+\.[0-9]+\.[0-9]+ to [a-z ]*' | head -1 || true)
  if [ -n "$V" ]; then printf '%s\n' "$V"; else printf 'published; version unread from run %s\n' "$RUN"; fi
}
report || true
exit 0
