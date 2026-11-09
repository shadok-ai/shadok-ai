---
name: shadok-instance-context
description: Write this cockpit's instance context — the few lines every agent here receives at spawn (what the instance is for, who uses it, its language). Use ONLY when you are the lead agent and it is still empty (first run, or when asked to draft it). Never to change it afterwards.
---

# shadok-instance-context

Every agent on this cockpit receives a short **instance context** in its system
prompt: what this instance is for, who works on it, the language, and anything
that should shape every agent's work. Roles say *how* to work; this says *what
for*.

## Write it once

Only the lead agent (the instance's home channel) can write it, and only while
it is empty — the server refuses anything else. Write it after asking the
person, never from a guess:

```bash
node ~/.claude/skills/shadok-instance-context/scripts/write.mjs --stdin <<'CTX'
This instance runs side projects with a few friends, to try to get small
businesses off the ground. Each person may start their own project.
Language: French in conversation; code, commits and docs in English.
CTX
```

Keep it to **a handful of lines**:
- the purpose of the instance;
- the people involved, by role or first name;
- the **language**: deduce it from the language the person answered you in;
  ask only if you cannot tell. If deliverables (code, docs, commits) use another
  language than the conversation, say both;
- any tone or constraint every agent should respect.

No project wiki, no status, no secrets — the shared ledger is the place for
status, the vault for credentials.

Then show the person what you saved in a few lines, and tell them they can edit
it from the cockpit menu (**Instance context…**).

## Afterwards: suggest, never rewrite

Once it is set, nobody but a human changes it. If you learn something that
makes it wrong (a new person joins, the focus moves), **suggest** the new
wording in the chat and point to the cockpit menu. Do not try to write it
again — the server will refuse, and that refusal is the design.
