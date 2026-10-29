#!/bin/sh
# Open the promotion PR that moves the beta channel.
#
# A promotion is NOT a special publish: bumping the MINOR in package.json is
# the whole mechanism (.github/workflows/publish.yml). The rule gives the
# promoting merge a patch count of 0, it publishes with no dist-tag, and
# publishing with no tag is what moves `latest`. See invariant 29.
#
# What this script does is the fifteen mechanical steps around that bump. What
# it deliberately does NOT do is write the prose: a promotion's body is the
# only honest summary of a whole generation, and it has to be read off the
# merges. Pass it in.
#
# Usage:
#   promote.sh --body <file>
#
#   <file>  line 1 is the PR title, then a blank line, then the body.
#           Mirrors `git commit -F`, so the same file is the commit message.
set -eu

# Resolve the worktree, never assume it: this host has BOTH /root/.shadok-ai
# and /Users/<someone>/.shadok-ai, and `$HOME` points at the one WITHOUT the
# worktrees. A hardcoded `$HOME` path is what made the first two runs of this
# script refuse to work at all.
resolve_worktree() {
  if [ -n "${PROMOTE_WORKTREE:-}" ]; then printf '%s' "$PROMOTE_WORKTREE"; return; fi
  for c in "$HOME/.shadok-ai/worktrees/pr-bot" /Users/*/.shadok-ai/worktrees/pr-bot; do
    [ -e "$c/.git" ] && { printf '%s' "$c"; return; }
  done
}
WORKTREE=$(resolve_worktree)
PKG="shadok-ai"

die() { printf '%s\n' "REFUSED: $*" >&2; exit 1; }

BODY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --body) BODY="${2:-}"; shift 2 ;;
    --worktree) WORKTREE="${2:-}"; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
[ -n "$BODY" ] || die "usage: promote.sh --body <file>"
[ -f "$BODY" ] || die "no such body file: $BODY"

TITLE=$(head -1 "$BODY")
[ -n "$TITLE" ] || die "$BODY has no title on its first line"
[ -z "$(sed -n '2p' "$BODY")" ] || die "$BODY needs a blank line under its title"

# The push must never come from the root checkout: agents work there and a
# branch switch under them is the chaos invariant 9 is about. The dedicated
# worktree is the only place this is allowed to write, and it must never be
# sitting on main.
[ -n "$WORKTREE" ] || die "cannot find the pr-bot worktree - set PROMOTE_WORKTREE"
[ -e "$WORKTREE/.git" ] || die "no worktree at $WORKTREE"
cd "$WORKTREE"
[ -z "$(git status --porcelain)" ] || die "$WORKTREE has uncommitted changes — clean it first"
CUR=$(git rev-parse --abbrev-ref HEAD)
[ "$CUR" = "main" ] && die "$WORKTREE is on main; it must never check out main"

git fetch origin -q

BASE=$(git show origin/main:package.json | python3 -c 'import json,sys; print(".".join(json.load(sys.stdin)["version"].split(".")[:2]))')
LATEST=$(npm view "$PKG@latest" version 2>/dev/null || true)
[ -n "$LATEST" ] || die "cannot read $PKG@latest from the registry"
LATEST_BASE=$(printf '%s' "$LATEST" | cut -d. -f1,2)

# Read the verdict from the REGISTRY, exactly as CI does, so this script and
# the workflow can never disagree about whether a promotion is due.
[ "$BASE" = "$LATEST_BASE" ] || die "nothing to promote: package.json is $BASE and latest is already $LATEST"

MAJOR=$(printf '%s' "$BASE" | cut -d. -f1)
MINOR=$(printf '%s' "$BASE" | cut -d. -f2)
NEXT="$MAJOR.$((MINOR + 1))"
BRANCH="promote-$NEXT"

git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null && die "branch $BRANCH already exists in $WORKTREE"
git checkout -q -b "$BRANCH" origin/main

# Only the version line, in both files, and nothing else: a promotion whose
# diff is bigger than three lines is not a promotion any more.
python3 - "$NEXT.0" <<'PY'
import json, re, sys
want = sys.argv[1]
for path in ("package.json", "package-lock.json"):
    src = open(path).read()
    cur = json.loads(src)["version"]
    out, n = re.subn(rf'"version": "{re.escape(cur)}"', f'"version": "{want}"', src, count=2)
    open(path, "w").write(out)
    print(f"{path}: {cur} -> {want} ({n} occurrence(s))")
PY

CHANGED=$(git diff --name-only | tr '\n' ' ')
case "$CHANGED" in
  *package.json*package-lock.json*|*package-lock.json*package.json*) ;;
  *) die "expected package.json and package-lock.json to change, got: $CHANGED" ;;
esac

git add package.json package-lock.json
git commit -q -F "$BODY"
git push -q -u origin "$BRANCH"

# The title must not also be the body's first line: `git commit -F` reads the
# split, `gh pr create` does not.
PRBODY=$(mktemp)
tail -n +3 "$BODY" > "$PRBODY"
URL=$(gh pr create --base main --head "$BRANCH" --title "$TITLE" \
        --body-file "$PRBODY" 2>&1 | tail -1)
rm -f "$PRBODY"
printf 'promotion PR for %s.0: %s\n' "$NEXT" "$URL"
N=$(printf '%s' "$URL" | grep -oE '[0-9]+$' || true)
if [ -n "$N" ]; then
  printf 'when verify is green, finish it with:\n  pr-merge.sh %s --head %s\n' "$N" "$(git rev-parse HEAD)"
fi
