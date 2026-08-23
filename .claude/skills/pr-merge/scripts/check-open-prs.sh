#!/bin/sh
# Deterministic guard of the pr-merge cron: silent while there is nothing to merge.
#
# The server runs this script WITHOUT the LLM. It only prints something when at
# least one PR the loop can ACT on exists — that is what wakes the agent, and its
# output is prepended to the prompt. A quiet repo therefore costs 0 tokens.
#
# The target is NAMED explicitly (--repo), not derived from a `cd`: an earlier
# version did `cd "$HOME/projects/shadok-ai" || exit 0`, and the day $HOME went
# from /Users/alexandrecognard to /root the cd failed — so empty output, rc=0, a
# healthy-looking guard that watched nothing any more. A mute guard and a quiet
# repo must stay distinguishable.
#
# What is DISCARDED here, on top of drafts and bases != main:
#
#   - fork PRs   : the loop never merges them (a "Tweak" delivery is one, and on
#     a public repo anyone can open one);
#   - DIRTY PRs  : a conflict is resolved by its author or by the human.
#
# Without that sort, a single stuck PR woke the agent at EVERY slot — one LLM
# turn per minute to answer "not mine". The filter stays stateless: as soon as
# the PR becomes mergeable again it reappears on its own and the loop picks it
# up. Nothing to remember, hence nothing to forget.
#
# The COMPLETE entry filter (author, hold label) stays in the skill: a PR
# discarded there is a decision to explain, not a wake-up to suppress.
gh pr list --repo shadok-ai/shadok-ai --state open --limit 50 \
    --json number,title,mergeStateStatus,isDraft,baseRefName,isCrossRepository \
    --template '{{range .}}{{if and (not .isDraft) (and (eq .baseRefName "main") (and (not .isCrossRepository) (ne .mergeStateStatus "DIRTY")))}}#{{.number}} {{.mergeStateStatus}} — {{.title}}
{{end}}{{end}}' 2>/dev/null
