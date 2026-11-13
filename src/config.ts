import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConfiguredBackend } from "./backend.js";
import {
  type GuestSetup,
  GUEST_SETUP_OFF,
  guestsOpen,
  normalizeGuestSetup,
  normalizeTgMode,
} from "./tg-guests.js";

/**
 * Global CLI config at ~/.shadok-ai/config.json (mode 600). The Telegram bot
 * token is **per launch directory** (`tokens[cwd]`), so each instance you run
 * from a different directory has its own bot — like the channel list. Port is
 * global.
 *
 * Per-cwd token semantics:
 *   undefined → never asked for this dir yet (first run should prompt)
 *   null      → asked and deliberately skipped (never prompt again)
 *   string    → the token
 */
export interface Config {
  port?: number;
  /** @deprecated legacy single global token — migrated into `tokens` on boot. */
  telegramToken?: string | null;
  /** Per launch-directory bot token, keyed by absolute cwd. */
  tokens?: Record<string, string | null>;
  /** Per launch-directory allowed Telegram chats (env TELEGRAM_ALLOWED_CHATS wins). */
  telegramAllowed?: Record<string, string[]>;
  /** Per launch-directory on/off switch for the Telegram bridge (default on). */
  telegramEnabled?: Record<string, boolean>;
  /**
   * Per launch-directory Telegram mode: where the bot works (`group`,
   * `group+dm`, `dm-only`), the restricted group guests' agents are born into,
   * and the profile they run on (`src/tg-guests.ts`). Absent = `group`, the
   * classic instance, which is every instance's default.
   *
   * `on` is the pre-mode spelling, still WRITTEN for one reason: a downgrade to
   * a server that only knows that field must not read an open instance as a
   * closed one.
   */
  telegramGuests?: Record<
    string,
    { mode?: string; on?: boolean; group?: string | null; profile?: string | null; joined?: boolean }
  >;
  /** Optional GUI password (also settable via SHADOK_GUI_PASSWORD). */
  guiPassword?: string;
  /**
   * Auto-apply a newer npm release (GUI checkbox). Authoritative once set;
   * when unset the server falls back to the SHADOK_AUTOUPDATE env var.
   */
  autoUpdate?: boolean;
  /**
   * Opt-in to the shared-ledger reflex (docs/.../2026-08-25-shared-ledger-design).
   * OFF by default: it appends a "verify status before you assert/act" paragraph
   * to EVERY agent's pilot prompt, a behavioural change that must be opt-in.
   * Falls back to the SHADOK_LEDGER env var when unset. Takes effect at an
   * agent's next (re)spawn.
   */
  ledgerEnabled?: boolean;
  /**
   * Which release stream to follow: "alpha" (every merge) or "beta" (only a
   * promoted version). Absent means "beta" — an instance that predates this
   * setting keeps updating, just on the calmer channel.
   * Design: docs/superpowers/specs/2026-08-23-update-channels-design.md
   */
  updateChannel?: "alpha" | "beta";
  /**
   * Permission mode every spawned agent starts in (a `claude --permission-mode`
   * value: "auto" | "acceptEdits" | "manual" | "plan" | "dontAsk" |
   * "bypassPermissions", or "default" for no flag). Authoritative once set;
   * else the SHADOK_PERMISSION_MODE env var, else the built-in default "auto"
   * (the Shift+Tab "auto mode on").
   */
  permissionMode?: string;
  /**
   * Default IANA time zone for `daily` crons ("Europe/Paris"). Without it the
   * hour follows the machine's zone — so a server running UTC shifts every
   * schedule silently. A cron can override it through its own `tz`.
   */
  timezone?: string;
  /**
   * Per launch-directory cockpit name, keyed by absolute cwd. Shown in the
   * header brand and the browser tab so several cockpits (one per directory)
   * stay distinguishable. Absent = the default "shadok-ai".
   */
  cockpitTitle?: Record<string, string>;
  /** Per launch dir: the instance context every agent gets (src/instance-context.ts). */
  instanceContext?: Record<string, string>;
  /**
   * Per launch-directory colour palette (an accent key like "emerald"), keyed by
   * absolute cwd. Absent = the default "amber". Like the name, it re-themes only
   * this instance and survives a reload.
   */
  cockpitTheme?: Record<string, string>;
  /**
   * Per launch-directory "mute the whole instance", keyed by absolute cwd.
   * `true` = every agent on this instance raises NO web attention signal: the
   * favicon never changes, no title badge, no blink, no chime. Absent/false =
   * the normal per-agent behaviour. It is the instance-wide twin of the
   * per-channel `Channel.muted`, shared across every tab and device like the
   * name and palette.
   */
  cockpitMuted?: Record<string, boolean>;
  /**
   * Per launch-directory agent auth mode (multi-tenant only), keyed by absolute
   * cwd. `"token"` (default, absent) = the ~1-year `setup-token`
   * (`MT_CLAUDE_OAUTH_TOKEN`) injected into every dropped agent — no claude.ai
   * connectors. `"login"` = no token injection; each OS user (commons `main` +
   * each private group's `sk-*`) does its own interactive `claude auth login`
   * once into its OWN home, so agents get the account's connectors (~1 month,
   * per-user reconnect). Cross-user credential sharing is never used (the refresh
   * rewrite is single-owner, see the design doc); only same-user agents share a
   * login, which they do natively. Takes effect at an agent's next (re)spawn.
   * Design: docs/superpowers/specs/2026-11-04-connectors-via-global-login-design.md
   */
  agentAuth?: Record<string, "token" | "login">;
  /**
   * Per launch-directory two-factor sign-in (a passkey after the password),
   * keyed by absolute cwd. Absent = off. Turned on from the Users panel, under
   * the rules of `twoFactorEnableVerdict`; removing the key by hand IS the
   * break-glass when every admin has lost their device (README).
   */
  twoFactor?: Record<string, true>;
  /**
   * Per launch-directory model backend chosen at onboarding (or from the
   * version menu), keyed by absolute cwd. Absent = the Claude subscription, or
   * whatever ANTHROPIC_BASE_URL shadok was launched with. When present it is
   * authoritative and REPLACES the environment wholesale — see src/backend.ts.
   * May hold an API key, which is one more reason this file is 600.
   */
  modelBackend?: Record<string, ConfiguredBackend>;
}

