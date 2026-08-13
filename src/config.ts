import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  /** Optional GUI password (also settable via SHADOK_GUI_PASSWORD). */
  guiPassword?: string;
  /**
   * Auto-apply a newer npm release (GUI checkbox). Authoritative once set;
   * when unset the server falls back to the SHADOK_AUTOUPDATE env var.
   */
  autoUpdate?: boolean;
  /**
   * Permission mode every spawned agent starts in (a `claude --permission-mode`
   * value: "auto" | "acceptEdits" | "manual" | "plan" | "dontAsk" |
   * "bypassPermissions", or "default" for no flag). Authoritative once set;
   * else the SHADOK_PERMISSION_MODE env var, else the built-in default "auto"
   * (the Shift+Tab "auto mode on").
   */
  permissionMode?: string;
  /**
   * Fuseau IANA par défaut des crons `daily` (« Europe/Paris »). Sans lui,
   * l'heure suit le fuseau de la machine — un serveur en UTC décale donc tous
   * les horaires sans rien dire. Un cron peut le surcharger via son `tz`.
   */
  timezone?: string;
  /**
   * Per launch-directory cockpit name, keyed by absolute cwd. Shown in the
   * header brand and the browser tab so several cockpits (one per directory)
   * stay distinguishable. Absent = the default "shadok-ai".
   */
  cockpitTitle?: Record<string, string>;
  /**
   * Per launch-directory colour palette (an accent key like "emerald"), keyed by
   * absolute cwd. Absent = the default "amber". Like the name, it re-themes only
   * this instance and survives a reload.
   */
  cockpitTheme?: Record<string, string>;
}

export const SHADOK_DIR = path.join(os.homedir(), ".shadok-ai");
const CONFIG_FILE = path.join(SHADOK_DIR, "config.json");
const LEGACY_ENV = path.join(SHADOK_DIR, "telegram.env");

export function loadConfig(): Config {
  try {
    const v = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(SHADOK_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600); // the token is a secret; enforce 600
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
