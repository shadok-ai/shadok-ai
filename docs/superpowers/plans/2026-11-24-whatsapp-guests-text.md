# WhatsApp step 2 — the binding, the guest door, text both ways: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone who writes a text to the instance's linked WhatsApp number gets an agent of their own: spawned on the profile and in the restricted group an admin chose, always the same agent for the same person, answering in WhatsApp's own formatting. Nothing a stranger types runs as a command, nothing received is lost across a server restart, and the bridge never writes to a number that has not written first.

**Architecture:** The transport seam (`WaTransport`) gains its message half — an inbound `message` event, `sendText`, `setTyping`, `resolveLid`. The handle (`whatsapp.ts`) exposes it to ONE consumer, the bridge (`wa-bridge.ts`), which mirrors Telegram's guest path: one loopback WebSocket per person to our own server, presenting the internal cookie plus a WhatsApp bridge secret of its own, so the server derives the `whatsapp` origin and picks the WhatsApp guest setup from the connection, never from a frame. Every decision is a pure function (`wa-guests.ts`, `wa-format.ts`); the one piece of state that must survive a restart — what was received and not yet submitted, and the ids already seen — is a small persisted inbox (`wa-inbox.ts`).

**Tech Stack:** TypeScript, ESM, Node 20, `node:test`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-whatsapp-open-dm-design.md` — "Suggested order of work", step 2. Step 1's plan: `docs/superpowers/plans/2026-11-23-whatsapp-link-and-panel.md`.

## Global Constraints

- `CLAUDE.md` rules: English in the repo, comments explain why, docs in the same PR, browser check on a side port, never 3789, never restart the running server.
- **The binding has its own field.** `Channel.whatsapp = { account, id, phone? }`, server-owned, never written into `Channel.telegram`. Telegram code never reads it; WhatsApp code never reads `telegram`.
- **The connection decides.** A WhatsApp bridge socket presents `x-shadok-wa-bridge` (a per-process secret, like `TELEGRAM_BRIDGE_SECRET`). Only that makes the origin `whatsapp`, makes `from`/`voice` believable, honours the guest marker with the WhatsApp setup, and names the `wa-<digits>` work directory. A socket proving neither secret gains nothing from `guest: true` or `origin: "whatsapp"`.
- **Guest rules reused, not copied:** `guestSpawnPlan`, `guestPatchFlow`, `guestEnableRefusal`, `guestGroupChoices`, `withInstanceMember`, `guestNotice`. The WhatsApp setup is a `GuestSetup` whose mode is `dm-only` (door open) or `group` (door shut), stored under its own config key. The instance's membership of a group is SHARED by the two setups: it leaves a group only when neither still targets it.
- **No send to a non-binding.** The only function that sends takes a bridge, and a bridge only exists for a channel bound by an inbound message. A guard re-checks the target against the registry before every send.
- **No command from a stranger.** The bridge neutralises a leading command name; the server refuses a bare slash command from the `whatsapp` origin. Both tested.
- **Fixtures:** `Ada's shop`, `33600000000`, `Grace` / `33611111111`, LIDs like `100000000000001@lid`. No real number, name or incident.
- Telegram's existing tests stay green and untouched.

## Review Focus

- **One person, one agent:** a phone-number address and a LID for the same person resolve to ONE binding, whichever comes first (the PN-bound row is re-keyed to the LID, never duplicated).
- **A restart in the middle loses nothing:** a message received and not yet submitted is replayed from the inbox when the bridge comes back; a message submitted is never replayed (acknowledged on the server's `prompt-id`, or the turn's end).
- **The door shut is silence,** for new and known senders alike — no spawn, no line, and the message is not queued.
- **A channel closed in the cockpit unbinds;** the next message starts a new agent. A link that drops never ends an agent.
- **A WhatsApp-bound row** survives a browser sync, is never mirrored to Telegram, never offered "Mirror to Telegram", and never read as a Telegram chat.

---

### Task 1: Pure rules — identity, inbound filter, setup, reattach, send guard

**Files:** Create `src/wa-guests.ts`; Test `test/wa-guests.test.ts`.

