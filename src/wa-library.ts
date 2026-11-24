import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The WhatsApp library, installed ON DEMAND.
 *
 * An instance that never links a number installs nothing: the app's own
 * package.json names no WhatsApp package, so neither `npx shadok-ai` nor the
 * auto-update fetches one. The first Link by an admin installs it here, into
 * the DATA directory (`~/.shadok-ai/whatsapp-lib/<fingerprint>/`, on the
 * volume) — never into the app's node_modules, which the updater rewrites.
 *
 * What gets installed is decided by the release, not at runtime: the shipped
 * directory (`context/whatsapp-lib/`) holds a package.json with EXACT versions
 * — the one place they are pinned — and an npm-shrinkwrap.json that pins the
 * whole transitive tree by integrity. `npm ci` installs exactly that tree or
 * fails (EINTEGRITY); it never resolves a range. Shipped as a shrinkwrap rather
 * than a package-lock.json because npm's packer drops lockfiles by that name.
 *
 * Install scripts are OFF: the library's own `preinstall` only checks the Node
 * version, protobufjs's `postinstall` only prints a warning, and the native
 * bridge ships as WASM inside its JS. Peers are left out (`--legacy-peer-deps`):
 * the one required peer, sharp, is a native image library the library imports
 * lazily for thumbnails, and neither text, the QR nor a media download needs it.
 *
 * The directory is named after a fingerprint of the shipped files, so a
 * release that pins anything else finds the old copy STALE — it is never used,
 * and the next admin action installs the new one (then prunes the old).
 */

export const WA_LIB_SHIP_DIR = fileURLToPath(new URL("../context/whatsapp-lib/", import.meta.url));
export const SHIP_FILES = ["package.json", "npm-shrinkwrap.json", "load.mjs"] as const;
/** Written last into a complete install: a directory without it is not one. */
const MARKER = ".shadok-installed";
const ENTRY = "load.mjs";
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export function waLibRoot(home: string): string {
  return path.join(home, ".shadok-ai", "whatsapp-lib");
}

/** sha256 over the shipped files, names included. */
export function libFingerprint(shipDir: string): string {
  const h = crypto.createHash("sha256");
  for (const f of SHIP_FILES) {
    h.update(f + "\0");
    h.update(fs.readFileSync(path.join(shipDir, f)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

export type RunCommand = (cmd: string, args: string[], o: { cwd: string; timeoutMs: number }) => Promise<void>;

/** The real runner: rejects with `.stderr` (its tail), `.code` (a spawn error
 *  such as ENOENT) or `.timedOut`. */
export function spawnRunner(): RunCommand {
  return (cmd, args, { cwd, timeoutMs }) =>
    new Promise<void>((resolve, reject) => {
      let stderr = "";
      let timedOut = false;
      const child = spawn(cmd, args, {
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, npm_config_update_notifier: "false" },
      });
      child.stderr!.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) return reject(Object.assign(new Error("timed out"), { timedOut: true, stderr }));
        if (code === 0) return resolve();
        reject(Object.assign(new Error(`${path.basename(cmd)} exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`), { stderr }));
      });
    });
}

/** One line a person can act on: no network, no npm, a full disk… */
export function installFailureReason(err: unknown): string {
  const e = err as { code?: string; stderr?: string; timedOut?: boolean; message?: string };
  if (e?.timedOut) return `the install did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes`;
  if (e?.code === "ENOENT") return "npm is not installed on this machine (or not on the server's PATH)";
  const text = `${e?.stderr ?? ""}\n${e?.message ?? String(err)}`;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|network request/i.test(text))
    return "the npm registry could not be reached — is this machine online?";
  if (/ENOSPC|no space left/i.test(text)) return "the disk is full";
  if (/EACCES|EPERM|permission denied/i.test(text)) return "permission denied while writing the component";
  if (/EINTEGRITY/.test(text)) return "a downloaded package did not match its pinned checksum (EINTEGRITY) — nothing was installed";
  const lines = (e?.stderr ?? "")
    .split("\n")
    .map((l) => l.replace(/^npm (error|ERR!)\s*/i, "").trim())
    .filter((l) => l && !/complete log of this run|^code \w+$/i.test(l));
  const detail = (lines[0] ?? e?.message ?? String(err)).slice(0, 200);
  return `npm failed: ${detail}`;
}