export const SHADOK_DIR = path.join(os.homedir(), ".shadok-ai");
const CONFIG_FILE = path.join(SHADOK_DIR, "config.json");
const LEGACY_ENV = path.join(SHADOK_DIR, "telegram.env");

/**
 * Read a config file. `unreadable` = the file EXISTS but is not a JSON object —
 * which is not the same thing as "no config", and must never be written over.
 */
export function readConfigFile(file: string): { cfg: Config; unreadable: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    // Absent is the fresh-install case: an empty config, safe to write.
    return { cfg: {}, unreadable: (e as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return { cfg: v, unreadable: false };
  } catch {
    /* fall through */
  }
  return { cfg: {}, unreadable: true };
}

/**
 * Write a config file ATOMICALLY (temp file + rename), and never over a file
 * that exists but does not parse. Returns false when the write was refused.
 *
 * Both halves close the same hole, the one that made every Telegram token, the
 * GUI password and the per-directory settings vanish at once. The old write was
 * `writeFileSync` in place: it truncates first, then fills. A read landing in
 * that window — the supervisor, a side-by-side build sharing the HOME, the
 * server's own next request — or a machine stopping mid-write saw an empty or
 * half file; `loadConfig` read that as `{}`, and the next ordinary save (a
 * title, a mute, an instance context) persisted `{}` plus its one field over
 * the real config. The rename makes a torn file impossible; the refusal keeps a
 * file corrupted any other way (a bad hand edit) from being replaced by an
 * almost-empty one — invariant 6's rule, for the config.
 */
export function writeConfigFile(file: string, cfg: Config): boolean {
  if (readConfigFile(file).unreadable) {
    console.error(`config: ${file} exists but cannot be read as JSON — NOT overwritten; fix or remove it`);
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // the token is a secret; enforce 600 even under a loose umask
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return true;
}

export function loadConfig(): Config {
  return readConfigFile(CONFIG_FILE).cfg;
}

export function saveConfig(cfg: Config): void {
  writeConfigFile(CONFIG_FILE, cfg);
}

/** This directory's token entry (undefined = never asked). */
export function tokenForCwd(cfg: Config, cwd: string): string | null | undefined {
  return cfg.tokens?.[cwd];
}

export function setTokenForCwd(cfg: Config, cwd: string, token: string | null): void {
  (cfg.tokens ??= {})[cwd] = token;
  saveConfig(cfg);
}

/**
 * The effective token for an instance launched in `cwd`: an explicit env var
 * always wins, otherwise this directory's configured token. No global fallback —
 * a different directory gets a different bot (or none).
 */
export function effectiveToken(cfg: Config, cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TELEGRAM_BOT_TOKEN) return env.TELEGRAM_BOT_TOKEN;
  return cfg.tokens?.[cwd] ?? null;
}

/** This directory's cockpit name, or null when none is set (→ default brand). */
export function titleForCwd(cfg: Config, cwd: string): string | null {
  const t = cfg.cockpitTitle?.[cwd];
  return t && t.trim() ? t.trim() : null;
}

/** This directory's instance context, "" when unset (src/instance-context.ts). */
export function instanceContextForCwd(cfg: Config, cwd: string): string {
  return cfg.instanceContext?.[cwd]?.trim() ?? "";
}

/** Pure: set (or, with "", remove) this directory's instance context on `cfg`. */
export function applyInstanceContext(cfg: Config, cwd: string, text: string): Config {
  const t = text.trim();
  cfg.instanceContext ??= {};
  if (t) cfg.instanceContext[cwd] = t;
  else delete cfg.instanceContext[cwd];
  return cfg;
}

/** Set (or clear) this directory's instance context and persist. */
export function setInstanceContextForCwd(cfg: Config, cwd: string, text: string): void {
  saveConfig(applyInstanceContext(cfg, cwd, text));
}

/**
 * Set (or clear) this directory's cockpit name and persist. An empty/blank
 * title removes the entry so the cockpit falls back to the default brand.
 */
export function setTitleForCwd(cfg: Config, cwd: string, title: string): void {
  const t = title.trim();
  cfg.cockpitTitle ??= {};
  if (t) cfg.cockpitTitle[cwd] = t;
  else delete cfg.cockpitTitle[cwd];
  saveConfig(cfg);
}

/** Known colour palettes; the first, "amber", is the default (stored as absent). */
export const COCKPIT_THEMES = ["amber", "emerald", "azure", "violet", "rose", "cyan"] as const;

/** This directory's palette key, or null for the default ("amber"). */
export function themeForCwd(cfg: Config, cwd: string): string | null {
  const t = cfg.cockpitTheme?.[cwd];
  return t && t !== "amber" && (COCKPIT_THEMES as readonly string[]).includes(t) ? t : null;
}

/**
 * Set (or clear) this directory's palette and persist. The default ("amber") and
 * any unknown key clear the entry, so the instance falls back to the default.
 */
export function setThemeForCwd(cfg: Config, cwd: string, theme: string): void {
  const t = (theme || "").trim();
  cfg.cockpitTheme ??= {};
  if (t && t !== "amber" && (COCKPIT_THEMES as readonly string[]).includes(t)) cfg.cockpitTheme[cwd] = t;
  else delete cfg.cockpitTheme[cwd];
  saveConfig(cfg);
}

/** Is this whole instance muted (no web attention signal for any agent)? */
export function mutedForCwd(cfg: Config, cwd: string): boolean {
  return cfg.cockpitMuted?.[cwd] === true;
}

/**
 * Set (or clear) this directory's instance-wide mute and persist. `false`
 * removes the entry — the default is "not muted", stored as absent.
 */
export function setMutedForCwd(cfg: Config, cwd: string, on: boolean): void {
  cfg.cockpitMuted ??= {};
  if (on) cfg.cockpitMuted[cwd] = true;
  else delete cfg.cockpitMuted[cwd];
  saveConfig(cfg);
}

/**
 * This instance's agent auth mode: `"login"` only when explicitly set, else
 * `"token"` (the default and today's behaviour). Any unknown value reads as
 * `"token"` — a malformed config never silently switches auth.
 */
export function agentAuthForCwd(cfg: Config, cwd: string): "token" | "login" {
  return cfg.agentAuth?.[cwd] === "login" ? "login" : "token";
}

/**
 * Set (or clear) this directory's agent auth mode and persist. `"token"` (the
 * default) removes the entry, so the instance falls back to it.
 */
export function setAgentAuthForCwd(cfg: Config, cwd: string, mode: "token" | "login"): void {
  cfg.agentAuth ??= {};
  if (mode === "login") cfg.agentAuth[cwd] = "login";
  else delete cfg.agentAuth[cwd];
  saveConfig(cfg);
}

/** The model backend chosen for the instance launched in `cwd`, or null. */
export function backendForCwd(cfg: Config, cwd: string): ConfiguredBackend | null {
  return cfg.modelBackend?.[cwd] ?? null;
}

/** Set (or clear, with null) that backend and persist. */
export function setBackendForCwd(cfg: Config, cwd: string, b: ConfiguredBackend | null): void {
  cfg.modelBackend ??= {};
  if (b) cfg.modelBackend[cwd] = b;
  else delete cfg.modelBackend[cwd];
  saveConfig(cfg);
}

/** Is two-factor sign-in on for the instance launched in `cwd`? */
export function twoFactorForCwd(cfg: Config, cwd: string): boolean {
  return cfg.twoFactor?.[cwd] === true;
}

export function setTwoFactorForCwd(cfg: Config, cwd: string, on: boolean): void {
  cfg.twoFactor ??= {};
  if (on) cfg.twoFactor[cwd] = true;
  else delete cfg.twoFactor[cwd];
  saveConfig(cfg);
}

export interface TelegramConfig {
  token: string | null; // effective token (env override wins)
  envOverride: boolean; // token came from TELEGRAM_BOT_TOKEN
  enabled: boolean; // bridge on/off (default true)
  allowedChats: string[]; // env override wins if TELEGRAM_ALLOWED_CHATS set
}

/** Resolve the effective Telegram config for `cwd`: env overrides config. */
export function telegramConfig(cfg: Config, cwd: string, env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const envTok = env.TELEGRAM_BOT_TOKEN;
  const token = envTok ?? cfg.tokens?.[cwd] ?? null;
  const envChats = env.TELEGRAM_ALLOWED_CHATS;
  const allowedChats = envChats
    ? envChats.split(",").map((s) => s.trim()).filter(Boolean)
    : cfg.telegramAllowed?.[cwd] ?? [];
  return {
    token,
    envOverride: Boolean(envTok),
    enabled: cfg.telegramEnabled?.[cwd] ?? true,
    allowedChats,
  };
}

/**
 * This directory's Telegram mode and open-DM setup — the classic `group`
 * whenever the row is absent or malformed.
 *
 * The file is hand-editable, so a half-written row must read as the classic
 * instance rather than throw or — far worse — open the bot's DMs with a group
 * it cannot honour (`normalizeGuestSetup` holds that solidarity rule).
 *
 * A row written before the mode existed carries `on` instead: `on: true` was
 * exactly today's `group+dm`, so it is read as one. That migration is a READ,
 * not a rewrite — nothing touches the file until the panel saves.
 */
export function guestSetupForCwd(cfg: Config, cwd: string): GuestSetup {
  const row = cfg.telegramGuests?.[cwd];
  if (!row || typeof row !== "object") return { ...GUEST_SETUP_OFF };
  const group = typeof row.group === "string" && row.group.trim() ? row.group.trim() : null;
  const profile = typeof row.profile === "string" && row.profile.trim() ? row.profile.trim() : null;
  const mode = row.mode === undefined && row.on === true ? "group+dm" : normalizeTgMode(row.mode);
  return normalizeGuestSetup({ mode, group, profile, joined: row.joined === true });
}

/**
 * Pure: set this directory's Telegram mode and open-DM setup on `cfg` (caller
 * persists).
 *
 * The group and the profile are kept when the mode goes back to `group`, so
 * re-opening needs no retyping — and clearing them is done by saving them as
 * null, never as a side effect of changing mode.
 */
export function applyGuestSetup(cfg: Config, cwd: string, s: GuestSetup): Config {
  cfg.telegramGuests ??= {};
  // `on` rides along for a server that predates the mode: see the field's doc.
  cfg.telegramGuests[cwd] = {
    mode: s.mode,
    on: guestsOpen(s),
    group: s.group,
    profile: s.profile,
    ...(s.joined ? { joined: true } : {}),
  };
  return cfg;
}

/** Set this directory's Telegram mode and open-DM setup, and persist. */
export function setGuestSetupForCwd(cfg: Config, cwd: string, s: GuestSetup): void {
  saveConfig(applyGuestSetup(cfg, cwd, s));
}

export interface TelegramPatch {
  token?: string | null;
  enabled?: boolean;
  allowedChats?: string[];
}

/**
 * Merge a UI patch into a copy of `cfg` (pure — caller persists). A token is
 * stored only when NOT under an env override; "" / null removes it. Absent keys
 * are left untouched.
 */
export function applyTelegramPatch(cfg: Config, cwd: string, patch: TelegramPatch, envOverride: boolean): Config {
  const next: Config = {
    ...cfg,
    tokens: { ...cfg.tokens },
    telegramAllowed: { ...cfg.telegramAllowed },
    telegramEnabled: { ...cfg.telegramEnabled },
  };
  if (patch.token !== undefined && !envOverride) {
    next.tokens![cwd] = patch.token ? patch.token : null;
  }
  if (patch.enabled !== undefined) next.telegramEnabled![cwd] = patch.enabled;
  if (patch.allowedChats !== undefined) next.telegramAllowed![cwd] = patch.allowedChats;
  return next;
}

/** Pull TELEGRAM_BOT_TOKEN out of a shell-style env file body. */
export function parseLegacyToken(raw: string): string | null {
  const m = raw.match(/TELEGRAM_BOT_TOKEN\s*=\s*["']?([^"'\s]+)/);
  return m ? m[1] : null;
}

/**
 * One-time migration of the OLD global token (the `telegram.env` file and the
 * legacy `telegramToken` config field, both global) into this directory's token
 * — but only for an already-established instance (`established`, i.e. it has a
 * bound Telegram group), so an existing setup keeps its bot while a brand-new
 * directory is prompted for its own. Both global sources are consumed (env file
 * renamed, config field deleted) so they never leak to another directory.
 */
export function migrateLegacyToken(cfg: Config, cwd: string, established: boolean): void {
  if (cfg.tokens?.[cwd] !== undefined || !established) return;
  let token: string | null = null;
  try {
    token = parseLegacyToken(fs.readFileSync(LEGACY_ENV, "utf8"));
  } catch {
    /* no env file */
  }
  if (!token && typeof cfg.telegramToken === "string") token = cfg.telegramToken;
  if (!token) return;
  (cfg.tokens ??= {})[cwd] = token;
  delete cfg.telegramToken; // consume the global field
  try {
    fs.renameSync(LEGACY_ENV, LEGACY_ENV + ".migrated"); // consume the global file
  } catch {
    /* best effort */
  }
  saveConfig(cfg);
}