**Produces:**
```ts
export interface WaBinding { account: string; id: string; phone?: string }
export function bareJid(jid: string | undefined): string | null;          // drop the ":device" suffix, lower-case, or null
export function waAccountKey(account: { id: string } | undefined): string | null; // the linked number, device dropped
export function waGuestWorkDirName(id: unknown): string | null;           // "wa-<digits>", rebuilt, never sanitised
export interface WaInbound { id: string; chat: string; chatAlt?: string; fromMe: boolean; live: boolean; unreadable: boolean; text?: string; pushName?: string; at: number }
export type InboundVerdict = { kind: "ignore"; why: string } | { kind: "text"; lid: string | null; pn: string | null; text: string };
export function inboundVerdict(m: WaInbound): InboundVerdict;            // groups, status, newsletters, broadcast, own, replays, unreadable, empty → ignore
export function findWaChannel<C extends { whatsapp?: WaBinding | null }>(list: C[], account: string, s: { lid: string | null; pn: string | null }): C | undefined;
export function senderKey(s: { lid: string | null; pn: string | null }): string | null; // LID first, else the PN
export function waGuestSetup(raw: unknown): GuestSetup;                   // mode dm-only|group only
export function waReattachList<C>(list: C[], account: string | null, hasBridge: (id: string) => boolean): C[];
export function sendAllowed(list: { whatsapp?: WaBinding | null }[], account: string, to: string): boolean;
```
- [ ] Failing tests, one per rule: device suffix dropped; `waGuestWorkDirName` accepts `100000000000001@lid`, `33600000000@s.whatsapp.net`, `33600000000:12@s.whatsapp.net` → digits; refuses dots, slashes, empty, non-digits; ids longer than a safe integer stay strings. Filter: `@g.us`, `status@broadcast`, `@newsletter`, `@broadcast`, `fromMe`, `live:false`, unreadable, blank text → ignore; a LID chat with a PN alt → both; a PN chat with a LID alt → both. Lookup: by LID; by PN when the row was bound under the PN; by the stored `phone`; another account's row never matches. `sendAllowed` false for an unbound jid and for another account's binding. Reattach list skips other accounts and channels whose bridge exists.
- [ ] Implement, run, commit.

### Task 2: WhatsApp formatting and command neutralising

**Files:** Create `src/wa-format.ts`; Test `test/wa-format.test.ts`.

**Produces:** `mdToWhatsApp(md)`, `waChunks(text)` (paragraph boundaries first, `chunk` from telegram.ts as the fallback), `neutralizeCommand(text)` (a leading `/name` gains a backslash so it is no longer `isSlashCommand`), `stripAttachmentMarkers(text)` (a server path never reaches a stranger).
- [ ] Failing tests: bold/italic/strike/inline code/fenced code (language dropped, inside untouched), headings → bold line, links → `text (url)` (bare when equal), tables → `a · b` lines with the rule row dropped, quotes and lists kept; no `<`-markup produced; a 9 000-char answer splits on blank lines; `/clear` and `/login now` neutralised, `/Users/x` and `hello /clear` untouched.
- [ ] Implement, run, commit.

### Task 3: The transport's message half, the fake, the adapter

**Files:** Modify `src/wa-transport.ts`, `src/wa-fake.ts`, `src/wa-baileys.ts`, `src/wa-worker-host.ts`, `src/wa-worker.ts`; Tests `test/wa-transport.test.ts`, `test/wa-baileys.test.ts`, `test/wa-worker.test.ts` (extend).

**Produces:** `WaTransportEvent` gains `{ type: "message"; msg: WaInbound }`. `WaTransport` gains `sendText(to, text)`, `setTyping(to, on)`, `resolveLid(pn) → string | null`. The fake models WhatsApp's server: `deliver(msg)` while connected emits at once and is then ACKED (gone from the server); while offline it is held and emitted on the next `open`. It records `sent` and `typing`, and learns `mapLid(pn, lid)`. The adapter maps `messages.upsert` to `WaInbound` (`inboundOf`, pure, tested on library-shaped objects: `remoteJid`/`remoteJidAlt`, `messageStubType` 2 = unreadable, `conversation`/`extendedTextMessage.text`, `pushName`, `type: "notify"` = live) and forwards the three calls through the worker.
- [ ] Failing tests, implement, run, commit.

### Task 4: The persisted inbox

**Files:** Create `src/wa-inbox.ts`; Test `test/wa-inbox.test.ts`.

**Produces:** `openInbox(file)` → `{ seen(id), add(entry) → boolean (false = already seen), ack(id), pending() }`, written atomically (0600) on every change; seen ids capped (oldest dropped), pending entries never dropped by the cap. Lives in `~/.shadok-ai/whatsapp-state/<instanceKey>/inbox.json`, beside the session directory and not in it: Link wipes the session, and the agents (and their pending messages) are not the session's.
- [ ] Failing tests: add → pending; ack → gone; reopen from disk keeps both; a seen id is refused after a reopen; the cap keeps pending entries; a corrupt file opens empty (and says so) rather than throwing.
- [ ] Implement, run, commit.

### Task 5: The handle carries messages

**Files:** Modify `src/whatsapp.ts`; Test `test/whatsapp-handle.test.ts` (extend).

**Produces:** `WhatsAppHandle` gains `onMessage(cb)`, `account()` (the linked account key, also while reconnecting or halted, from the stored session), `sendText`, `setTyping`, `resolveLid` — each rejecting when no transport is connected — and `whenConnected(ms)`.
- [ ] Failing tests (message reaches the listener only from the current transport; send rejects while reconnecting and goes through once connected), implement, commit.

### Task 6: Shared guest rules

