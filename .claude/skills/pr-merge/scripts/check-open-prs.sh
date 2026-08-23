#!/bin/sh
# Deterministic guard for the pr-merge cron: silent while there is nothing to do.
#
# The server runs this WITHOUT an LLM. It prints only when the agent has a reason
# to wake, and its output is prepended to the prompt. A quiet repository costs
# zero tokens.
#
# The target is NAMED explicitly (--repo), not inferred from a `cd`: an earlier
# version did `cd "$HOME/projects/shadok-ai" || exit 0`, and the day $HOME went
# from /Users/alexandrecognard to /root the cd failed — empty output, rc=0, a
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
state_file="/Users/alexandrecognard/.shadok-ai/checks/pr-open.state"

rows=$(gh pr list --repo "$repo" --state open --limit 50 \
    --json number,title,mergeStateStatus,isDraft,baseRefName,isCrossRepository \
    --template '{{range .}}{{if and (not .isDraft) (eq .baseRefName "main")}}{{if and (not .isCrossRepository) (ne .mergeStateStatus "DIRTY")}}ACT{{else}}TELL{{end}}	#{{.number}}	{{.mergeStateStatus}}	{{if .isCrossRepository}}fork	{{else}}	{{end}}{{.title}}
{{end}}{{end}}' 2>/dev/null) || exit 0

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
