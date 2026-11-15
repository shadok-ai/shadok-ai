import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GithubError,
  GithubTokens,
  KEEPALIVE_BEFORE_MS,
  fetchInstallations,
  fetchUser,
  githubGitEnv,
  githubInfo,
  needsKeepalive,
  noreplyEmail,
  ownerOf,
  pickGithubAccount,
  reachesRepositories,
  refreshPatch,
  type FetchFn,
} from "../src/github.js";
import { accountDeadline, agentAccountView, policyPatch, publicView, type ConnectedAccount } from "../src/connected-accounts.js";

const NOW = Date.UTC(2026, 10, 15, 12);
const DAY = 24 * 3600_000;
const acct = (o: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id: "h0000001",
  provider: "github",
  kind: "member",
  label: "octo",
  externalId: "42",
  owner: "ana",
  connectedVia: "ana",
  share: { personal: true, groups: [], everyone: false, profiles: [] },
  policy: "approve",
  github: { login: "octo", id: 42, email: "42+octo@users.noreply.github.com", installations: [{ id: 7, account: "acme", selection: "selected", repos: 3 }], checkedAt: NOW },
  token: "ACCESS-OLD",
  refreshToken: "REFRESH-1",
  expiresAt: NOW + 8 * 3600_000,
  refreshExpiresAt: NOW + 180 * DAY,
  createdAt: 1,
  updatedAt: 1,
  ...o,
});

/** A one-account store whose patches are recorded, and a broker that counts its calls. */
function harness(account: ConnectedAccount, answer: (body: { refresh_token: string }) => Promise<Response> | Response) {
  let current = account;
  const calls: { url: string; body: { refresh_token: string } }[] = [];
  const patches: Partial<ConnectedAccount>[] = [];
  const fetchFn = (async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    return answer(body);
  }) as FetchFn;
  const tokens = new GithubTokens({
    broker: "https://broker.test",
    fetchFn,
    now: () => NOW,
    store: {
      get: (id) => (id === current.id ? current : undefined),
      patch: (_id, p) => {
        patches.push(p);
        current = { ...current, ...p };
      },
    },
  });
  return { tokens, calls, patches, get: () => current };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a fresh access token is returned as is, no broker call", async () => {
  const h = harness(acct(), () => json(500, {}));
  assert.equal(await h.tokens.accessToken("h0000001"), "ACCESS-OLD");
  assert.equal(h.calls.length, 0);
});

test("refresh: the ROTATED refresh token is persisted, with its new deadline, before the access token is handed out", async () => {
  let persistedBeforeReturn = false;
  const h = harness(acct({ expiresAt: NOW + 60_000 }), () =>
    json(200, { access_token: "ACCESS-NEW", expires_in: 28800, refresh_token: "REFRESH-2", refresh_token_expires_in: 15_897_600 }),
  );
  const token = await h.tokens.accessToken("h0000001");
  persistedBeforeReturn = h.get().refreshToken === "REFRESH-2";
  assert.equal(token, "ACCESS-NEW");
  assert.ok(persistedBeforeReturn);
  assert.equal(h.calls[0].url, "https://broker.test/github/refresh");
  assert.equal(h.calls[0].body.refresh_token, "REFRESH-1");
  assert.equal(h.get().expiresAt, NOW + 28800 * 1000);
  assert.equal(h.get().refreshExpiresAt, NOW + 15_897_600 * 1000);
});

test("refresh: ONE in flight per account — concurrent callers share it, the dead token is never sent twice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness(acct({ expiresAt: NOW }), async (body) => {
    await gate;
    // A second refresh with the same (now rotated) token would be refused.
    return body.refresh_token === "REFRESH-1" ? json(200, { access_token: "ACCESS-NEW", expires_in: 28800, refresh_token: "REFRESH-2", refresh_token_expires_in: 100 }) : json(400, { error: "invalid_grant" });
  });
  const all = Promise.all([h.tokens.accessToken("h0000001"), h.tokens.accessToken("h0000001"), h.tokens.accessToken("h0000001", true)]);
  release();
  assert.deepEqual(await all, ["ACCESS-NEW", "ACCESS-NEW", "ACCESS-NEW"]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.get().status, "ok");
});

test("refresh: the next refresh uses the rotated token", async () => {
  let n = 0;
  const h = harness(acct({ expiresAt: NOW }), () => {
    n++;
    return json(200, { access_token: `ACCESS-${n}`, expires_in: 1, refresh_token: `REFRESH-${n + 1}`, refresh_token_expires_in: 100 });
  });
  await h.tokens.accessToken("h0000001");
  await h.tokens.accessToken("h0000001", true);
  assert.deepEqual(h.calls.map((c) => c.body.refresh_token), ["REFRESH-1", "REFRESH-2"]);
});