**Files:** Modify `src/tg-guests.ts`, `src/config.ts`; Test `test/guest-membership.test.ts` (new — Telegram's own test files are not edited).

**Produces:** `guestPatchFlow` takes an optional `other?: GuestSetup` (the other bridge's setup). A membership this flow would take back is KEPT when the other open setup targets the same group, and the result says `handOver: true` so the caller gives the other setup `joined`. Config gains `whatsappGuests[cwd]`, read by `waGuestSetupForCwd` (mode `dm-only` | `group` only) and written by `setWaGuestSetupForCwd`.
- [ ] Failing tests: closing Telegram while WhatsApp targets the group keeps the instance in it and hands over; closing the second removes it; WhatsApp alone opening `dm-only` behaves like Telegram's; with no `other`, the result is identical to today's.
- [ ] Implement, run, commit.

### Task 7: Channels, origins, server

**Files:** Modify `src/channels.ts`, `src/promptmeta.ts`, `src/accounts.ts`, `src/secret-audit.ts`, `src/server.ts`; Tests `test/channels.test.ts` (extend), `test/wa-origin.test.ts`, `test/whatsapp-routes.test.ts` (extend).

- `Channel.whatsapp` server-owned; `mergeChannels` keeps a WhatsApp-bound row the client omitted; `isMirrored` is false for one; `channelForWhatsApp`.
- `connectionOrigin` learns `whatsappBridge` → `whatsapp`; `promptAuthor` believes `from` for it; `spawnActor` credits `whatsapp <name>`.
- Server: `WHATSAPP_BRIDGE_SECRET`; the `start` handler passes `fromBridge` for either bridge and the setup of the bridge the socket proved; the work dir is `waGuestWorkDirName` for WhatsApp; the prompt handler refuses a slash command from `whatsapp` (`code: "command-refused"`), adds the header for it, honours `voice` for it; `GET /whatsapp` adds `guests` + `guestGroups`; `PUT /whatsapp/guests` (admin, browser-only, refused while the feature is unavailable) runs `guestPatchFlow` with `other`; the bridge starts with the handle.
- [ ] Failing tests, implement, run, commit.

### Task 8: The bridge

**Files:** Create `src/wa-bridge.ts`; Test `test/wa-bridge.test.ts`.

**Produces:** `startWaBridge({ handle, connect, setup, channels, inbox, log })`. Per inbound text: filter → door → dedup + inbox → canonical sender (resolving a PN-only address through the transport, then re-keying a PN-bound row to the LID) → that person's bridge (resume from the registry, else a guest spawn with `guest: true, guestKey: <id>, name`) → prompt (neutralised). On `ready` the row gets its `whatsapp` binding (and the pushName as its name, once). `stream-text` → `mdToWhatsApp` → chunks through one send queue per person with a small spacing, waiting for a reconnect (bounded) rather than dropping. `working` → typing; `turn-done`/`dialog`/`exited` → stop. `busy` → `shouldPreempt`, as Telegram. `prompt-echo` → `promptEchoLabel` + text, attachment markers stripped. `dialog` → the question as plain text and the `no-keyboard` notice (numbered answers are step 3); a reply while it is up dismisses it first. `stopped` → the bridge closes; the next message spawns afresh. Inbox entries are acked on the matching `prompt-id` (or the turn's end); a refusal that loses the message acks it and says so through `guestNotice`. Reattach every 5 s (and at start) for bound channels of the linked account whose agent is alive, probing only when no bridge exists. Pending inbox entries are replayed at start and on every reconnect.
- [ ] Failing end-to-end tests against the fake transport and a fake server socket: first message spawns as a guest with the WhatsApp key; the second reaches the same bridge; PN-then-LID lands on one agent; door shut = no socket opened and nothing sent; restart before `prompt-id` replays once, after it never; `stopped` then a message → a fresh spawn; an answer is formatted and sent only to the binding; `/clear` reaches the server neutralised.
- [ ] Implement, run, commit.

### Task 9: The panel and the tab

**Files:** Modify `public/wa-panel.js`, `public/index.html`; Tests `test/wa-panel.test.ts` (extend).

- The open-DM block below the state when a number is linked: on/off switch, restricted group, profile, Save — same pickers and refusals as Telegram's.
- A WhatsApp-bound tab shows a WhatsApp mark and offers no "Mirror to Telegram".
- [ ] Failing tests for `waGuestsModel`, implement, verify in a browser (side instance, `SHADOK_WA_FAKE=1`): link → connected → open the door → a fake inbound message spawns an agent in the group → its answer is recorded as sent → a second message lands on the same agent → restart the side server → a message held meanwhile is answered. Screenshots read back, console captured.

### Task 10: Docs

README (WhatsApp section: guests, the door, what a guest can and cannot do), `docs/architecture.md` (the bridge, the binding, the inbox, module rows, `/ws` + HTTP reference), `docs/invariants.md` (one binding field per transport; a bridge with no dispatcher still owes the command refusal) + the `CLAUDE.md` index lines, the pilot prompt's `whatsapp` platform line, the spec's status line.

## After the last task

One PR against `main`, label `hold`. The body says what was verified with the fake transport and that a real number has NOT been exercised by this PR.
