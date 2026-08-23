#!/bin/sh
# Garde déterministe du cron pr-merge : silence tant qu'il n'y a rien à merger.
#
# Le serveur exécute ce script SANS LLM. Il n'imprime quelque chose que s'il
# existe au moins une PR sur laquelle la boucle peut AGIR — c'est ce qui réveille
# l'agent, et sa sortie est préfixée au prompt. Un dépôt calme coûte donc 0 token.
#
# La cible est NOMMÉE explicitement (--repo), pas déduite d'un `cd` : une version
# précédente faisait `cd "$HOME/projects/shadok-ai" || exit 0`, et le jour où
# $HOME est passé de /Users/alexandrecognard à /root, le cd a échoué — donc
# sortie vide, rc=0, garde d'apparence saine qui ne surveillait plus rien. Une
# garde muette et un dépôt calme doivent rester distinguables.
#
# Ce qui est ÉCARTÉ ici, en plus des drafts et des bases != main :
#
#   - les PR de fork  : la boucle ne les merge jamais (une livraison « Tweak »
#     en est une, et sur un dépôt public n'importe qui peut en ouvrir) ;
#   - les PR DIRTY    : un conflit se résout par son auteur ou par l'humain.
#
# Sans ce tri, une seule PR bloquée réveillait l'agent à CHAQUE créneau — un tour
# de LLM par minute pour répondre « pas la mienne ». Le filtre reste sans état :
# dès que la PR redevient mergeable, elle réapparaît d'elle-même et la boucle la
# reprend. Rien à mémoriser, donc rien à oublier.
#
# Le filtre d'entrée COMPLET (auteur, label hold) reste dans le skill : une PR
# écartée là-bas est une décision à expliquer, pas un réveil à supprimer.
gh pr list --repo shadok-ai/shadok-ai --state open --limit 50 \
    --json number,title,mergeStateStatus,isDraft,baseRefName,isCrossRepository \
    --template '{{range .}}{{if and (not .isDraft) (and (eq .baseRefName "main") (and (not .isCrossRepository) (ne .mergeStateStatus "DIRTY")))}}#{{.number}} {{.mergeStateStatus}} — {{.title}}
{{end}}{{end}}' 2>/dev/null
