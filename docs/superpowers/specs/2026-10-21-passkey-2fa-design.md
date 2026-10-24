# Two-factor sign-in with a passkey — design

## Intent

A web account's password alone opens the cockpit, and a cockpit can spawn
agents, i.e. run code on the machine. The request: a **second factor that is
biometric** (Face ID / Touch ID / Windows Hello / an Android fingerprint), so a
leaked password is no longer enough.

What was asked, in the requester's words, and how each is read:

| Asked | Reading |
|---|---|
| "a biometric brick for 2FA" | WebAuthn **passkeys** with `userVerification: "required"` — the platform authenticator does the biometric check; we never see a fingerprint. |
| "if you lose one of the two, the other admins reset your password" | Lost password OR lost device → **another** admin issues a reset. Nobody unlocks themselves. |
| "at least 2 users" | At least **2 admins** (confirmed): with one, losing their device locks the cockpit for good. |
| "activated in the workspace settings" | A per-instance switch (per launch dir, like `cockpitTitle`), shown in the Users panel to admins. "Workspace" = this cockpit instance. |
| "add a biometric device from another device" | A device already signed in with 2FA issues a short-lived **enrollment code** that lets a new device register its passkey. |

Success:
- with 2FA on, a correct password without the passkey step gets no session;
- an admin who loses their phone is back in after another admin resets them;
- adding a laptop from a phone takes one code, no admin involved;
- agents, Telegram and peers keep working, untouched.

## Threat model — what this does and does not stop

**Stops:** someone who has a user's password (phished, reused, shoulder-surfed)
and reaches the cockpit over the network; a stolen pre-2FA cookie once 2FA is
on.

**Does not stop, by construction:** anything running as the machine's OS user.
Every agent can read `~/.shadok-ai/users/*.json` and the signing key, and holds
`SHADOK_GUI_PASSWORD` in its env (measured, see `accounts.ts`). That is the same
soft isolation as profiles (invariant 26). The design removes the *documented*
paths an agent could use (below), not the filesystem.

## Design

### 1. Storage

On `Account` (`~/.shadok-ai/users/<key>.json`, 600):

```ts
passkeys?: {
  id: string;            // credential id, base64url
  publicKey: string;     // COSE key, base64url
  counter: number;
  transports?: string[];
  label: string;         // "iPhone", "MacBook" — named by the user at enrollment
  createdAt: number;
  lastUsedAt?: number;
}[];
enroll?: { code: string; expiresAt: number; by: string; reset?: true };
```

The switch: `twoFactor?: Record<cwd, true>` in `config.json`
(`twoFactorForCwd` / `setTwoFactorForCwd`), same shape as `cockpitTitle`.

### 2. Library

`@simplewebauthn/server` (attestation/assertion verification, COSE, CBOR) and
`@simplewebauthn/browser`, served at `/vendor/simplewebauthn.js` like
`marked`. Hand-rolling WebAuthn verification is exactly the code nobody should
write twice; both are maintained and dependency-light.

RP ID = the request's hostname, origin = the page's own origin (checked against
`Host` + `EXTRA_ORIGINS`, like `originAllowed`). Consequence, stated in the UI:
a passkey made on `cockpit.example.com` does not work on `localhost`.

### 3. Sign-in

With 2FA **off**: unchanged.

With 2FA **on**:

1. `POST /login` with a correct password no longer sets `sk_auth`. It sets
   `sk_pending` (HttpOnly, SameSite=Strict, 5 min, signed, carries the user) and
   answers `{ next: "passkey" }` — or `{ next: "enroll" }` if the account has no
   passkey yet.
2. `POST /login/passkey/options` → a challenge (single-use, 2 min, kept in
   memory keyed by the pending token) listing that user's credential ids.
3. `POST /login/passkey` with the assertion → verified, counter updated →
   `sk_auth` is set, **marked as second-factor verified**.

The cookie gains a 4th field: `<user>.<issuedAt>.<mfa>.<mac>` with `mfa` = `1`
or `0`. `currentAccount` refuses a cookie with `mfa=0` while 2FA is on. Every
cookie issued before activation is therefore dead the moment it is switched on
— including any leaked one. (Old 3-field cookies read as `mfa=0`.)

**The bootstrap admin (`SHADOK_GUI_PASSWORD`) cannot sign in to the browser
while 2FA is on.** It is in every agent's env, it lives in no account file, and
no other admin can reset it — it fits none of the rules. The login page says:
"two-factor is on — sign in with your named account". It still switches the
door on (no password → no auth at all, unchanged).

