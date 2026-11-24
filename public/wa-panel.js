// The WhatsApp panel's whole decision: what ONE link state shows.
//
// Loaded as is by the browser (ESM, bridged on `window`) and imported by the
// node/tsx tests, like public/notify.js. It knows nothing of the DOM: it is
// handed the server's view (`GET /whatsapp`, shaped by `linkView` in
// src/wa-link.ts) and returns a tone, a status line, the blocks to show and
// the buttons to offer. index.html only toggles elements by those names.
//
// The panel shows exactly one state at a time, and every state must be the
// truth: an unknown or missing view is UNAVAILABLE, never "Not linked" — a
// Link button over a state we do not understand would be a door that 409s.

/** "6 min ago", from `now` — the panel re-renders on every poll, so this stays live. */
export function agoText(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "less than a minute ago";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function inText(ms) {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  return m <= 1 ? "less than a minute" : `${m} min`;
}

function who(account) {
  if (!account) return "an unknown account";
  const name = account.name ? String(account.name) : "";
  const phone = account.phone ? `+${String(account.phone).replace(/^\+/, "")}` : "";
  if (name && phone) return `${name} · ${phone}`;
  return name || phone || "an unknown account";
}

/**
 * @param {Record<string, any> | null | undefined} view
 * @param {number} now
 * @returns {{ tone: "off"|"wait"|"ok"|"err", status: string, blocks: string[], actions: string[], text: Record<string, string> }}
 */
export function waPanelModel(view, now) {
  const v = view && typeof view === "object" ? view : {};
  const m = phaseModel(v, now);
  // A stored session is the account's credential: whatever the phase says —
  // unavailable included, where agents may run as the server's own user — the
  // admin must be able to delete it. Linking is the one exception (Cancel
  // already removes what it made).
  if (v.stored === true && v.phase !== "linking" && !m.actions.includes("unlink")) m.actions.push("unlink");
  return m;
}

/** Measured: a cold `npm ci` of the pinned tree, on disk. Said before the
 *  first Link, so a person knows what that click fetches. */
const LIB_SIZE = "about 35 MB";

function phaseModel(v, now) {
  switch (v.phase) {
    case "unlinked": {
      // The library is installed on demand: the first Link fetches it first.
      if (v.library === "absent" || v.library === "stale")
        return {
          tone: "off",
          status: "Not linked",
          blocks: ["intro", "download", "warning"],
          actions: ["link"],
          text: {
            download:
              v.library === "stale"
                ? `This release pins another version of the WhatsApp library: Link downloads it first (${LIB_SIZE}) — it can take a minute.`
                : `The first Link downloads the WhatsApp library (${LIB_SIZE}, pinned by this release) — it can take a minute.`,
          },
        };
      return { tone: "off", status: "Not linked", blocks: ["intro", "warning"], actions: ["link"], text: {} };
    }

    case "installing":
      // No action: a click here could only start the same install again.
      return {
        tone: "wait",
        status: "Installing the WhatsApp library…",
        blocks: v.account ? ["identity", "installing"] : ["installing"],
        actions: [],
        text: {
          ...(v.account ? { identity: who(v.account) } : {}),
          installing: `Downloading the pinned WhatsApp library with npm (started ${agoText(v.startedAt, now)}) — it can take a minute. ${
            v.then === "resume" ? "The stored session reconnects once it is done." : "The QR code follows once it is done."
          }`,
        },
      };

    case "linking": {
      const left = typeof v.expiresAt === "number" ? ` · expires in ${inText(v.expiresAt - now)}` : "";
      if (typeof v.qrError === "string" && v.qrError)
        // A code exists but cannot be drawn: say so now, not after three minutes.
        return { tone: "err", status: "A code is ready but cannot be shown" + left, blocks: ["reason"], actions: ["cancel"], text: { reason: v.qrError } };
      const hasQr = typeof v.qrSvg === "string" && v.qrSvg !== "";
      return {
        tone: "wait",
        status: (hasQr ? "Scan this code with WhatsApp" : "Linking — waiting for a code…") + left,
        blocks: hasQr ? ["qr", "steps"] : ["steps"],
        actions: ["cancel"],
        text: {},
      };
    }

    case "connected":
      return {
        tone: "ok",
        status: "Connected",
        blocks: ["identity", "since", "warning"],
        actions: ["unlink"],
        text: {
          identity: who(v.account),
          since: `linked ${agoText(v.linkedAt, now)} · connected ${agoText(v.connectedAt, now)}`,
        },
      };

    case "reconnecting":
      return {
        tone: "wait",
        status: "Reconnecting",
        blocks: ["identity", "lost", "warning"],
        actions: ["unlink"],
        text: {
          identity: who(v.account),
          // Attempt 0 is a boot resuming the stored session: nothing was lost.
          lost: v.attempt > 0 ? `connection lost ${agoText(v.lostAt, now)}, retrying` : "connecting with the stored session…",
        },
      };

    case "logged-out":
      return {
        tone: "err",
        status: "Unlinked remotely",
        blocks: v.account ? ["identity", "removed"] : ["removed"],
        actions: ["relink", "unlink"],
        text: {
          ...(v.account ? { identity: who(v.account) } : {}),
          removed: `${v.detail ? String(v.detail) : "the session was closed by WhatsApp"} (${agoText(v.at, now)}). Nothing is received any more.`,
        },
      };

    case "halted":
      if (v.cause === "library")
        return {
          tone: "err",
          status: "WhatsApp library needed",
          blocks: v.account ? ["identity", "reason"] : ["reason"],
          actions: v.account ? ["install", "relink"] : ["install"],
          text: {
            ...(v.account ? { identity: who(v.account) } : {}),
            reason: `${typeof v.reason === "string" && v.reason ? v.reason : "the WhatsApp library is not available"} (${agoText(v.at, now)}).`,
          },
        };
      return {
        tone: "err",
        status: v.cause === "crash" ? "Stopped after a crash" : v.cause === "error" ? "Stopped — something failed" : "Stopped",
        blocks: v.account ? ["identity", "reason"] : ["reason"],
        actions: ["retry", "relink"],
        text: {
          ...(v.account ? { identity: who(v.account) } : {}),
          reason: `${typeof v.reason === "string" && v.reason ? v.reason : "the link stopped"} (${agoText(v.at, now)}). Nothing is retried on its own.`,
        },
      };

    case "unavailable":
    default:
      return {
        tone: "err",
        status: "Unavailable",
        blocks: ["reason"],
        actions: [],
        text: { reason: typeof v.reason === "string" && v.reason ? v.reason : "the WhatsApp state could not be read" },
      };
  }
}
