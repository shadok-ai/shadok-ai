import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_HOST,
  bindRefusal,
  isLoopbackHost,
  originAllowed,
  parseOrigins,
  resolveHost,
  browserOrigin,
} from "../src/net.js";

// ── Interface d'écoute ───────────────────────────────────────────────────

test("sans SHADOK_HOST, on n'écoute que la machine elle-même", () => {
  assert.equal(resolveHost({}), DEFAULT_HOST);
  assert.equal(resolveHost({ SHADOK_HOST: "   " }), DEFAULT_HOST);
});

test("SHADOK_HOST impose l'interface (le cas conteneur)", () => {
  assert.equal(resolveHost({ SHADOK_HOST: "0.0.0.0" }), "0.0.0.0");
});

test("les formes locales sont reconnues, y compris IPv6 entre crochets", () => {
  for (const h of ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST"])
    assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["0.0.0.0", "192.168.1.20", "::", "example.com"])
    assert.equal(isLoopbackHost(h), false, h);
});

// ── Refus fail-closed ────────────────────────────────────────────────────

test("bind local : jamais de refus, mot de passe ou pas", () => {
  assert.equal(bindRefusal("127.0.0.1", false), null);
  assert.equal(bindRefusal("127.0.0.1", true), null);
});

test("bind réseau AVEC mot de passe : autorisé (le cas Docker légitime)", () => {
  assert.equal(bindRefusal("0.0.0.0", true), null);
});

test("bind réseau SANS mot de passe : refusé, et le message dit quoi faire", () => {
  const r = bindRefusal("0.0.0.0", false);
  assert.ok(r, "un bind réseau sans mot de passe doit être refusé");
  assert.match(r!, /--password|SHADOK_GUI_PASSWORD/);
});

// ── Allowlist d'origines ─────────────────────────────────────────────────

test("SHADOK_ORIGINS : normalisé (casse, espaces, slash final), vides ignorés", () => {
  assert.deepEqual(parseOrigins(" https://Cockpit.Example.com/ , ,http://a.b "), [
    "https://cockpit.example.com",
    "http://a.b",
  ]);
  assert.deepEqual(parseOrigins(undefined), []);
});

// ── Le garde same-origin ─────────────────────────────────────────────────

test("pas d'Origin → autorisé : c'est un client non navigateur", () => {
  // Le pont Telegram ouvre un WS sur notre propre serveur sans Origin ; le
  // refuser couperait Telegram de ses sessions.
  assert.equal(originAllowed(undefined, "127.0.0.1:3789"), true);
  assert.equal(originAllowed("", "127.0.0.1:3789"), true);
});

test("même origine → autorisé, port compris", () => {
  assert.equal(originAllowed("http://localhost:3789", "localhost:3789"), true);
  assert.equal(originAllowed("http://192.168.1.20:3789", "192.168.1.20:3789"), true);
  assert.equal(originAllowed("https://cockpit.example.com", "cockpit.example.com"), true);
});

test("une page tierce est refusée — l'attaque WebSocket depuis un site visité", () => {
  assert.equal(originAllowed("https://evil.com", "localhost:3789"), false);
});

test("un port différent est une autre origine", () => {
  // evil.com peut faire écouter n'importe quoi sur un autre port local ;
  // l'origine se compare en entier, hôte ET port.
  assert.equal(originAllowed("http://localhost:1234", "localhost:3789"), false);
});

test("un hôte qui commence pareil ne passe pas", () => {
  assert.equal(originAllowed("http://localhost:3789.evil.com", "localhost:3789"), false);
  assert.equal(originAllowed("http://notlocalhost:3789", "localhost:3789"), false);
});

test("une origine opaque ou illisible est refusée", () => {
  // `Origin: null` — iframe sandboxée, page file://.
  assert.equal(originAllowed("null", "localhost:3789"), false);
  assert.equal(originAllowed("pas une url", "localhost:3789"), false);
});

test("sans Host on ne peut rien comparer : refus", () => {
  assert.equal(originAllowed("https://evil.com", undefined), false);
});

test("SHADOK_ORIGINS ouvre une origine précise (reverse proxy)", () => {
  const allow = ["https://cockpit.example.com"];
  // Le Host vu par le serveur derrière le proxy n'est pas celui du navigateur.
  assert.equal(originAllowed("https://cockpit.example.com", "127.0.0.1:3789", allow), true);
  assert.equal(originAllowed("https://Cockpit.Example.com/", "127.0.0.1:3789", allow), true);
  assert.equal(originAllowed("https://evil.com", "127.0.0.1:3789", allow), false);
});

test("browserOrigin: seul un navigateur same-origin passe", () => {
  // Utilisé UNIQUEMENT pour garder les routes qui changent les garde-fous d'un
  // profil. originAllowed laisse passer les clients sans Origin (invariant 11 :
  // Telegram, pilotctl, la CLI) — ici c'est précisément ce qu'on refuse.
  assert.equal(browserOrigin("http://localhost:3789", "localhost:3789"), true);
  assert.equal(browserOrigin(undefined, "localhost:3789"), false, "un shell d'agent n'envoie pas d'Origin");
  assert.equal(browserOrigin("", "localhost:3789"), false);
  assert.equal(browserOrigin("http://evil.example", "localhost:3789"), false);
  assert.equal(browserOrigin("null", "localhost:3789"), false, "origine opaque");
});