Agents are untouched: they authenticate with `x-shadok-session-key`, never the
login. `SHADOK_AUTH` (the bootstrap cookie in their env, `mfa=0`) stops working
under 2FA — every current skill already uses the session key (invariant 33); an
agent that predates that needs the one reload it already needed.
Telegram and peers do not go through the login and are unchanged.

### 4. Adding a device (from another device)

On a signed-in, verified device: Users panel → **Add a device** →
`POST /2fa/enroll-code` → an 8-character code (and a link `/enroll#<code>`),
**10 minutes, single use**, stored on the account.

On the new device: password → `{ next: "enroll" }` (or "use a code" if it
already has passkeys elsewhere) → the code → `POST /2fa/register/options` →
the platform prompts for the biometric → `POST /2fa/register` → passkey saved
with the label typed by the user, code consumed, session issued with `mfa=1`.

The code is the second factor for that one sign-in: password + a code that
only a verified device could mint. A password alone can never register a
passkey while 2FA is on — otherwise a stolen password would enroll the
attacker's own phone, and the whole feature would be decoration.

(Bonus, free: a browser that supports hybrid transport also offers "use a phone
or tablet" with a QR code at step 3.2, signing in with the phone's passkey. We
do nothing for it.)

### 5. Lost password or lost device → another admin resets

Users panel, on someone else's row: **Reset access**. It:

- requires the acting admin to **confirm with their own passkey right then**
  (a fresh assertion, not just their session). That is what keeps an agent, a
  forged `Origin`, or a CSRF from resetting anyone;
- refuses when actor == target ("ask another admin");
- removes the target's password and every passkey, and issues a reset link
  `/invite/<token>` (the existing invitation mechanism, 7 days). The invited
  page now also asks for the passkey after the password, enrollment authorised
  by that link.

The admin hands the link over by another channel, as today for invitations.
Revoking a single lost device (keeping the others) is a delete button on each
passkey of your own list; an admin can delete one of someone else's with the
same passkey confirmation.

### 6. The switch

Users panel (admins) → **Two-factor sign-in**. Turning it **on** is refused,
with the reason shown, unless:

- at least **2 named admins** exist (the bootstrap admin does not count), and
- **each of them has at least one passkey** — passkeys can be enrolled while
  2FA is still off, from the same panel ("Set up my passkey"), and
- the acting admin confirms with their passkey, and
- the page is a secure context (`https://` or `localhost`) — checked client-side
  (`window.isSecureContext`), since browsers expose WebAuthn nowhere else.

Members without a passkey at activation are not locked out of the account: they
get `{ next: "enroll" }` and need a code from an admin (Users panel → **Enrollment
code** on their row, same code as §4, minted by an admin for someone else).

Turning it **off**: an admin, with a passkey confirmation.

The pure rule lives in `twoFactorVerdict({ admins, actor, … })` — tested, one
place, like `userWriteVerdict`.

Also guarded while 2FA is on: demoting or deleting an admin is refused when it
would leave fewer than 2 admins with a passkey.

### 7. Who may call what

Every 2FA and account-management endpoint (`/users*`, `/2fa/*`) requires, when
2FA is on, a **cookie session with `mfa=1`** — not the session key, not a peer.
Today an agent's session key IS the bootstrap admin and can create users;
under 2FA it no longer can. Off, nothing changes.

### 8. Break-glass

All admins lose everything at once: whoever has a shell on the machine removes
`twoFactor[<cwd>]` from `~/.shadok-ai/config.json` and restarts. Documented in
the README. That person could read every secret anyway — it is not a new hole.

## Out of scope

TOTP / authenticator apps, SMS, recovery codes, 2FA for Telegram (its
`allowed chats` is the gate there), per-member opt-out.

## Tests

- Pure: `twoFactorVerdict` (every refusal), cookie `mfa` field round trip and
  old-cookie reading, enrollment code single-use / expiry / wrong user,
  reset refusals (self, no fresh assertion).
- HTTP, real server on a free port: with 2FA on, password-only gets no
  `sk_auth`; bootstrap password refused; session key cannot `POST /users`; a
  pre-activation cookie is refused.
- WebAuthn end to end in Playwright Chromium with a **virtual authenticator**
  (CDP `WebAuthn.addVirtualAuthenticator`, `isUserVerified: true`): enroll,
  enable, sign in, add a second device with a code, reset by a second admin,
  sign back in. Screenshots read back.

## Docs

README (feature, threat model, break-glass, HTTPS requirement), CLAUDE.md
(module row for `src/twofactor.ts`, endpoints, an invariant: "a password alone
never registers a passkey"), `docs/architecture.md` Auth section.
