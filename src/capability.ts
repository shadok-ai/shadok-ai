import { spawnSync } from "node:child_process";

/**
 * Deployment mode, decided ONCE at boot from what the server can really do.
 * Isolation between groups is only real when the server can provision an OS
 * user AND accounts exist; anything else must refuse it, never fake a wall.
 */
export type DeploymentMode = "multi-tenant" | "mono-tenant";

/** Accounts exist only when a GUI password is set (it is the admin account). */
export function accountsEnabled(guiPassword: string): boolean {
  return guiPassword.trim() !== "";
}

/**
 * Non-interactive sudo check. `-n` makes it fail instead of prompting, so the
 * probe can never hang a boot. Any error (no sudo binary, timeout) means "no".
 */
function defaultCanSudo(): boolean {
  try {
    const r = spawnSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 3000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Can this process create OS users FOR GROUP ISOLATION? Root, or passwordless
 * sudo — and only on Linux. The isolation is implemented with Linux-only tooling
 * (`useradd`, `setpriv`, `runuser`); on macOS or Windows it cannot work, so a
 * host there must never auto-enable multi-tenant. Without this gate, a Mac
 * running as root (or with cached/passwordless sudo) plus a GUI password flipped
 * to multi-tenant and failed the boot migration on the very first `useradd`,
 * leaving the red "isolation did NOT complete" banner on an instance that was
 * only ever meant to be a password-gated single-user cockpit.
 * `SHADOK_FORCE_MULTITENANT=1` forces true and `=0` forces false (tests,
 * unusual setups) — same style as `inContainer` in `ssh.ts`; the explicit
 * override is checked BEFORE the platform gate so an operator keeps control.
 */
export function probeCanProvision(
  deps: {
    getuid?: () => number | undefined;
    canSudo?: () => boolean;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): boolean {
  const env = deps.env ?? process.env;
  const getuid = deps.getuid ?? (() => process.getuid?.());
  const canSudo = deps.canSudo ?? defaultCanSudo;
  const platform = deps.platform ?? process.platform;
  if (env.SHADOK_FORCE_MULTITENANT === "1") return true;
  if (env.SHADOK_FORCE_MULTITENANT === "0") return false;
  if (platform !== "linux") return false;
  if (getuid() === 0) return true;
  return canSudo();
}

/** Multi-tenant iff BOTH capabilities hold; otherwise stay mono-tenant. */
export function deploymentMode(input: {
  canProvision: boolean;
  accountsEnabled: boolean;
}): DeploymentMode {
  return input.canProvision && input.accountsEnabled ? "multi-tenant" : "mono-tenant";
}

/** Why an isolation affordance is refused in this mode, or null if allowed. */
export function isolationRefusal(mode: DeploymentMode): string | null {
  return mode === "mono-tenant" ? "isolation requires the privileged deployment" : null;
}

/**
 * The ONE gate for every isolation affordance (private/restricted group
 * provision, secrets-by-group, ...). Mono-tenant cannot pose a wall, so the
 * route answers 400 with the honest reason and the caller must stop — never a
 * fake wall. `res` is structural so this stays testable without express.
 */
export function requireCapable(
  mode: DeploymentMode,
  res: { status(code: number): { json(body: unknown): unknown } },
): boolean {
  const refusal = capabilityRefusal(mode);
  if (!refusal) return true;
  res.status(refusal.status).json(refusal.body);
  return false;
}

/** THE refusal primitive: every gate (flows and `requireCapable`) derives from it. */
export function capabilityRefusal(mode: DeploymentMode): { status: number; body: { error: string } } | null {
  const refusal = isolationRefusal(mode);
  return refusal ? { status: 400, body: { error: refusal } } : null;
}
