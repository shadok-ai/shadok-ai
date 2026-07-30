#!/bin/sh
# Garde déterministe du cron pr-merge : silence tant qu'il n'y a rien à merger.
#
# Le serveur exécute ce script SANS LLM. Il n'imprime quelque chose que s'il
# existe au moins une PR ouverte candidate — c'est ce qui réveille l'agent, et
# sa sortie est préfixée au prompt. Un dépôt sans PR ouverte coûte donc 0 token.
#
# Le filtre d'entrée complet (auteur, label hold, fork) reste dans le skill :
# ici on ne fait que le tri grossier — draft et base != main — pour éviter de
# réveiller l'agent sur une PR qu'il écarterait de toute façon.
cd "$HOME/projects/shadok-ai" 2>/dev/null || exit 0

gh pr list --state open --limit 50 \
    --json number,title,mergeStateStatus,isDraft,baseRefName \
    --template '{{range .}}{{if and (not .isDraft) (eq .baseRefName "main")}}#{{.number}} {{.mergeStateStatus}} — {{.title}}
{{end}}{{end}}' 2>/dev/null
