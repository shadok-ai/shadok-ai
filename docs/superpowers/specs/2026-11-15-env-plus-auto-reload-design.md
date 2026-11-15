# The chat's "+" reloads the agent that asked for the secret

Status: built. Operator ask, 2026-11-15: *"est-ce que le bouton + permettant
d'ajouter un secret pourrait déclencher un reload de l'agent concerné une fois
le secret ajouté ?"* — scoped to **the asking agent only, automatically**, the
others left as an offer.

## Where it started

An agent writes `` `HUBSPOT_TOKEN missing from the environment` `` and a **+**
appears beside the name (`decorateEnvAsks`, `public/env-ask.js`). It opens the
vault with the name filled in and the asking agent's profile pre-ticked, so the
person only pastes the value. But a secret is injected as an environment
variable **at spawn**, so the agent that just asked still cannot see it: it had
to be reloaded, by hand, from a banner offering to do it.

So the loop existed and ended one click short. Two things were wrong with that
last click.

## What was actually broken

`offerReload` computed the agents concerned with
`secretUsers(profileCache, name)` — the **profile** side of the link only
(`profiles.json`). The vault panel in grouped mode binds a secret on the
**secret** side (`PUT /secrets/profiles`). So on a grouped instance the answer
was always the empty list, and the next line reads an empty list as "no one to
tell":

```js
if (!agents.length) { box.hidden = true; return; }
```

No banner, no error, nothing in the console. The person pasted a value, the
agent never saw it, and nothing said a reload was needed. That is invariant 72,
and the fix is a pure union read by every caller of the question —
`secretReceivers(profiles, vaultSecrets, name)` → `{ profiles, any }`. The flat
list's *"⚠ no profile uses it"* tag had the same hole for an `ANY_PROFILE`
binding, so it now reads the union too.

## The plan, and the three things it refuses to do

`openSecretFor` remembers the tab in `envAskTab`; `settleSecretWrite` consumes
it **once** (the panel stays open after an *Add*, and a second secret typed into
it has nothing to do with the agent that asked for the first; opening the panel
by hand clears it, so a later write never restarts a bystander).
`plusReloadPlan(agent, receivers)` is pure, and the order of its questions is
the design:

| Verdict | When | Why not just reload |
|---|---|---|
| `unbound` | no binding feeds that agent | A respawn would change nothing. Naming the fix ("tick a profile, or Any profile") is worth more than a restart. |
| `none` | the agent is not live | It reads the vault at its next launch. |
| `offer` | the agent is mid-turn | `reloadTab` sends `restart`, and `restartSession` **enforces** a new process (invariant 23) with no `busy` check in its way. The history survives (it is a resume), the running turn does not. Cutting a turn short is a person's call — the profile switch already says so rather than forbidding it. |
| `reload` | live, idle, and fed | The only case where the cockpit acts on its own. |

`unbound` is checked **before** liveness on purpose: the binding is the thing
the person can fix, and "it is stopped" would hide that nothing feeds it either.

Everything the plan declines falls back to the banner, which also gained an
honest clause: when some of the agents it offers are mid-turn, it says how many
and that reloading cuts those turns short.

## Deliberately not done

- **No continuation prompt.** After a reload the agent is idle with the secret
  in its environment; it does not retry on its own. Sending it a nudge would be
  speaking for the person, which was offered and not chosen.
- **The group resolution is not re-implemented client-side.** An `ANY_PROFILE`
  secret is treated as reaching every live agent, which is what the chip's own
  confirm says; across groups the server's resolution is narrower. The cost of
  being generous here is a reload that keeps its history, and only ever on a
  person's click — the automatic path still needs the agent's own profile named,
  or `any`.

## Verification

Pure cores tested (`test/secrets-panel.test.ts`), including the two shapes that
were broken: a vault-side-only binding, and `ANY_PROFILE` reaching an agent with
no profile. The wiring lives in `index.html`, which no test can import, so
`test/env-ask.test.ts` scans it the way `test/csp.test.ts` scans the nonce —
and both scans were proven to FAIL when the joins are undone (the `+` not
recording its tab; the form calling `offerReload` directly).
No browser on this machine, so there is no screenshot: the client behaviour is
covered by the pure plan and those scans, not by a run.