test("refresh: invalid_grant marks the account expired, and later calls refuse without asking", async () => {
  const h = harness(acct({ expiresAt: NOW }), () => json(400, { error: "invalid_grant" }));
  await assert.rejects(h.tokens.accessToken("h0000001"), (e: unknown) => e instanceof GithubError && e.expired);
  assert.equal(h.get().status, "expired");
  await assert.rejects(h.tokens.accessToken("h0000001"), (e: unknown) => e instanceof GithubError && e.expired);
  assert.equal(h.calls.length, 1);
});

test("refresh: an unreachable or failing broker changes nothing", async () => {
  const down = harness(acct({ expiresAt: NOW }), () => Promise.reject(new Error("ECONNREFUSED")));
  await assert.rejects(down.tokens.accessToken("h0000001"), (e: unknown) => e instanceof GithubError && !e.expired && e.status === 502);
  assert.equal(down.patches.length, 0);
  const sick = harness(acct({ expiresAt: NOW }), () => json(502, { error: "refresh_failed" }));
  await assert.rejects(sick.tokens.accessToken("h0000001"), (e: unknown) => e instanceof GithubError && !e.expired);
  assert.equal(sick.patches.length, 0);
  // Neither leaves an in-flight promise behind: the next call asks again.
  await assert.rejects(sick.tokens.accessToken("h0000001"));
  assert.equal(sick.calls.length, 2);
});

test("refresh errors never carry a token", async () => {
  const h = harness(acct({ expiresAt: NOW }), () => json(502, { error: "refresh_failed", refresh_token: "LEAK" }));
  await assert.rejects(h.tokens.accessToken("h0000001"), (e: unknown) => !String((e as Error).message).includes("REFRESH") && !String((e as Error).message).includes("LEAK"));
});

test("a lasting token (no refresh token, non-expiring app) is returned without a refresh", async () => {
  const h = harness(acct({ refreshToken: undefined, refreshExpiresAt: undefined, expiresAt: Number.MAX_SAFE_INTEGER }), () => json(500, {}));
  assert.equal(await h.tokens.accessToken("h0000001", true), "ACCESS-OLD");
  assert.equal(h.calls.length, 0);
});

test("refreshPatch keeps the stored refresh token when none is sent, and defaults the 8 h lifetime", () => {
  assert.deepEqual(refreshPatch({ access_token: "A" }, NOW), { token: "A", expiresAt: NOW + 8 * 3600_000, status: "ok" });
  assert.equal(refreshPatch({}, NOW), null);
});

test("needsKeepalive: only a live GitHub account within 14 days of its refresh deadline", () => {
  assert.equal(needsKeepalive(acct(), NOW), false);
  assert.equal(needsKeepalive(acct({ refreshExpiresAt: NOW + KEEPALIVE_BEFORE_MS - 1 }), NOW), true);
  assert.equal(needsKeepalive(acct({ refreshExpiresAt: NOW + DAY, status: "expired" }), NOW), false);
  assert.equal(needsKeepalive(acct({ refreshExpiresAt: NOW - 1 }), NOW), false);
  assert.equal(needsKeepalive(acct({ provider: "google", refreshExpiresAt: NOW + DAY }), NOW), false);
});

test("the reconnect deadline is the refresh token's, never the 8-hour access token's", () => {
  assert.equal(accountDeadline(acct()), NOW + 180 * DAY);
  assert.equal(accountDeadline(acct({ refreshExpiresAt: undefined })), null);
});

test("noreplyEmail, githubInfo, reachesRepositories", () => {
  assert.equal(noreplyEmail(42, "octo"), "42+octo@users.noreply.github.com");
  const info = githubInfo({ id: 42, login: "octo" }, [], NOW);
  assert.equal(info.email, "42+octo@users.noreply.github.com");
  assert.equal(reachesRepositories(info), false);
  assert.equal(reachesRepositories({ installations: [{ id: 1, account: "a", selection: "selected", repos: 0 }] }), false);
  assert.equal(reachesRepositories({ installations: [{ id: 1, account: "a", selection: "all", repos: 0 }] }), true);
  assert.equal(reachesRepositories({ installations: [{ id: 1, account: "a", selection: "selected", repos: 2 }] }), true);
});

test("fetchUser / fetchInstallations read GitHub's answers; the token rides only in the header", async () => {
  const seen: { url: string; auth: string }[] = [];
  const fetchFn = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const u = String(url);
    seen.push({ url: u, auth: init?.headers?.Authorization ?? "" });
    if (u.endsWith("/user")) return json(200, { id: 42, login: "octo" });
    if (u.includes("/user/installations?")) return json(200, { installations: [{ id: 7, account: { login: "acme" }, repository_selection: "selected" }, { id: 8, account: { login: "octo" }, repository_selection: "all" }, { bogus: true }] });
    if (u.includes("/installations/7/")) return json(200, { total_count: 3 });
    return json(500, {});
  }) as FetchFn;
  assert.deepEqual(await fetchUser("TOK", fetchFn), { id: 42, login: "octo" });
  assert.deepEqual(await fetchInstallations("TOK", fetchFn), [
    { id: 7, account: "acme", selection: "selected", repos: 3 },
    { id: 8, account: "octo", selection: "all", repos: null },
  ]);
  assert.ok(seen.every((s) => s.auth === "Bearer TOK" && !s.url.includes("TOK")));
});