export interface WaLibrary {
  /** A cheap look at the disk, no load. */
  status(): "ready" | "absent" | "stale";
  /** Single-flight: a call while one runs gets the same outcome. `force`
   *  replaces a ready copy (one that installed but would not load). */
  install(o?: { force?: boolean }): Promise<void>;
  /** The file URL of the loader inside the ready copy; throws otherwise. */
  entryUrl(): string;
}

export function makeWaLibrary(o: {
  root: string;
  shipDir?: string;
  run?: RunCommand;
  log?: (line: string) => void;
}): WaLibrary {
  const shipDir = o.shipDir ?? WA_LIB_SHIP_DIR;
  const run = o.run ?? spawnRunner();
  const log = o.log ?? ((l: string) => console.log(l));
  const fp = libFingerprint(shipDir);
  const finalDir = path.join(o.root, fp);
  let inFlight: Promise<void> | null = null;

  const complete = (dir: string) => {
    try {
      return fs.readFileSync(path.join(dir, MARKER), "utf8").trim() === path.basename(dir);
    } catch {
      return false;
    }
  };
  const installs = (): string[] => {
    try {
      return fs.readdirSync(o.root).filter((n) => !n.startsWith(".") && complete(path.join(o.root, n)));
    } catch {
      return [];
    }
  };

  function status(): "ready" | "absent" | "stale" {
    if (complete(finalDir)) return "ready";
    return installs().length ? "stale" : "absent";
  }

  function sweepLeftovers() {
    let names: string[] = [];
    try {
      names = fs.readdirSync(o.root);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.startsWith(".staging-") && !n.startsWith(".old-")) continue;
      const p = path.join(o.root, n);
      try {
        // A recent one may be ANOTHER server's install in progress (two
        // instances can share a home); a dead one is older than any install.
        if (Date.now() - fs.statSync(p).mtimeMs > INSTALL_TIMEOUT_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* gone meanwhile */
      }
    }
  }

  /** Everything the release pinned is what landed — npm ci should guarantee
   *  it; this is the cheap proof before the copy is ever loaded. */
  function verify(dir: string) {
    const deps = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).dependencies as Record<string, string>;
    for (const [name, want] of Object.entries(deps)) {
      let got = "missing";
      try {
        got = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8")).version;
      } catch {
        /* reported below */
      }
      if (got !== want) throw new Error(`the installed tree does not match the pinned versions: ${name} is ${got}, expected ${want}`);
    }
  }

  async function doInstall(force: boolean): Promise<void> {
    if (!force && complete(finalDir)) return;
    fs.mkdirSync(o.root, { recursive: true, mode: 0o700 });
    sweepLeftovers();
    const staging = path.join(o.root, `.staging-${fp}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    const started = Date.now();
    try {
      fs.mkdirSync(staging, { mode: 0o700 });
      for (const f of SHIP_FILES) fs.copyFileSync(path.join(shipDir, f), path.join(staging, f));
      log(`whatsapp: installing the WhatsApp library (${fp})…`);
      await run(
        "npm",
        ["ci", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--loglevel=error"],
        { cwd: staging, timeoutMs: INSTALL_TIMEOUT_MS },
      );
      verify(staging);
      fs.writeFileSync(path.join(staging, MARKER), fp + "\n");
      if (complete(finalDir)) {
        if (!force) return; // another server finished the same install first
        const old = path.join(o.root, `.old-${fp}-${crypto.randomBytes(4).toString("hex")}`);
        fs.renameSync(finalDir, old);
        fs.rmSync(old, { recursive: true, force: true });
      } else {
        fs.rmSync(finalDir, { recursive: true, force: true }); // an incomplete leftover
      }
      fs.renameSync(staging, finalDir);
      log(`whatsapp: WhatsApp library installed in ${Math.round((Date.now() - started) / 1000)} s`);
      // One version on disk: the copies older releases installed are dead weight.
      for (const n of installs()) if (n !== fp) fs.rmSync(path.join(o.root, n), { recursive: true, force: true });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  return {
    status,
    install(opts) {
      inFlight ??= doInstall(!!opts?.force)
        .catch((e) => {
          // The verify's own message is already a sentence; npm's needs reading.
          throw new Error(e instanceof Error && /^the installed tree/.test(e.message) ? e.message : installFailureReason(e));
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    entryUrl() {
      const st = status();
      if (st !== "ready")
        throw new Error(
          st === "stale"
            ? "the installed WhatsApp library is out of date (this release pins another version)"
            : "the WhatsApp library is not installed on this instance",
        );
      return pathToFileURL(path.join(finalDir, ENTRY)).href;
    },
  };
}
