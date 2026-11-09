// Which step of the "Connect Claude" card to show — pure, so the rules are
// tested rather than clicked through (test/connect-card.test.ts).
//
// The server reports whether the commons can authenticate (`/auth` → connect,
// src/connect-gate.ts); a spawn refusal names the space that cannot. Only an
// admin ever connects anything: a member gets a calm "ask an admin" note and
// never an OAuth flow. "unknown" means the server could not look — it never
// opens the card on its own (invariant 27).

const CLOSED = { open: false, step: null, flow: null, user: null, dismissable: false };

/** The flow a connection of the CURRENT mode runs: root sign-in, token, or a space's login. */
function currentFlow(connect) {
  if (!connect || !connect.multiTenant || connect.user == null) return "instance";
  return connect.agentAuth === "login" ? "login" : "token";
}

/**
 * @param {{connect?: {state: string, multiTenant: boolean, agentAuth: string, user: string|null},
 *          backend?: string, isAdmin: boolean,
 *          refusal?: {code: string, user: string|null}|null, force?: boolean}} input
 * @returns {{open: boolean, step: "choose"|"authorise"|"ask-admin"|null,
 *            flow: "instance"|"token"|"login"|null, user: string|null, dismissable: boolean}}
 */
export function connectCardPlan({ connect, backend, isAdmin, refusal = null, force = false }) {
  if (backend === "custom" || !connect) return CLOSED;
  const askAdmin = { open: true, step: "ask-admin", flow: null, user: null, dismissable: true };

  if (refusal && (refusal.code === "space-not-connected" || refusal.code === "logged-out")) {
    if (!isAdmin) return askAdmin;
    const flow = refusal.code === "logged-out" ? "instance" : connect.agentAuth === "login" ? "login" : "token";
    return { open: true, step: "authorise", flow, user: refusal.user ?? null, dismissable: true };
  }
  if (connect.state === "no") {
    if (!isAdmin) return askAdmin;
    const choose = connect.multiTenant && connect.user != null;
    return choose
      ? { open: true, step: "choose", flow: null, user: connect.user, dismissable: false }
      : { open: true, step: "authorise", flow: "instance", user: null, dismissable: false };
  }
  if (force && isAdmin) {
    return { open: true, step: "authorise", flow: currentFlow(connect), user: connect.user ?? null, dismissable: true };
  }
  return CLOSED;
}