test("githubGitEnv names the helper, appends after existing GIT_CONFIG entries, and carries no token", () => {
  assert.deepEqual(githubGitEnv("/etc/claude-code/.claude/skills", {}), {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!node '/etc/claude-code/.claude/skills/shadok-github/scripts/github.mjs' credential",
  });
  const appended = githubGitEnv("/h/.claude/skills/", { GIT_CONFIG_COUNT: "2" });
  assert.equal(appended.GIT_CONFIG_COUNT, "3");
  assert.equal(appended.GIT_CONFIG_KEY_2, "credential.https://github.com.helper");
  assert.equal(githubGitEnv("/it's", {}).GIT_CONFIG_VALUE_0, `!node '/it'\\''s/shadok-github/scripts/github.mjs' credential`);
});

const expired = (a: ConnectedAccount) => `reconnect ${a.label}`;

test("pick: none shared → 404; the only one → it", () => {
  const none = pickGithubAccount([], {}, NOW, expired);
  assert.equal(none.ok, false);
  assert.equal(!none.ok && none.status, 404);
  const one = pickGithubAccount([acct()], { owner: "someone-else" }, NOW, expired);
  assert.ok(one.ok && one.account.id === "h0000001");
});

test("pick: several → by explicit id prefix, else by the repository owner, else a refusal that lists them", () => {
  const a = acct();
  const b = acct({ id: "h0000002", label: "bot", externalId: "43", github: { login: "bot", id: 43, email: "", installations: [{ id: 9, account: "other-org", selection: "all", repos: null }], checkedAt: NOW } });
  const named = pickGithubAccount([a, b], { account: "h0000002" }, NOW, expired);
  assert.ok(named.ok && named.account === b);
  const byOwner = pickGithubAccount([a, b], { owner: "https://github.com/Other-Org/x.git" }, NOW, expired);
  assert.ok(byOwner.ok && byOwner.account === b);
  const stuck = pickGithubAccount([a, b], { owner: "nobody" }, NOW, expired);
  assert.ok(!stuck.ok && stuck.status === 409 && stuck.accounts?.length === 2);
  const ambiguous = pickGithubAccount([a, b], { account: "h00" }, NOW, expired);
  assert.ok(!ambiguous.ok && ambiguous.status === 409);
  const unknown = pickGithubAccount([a, b], { account: "zz" }, NOW, expired);
  assert.ok(!unknown.ok && unknown.status === 404);
});

test("pick: a lapsed account is skipped when another is usable; naming it, or holding only it, says reconnect", () => {
  const dead = acct({ id: "h0000003", status: "expired", label: "old" });
  const live = acct();
  const skip = pickGithubAccount([dead, live], {}, NOW, expired);
  assert.ok(skip.ok && skip.account === live);
  const named = pickGithubAccount([dead, live], { account: "h0000003" }, NOW, expired);
  assert.ok(!named.ok && named.reason === "reconnect old");
  const only = pickGithubAccount([dead], {}, NOW, expired);
  assert.ok(!only.ok && only.status === 409 && only.reason === "reconnect old");
});

test("ownerOf (server side) matches the skill's reading", () => {
  assert.equal(ownerOf("acme/app"), "acme");
  assert.equal(ownerOf("git@github.com:acme/app.git"), "acme");
  assert.equal(ownerOf(42), null);
});

test("store views: no token ever, the agent sees login, noreply email and owners", () => {
  const a = acct();
  const pub = publicView(a) as Record<string, unknown>;
  assert.equal(pub.token, undefined);
  assert.equal(pub.refreshToken, undefined);
  const v = agentAccountView(a, NOW) as Record<string, unknown>;
  assert.equal(JSON.stringify(v).includes("ACCESS-OLD"), false);
  assert.equal(JSON.stringify(v).includes("REFRESH-1"), false);
  assert.equal(v.login, "octo");
  assert.equal(v.email, "42+octo@users.noreply.github.com");
  assert.deepEqual(v.owners, [{ owner: "acme", selection: "selected", repos: 3 }]);
  assert.equal(v.expiresAt, NOW + 180 * DAY);
  assert.equal(v.policy, undefined);
});

test("a GitHub account has no approval setting to change", () => {
  const r = policyPatch(acct(), { policy: "autonomous" });
  assert.equal(r.ok, false);
  assert.deepEqual(policyPatch(acct(), {}), { ok: true, patch: null });
});
