# Web Push: the cockpit on a phone's Home Screen, with notifications

**Status:** built.

## Problem

On a phone, the cockpit's attention signal does not reach anyone. That signal
is the title badge, the blinking favicon and the chime (`public/notify.js`),
and all three live inside the page. A phone suspends a backgrounded page within
seconds, so an agent blocked on a question waits until its person happens to
open the tab again. Telegram covers part of this, but only for the agents
mirrored there.

A native iOS app was considered and set aside. It would need APNs credentials
on every instance (or a central relay), an Apple Developer account, a Mac to
build on, and an App Store review that often refuses "a website in a box". The
web platform already has the needed piece. Since iOS 16.4, **a site added to
the Home Screen can receive Web Push**, and Chrome, Edge, Firefox and Android
have supported it for years.

## Design

### Server: push when an agent needs its person

Two events trigger a push, and both already have a single funnel:

- **A question.** `publishDialog`, after its `dialogKey` dedup, so the screen
  watcher's repeated polls cannot fire one push per frame. That gives one push
  per *new* question, whichever path raised it (invariant 21).
- **A finished turn.** The `turn-done` branch of `finishTurn`, skipped when the
  turn was silent (a cron that answered `NOTHING TO SHOW`).

`pushAttention` applies the same switches that silence the page: a muted agent
or a muted instance sends nothing, so "mute" means one thing everywhere. Each
device's **account** must still be able to see the agent **at send time**
(`canSeeSession`, multi-tenant only), because group membership changes after a
device subscribes. A deleted account's devices get nothing.

The payload is `{title, body, tag, url}`. The title is the agent's name plus
the cockpit's title. The body is a short preview (180 characters max) of the
question or of the last answer. The tag is `agent-<id>`, so a new notification
for the same agent *replaces* the previous one instead of piling up. The url is
`/#agent=<id>`. The `Topic` header does the same on the push service's side: a
phone that was offline for an hour gets one notification per agent, not sixty.

Delivery is fire-and-forget and never throws. A slow or broken push service
must not delay a turn. A `404`/`410` drops the subscription, so a dead device
does not cost one request per event forever.

### Protocol: `src/webpush.ts`, written on `node:crypto`

VAPID (RFC 8292) and `aes128gcm` encryption (RFC 8291) come down to one ECDH,
two HKDFs, one AES-GCM and one ES256 signature. The `web-push` package would
have added four transitive dependencies to do exactly that. Two checks pin
correctness:

- the **RFC 8291 Appendix A vector**, reproduced byte for byte;
- **Apple's live service**, which accepted the VAPID JWT. With a fake device
  token it answers `400 BadWebPushToken`, and with a mismatched key
  `403 BadJwtToken`. FCM and Mozilla answered `410`/`404` to fake endpoints,
  which `classifyPushStatus` reads as "dead device".

Apple requires a `sub` claim (`mailto:` or `https:`). It defaults to the
project's URL, so no personal address leaves the machine unless the operator
sets `SHADOK_PUSH_SUBJECT`.

### Storage: `src/push-store.ts`

`~/.shadok-ai/push/<instanceKey>.json` (mode 600) holds the instance's VAPID
key pair and its subscriptions. The file is per instance because a
subscription is bound to the key it was created with, and every instance is
its own origin. Each row records the account that subscribed it. The rows are
keyed by endpoint: one device notifies **one** account, the latest to subscribe
on it. Each account is capped at 10 devices, oldest dropped first. An
unreadable file gets fresh keys and an empty list: its devices were bound to
keys we can no longer prove, so they would fail anyway.

### Routes

- `GET /push`: the VAPID public key, plus the caller's own devices.
- `POST /push/subscribe`, `POST /push/unsubscribe`, `POST /push/test`:
  **browser-only** (`requestFromBrowser`), and refused to an agent. An agent
  has nothing to be woken for. More importantly, the endpoint comes from the
  request body, so letting a non-person register one would let it make the
  server POST anywhere. `parseSubscription` also only accepts the known push
  services over https, which closes that SSRF for people too.
  Unsubscribing requires the owning account.
- `/push/test` answers "did it work?" from the phone itself, with what each
  push service replied.

### Client

- **Installable.** A per-instance `/manifest.webmanifest`, named after the
  cockpit's title so three instances give three icons you can tell apart.
  It sits behind the gate and is linked with `crossorigin="use-credentials"`.
  Next to it: PNG icons in `public/icons/` (ungated: the OS fetches them,
  possibly without the cookie) and the `apple-*` meta tags iOS reads.
- **`public/sw.js`** does one job: show the notification, and open the agent
  on tap. If a cockpit is already open, it focuses it and posts the hash, so
  the page keeps its state. There is no fetch handler and no cache: an offline
  copy of a live view of running agents would be a lie. Every push shows a
  notification, even an unreadable one, because Safari revokes the
  subscription of a site whose pushes show nothing.
- **"Notify this device"** in the version menu. `pushManager.subscribe()` is
  the first call in the click handler: Safari refuses it once the gesture has
  been spent on another `await`. That is why a subscription bound to a stale
  key is cleared earlier, at render time. On iOS outside the Home Screen the
  checkbox is disabled, and the hint says how to install.
- **`#agent=<id>`** (no message) opens that agent, at boot and on
  `hashchange`. It is the companion of the message links in `deep-link.js`.

## Not in this version

- **No presence detection across devices.** If you are at your desk with the
  cockpit open, your phone still buzzes. Telling a person who is looking from
  one who is not needs the page to report focus to the server; that is a
  follow-up if the noise matters in practice.
- **No per-device level** ("questions only" vs "questions and answers").
  Muting an agent is the current lever.
- **Not covered by tests:** the click-to-subscribe flow in a real Safari, and
  delivery to a real device. Electron, the only browser available where this
  was built, has no push service. The server path was run end to end with a
  stand-in `claude` that raised a real question screen: the question was
  detected and pushed to Apple, which accepted the signature.
