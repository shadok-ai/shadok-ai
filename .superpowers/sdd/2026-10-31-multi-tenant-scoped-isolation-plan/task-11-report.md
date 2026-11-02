# Task 11 report — group-scoped secrets UI

## Pure helpers (public/secrets-panel.js, bridged ESM) + tests (test/secrets-panel.test.ts, 9 tests)
- secretsPanelMode(groups): "flat" when only Main / nothing / failed fetch, else "grouped".
- secretSections(secrets, selectedGroupId): {own, sharedIn, inheritedMain} by the server's source tag; own scoped to the group.
- keyGroups(groups), shareTargets(groups, owner), auditLine(secret).
- Bridged in index.html: import (?v=__ASSET_V__), window.* assignments and neutral BRIDGE_STUBS (test/esm-bridge.test.ts green).

## Server change (small, needed by the UI)
src/secrets.ts VisibleSecret now carries createdBy/createdAt/updatedAt on every entry and sharedWith/profiles on OWN entries only (never the value). test/server-acl.test.ts deepEquals adjusted to the name/source/ownerGroup projection, plus a no-value assertion.

## index.html
- #secretsScope + #secretsGroup (group selector, grouped mode only); #secretsList renders sections "Own — <group>" (editable; per-row "shared read with" -> PUT /secrets/share, "attach to profiles" -> PUT /secrets/profiles; audit line), "Shared with this group" (read-only, "from <owner>"), "Inherited from Main" (read-only).
- Flat mode (only Main): unchanged single list, legacy profile ticks in the add form. In grouped mode the add-form profile ticks are hidden (#secretAttach[data-grouped]) and not synced (would otherwise detach everything).
- 🔑 (.gkey) in each group head (hover) -> openSecretsPanel(group.id); header Secrets button -> openSecretsPanel(null).
- Profile editor: #profSecretsList is read-only (injected names, note that values resolve per group at spawn) + "→ Manage secrets" (#profToSecrets) opening the panel. editSecretRefs still sent on save so bindings are preserved. Old checkbox editor/CSS removed.
- Caveat: writes (PUT /secrets) land in the caller's own group (server-derived, by design); the group selector scopes the VIEW.

## Verification
- npm run build clean; npm test 1570/1570 pass.
- Browser verification DEFERRED to the human (hold PR): Playwright is not present at ~/projects/aibrowser/node_modules in this environment; the side instance also walked 3899->3900 with GUI password ON. My instance was stopped (3789 untouched). No screenshots were read.
- Self-check: 0 added onclick= handlers; no new inline <script> blocks (module block extended, already nonce'd); all new listeners via addEventListener; ESM import carries ?v=__ASSET_V__.

---

## Fix pass — validated per-write group targeting (Problem A + Task 10 residual)

**Status:** DONE. Commit `ebaf4d9`. `npm run build` clean; `npm test` FULL green (1574/1574, +4 new). Browser verification DEFERRED to the human (Playwright absent at `~/projects/aibrowser/node_modules`); the client change is param-threading inside existing handlers — 0 new `onclick=`, 0 new inline `<script>`, no new bridged module.

### The problem
The four secret-write routes (`PUT /secrets`, `DELETE /secrets`, `PUT /secrets/share`, `PUT /secrets/profiles`) resolved the target group from the CALLER'S IDENTITY only (`secretWriteTarget`), ignoring the group the panel was scoped to. A human managing COMEX's section therefore wrote to their own default group — misleading (the server still decided, so not a cross-tenant write), and it left Task 10's "per-write group selection" residual open.

### The validated-group flow (server authorizes, never trusts)
A write now carries an OPTIONAL `group` (the requested TARGET owner group). It is a REQUEST that must pass the same gate as any write, not a trusted value:
- **HUMAN (browser):** `requestedGroup` becomes the target; `secretWriteDecision` → `canWriteSecretGroup(G, viewer)` decides — private → `G.owner === viewer.name`; restricted/public → MEMBER or admin; Main → admin. Fails → 403, no write.
- **AGENT (session-key):** `requestedGroup` is IGNORED outright — it writes ONLY its own channel group (any nature, private included), preserving Task 10's agent-own-group rule. A body `group:G2` from an agent whose channel is in G1 writes G1.
- **Omitted `group`:** today's identity-derived own group (`spawnGroupFor` for a browser, the channel group for an agent) — back-compat.
- **Mono-tenant:** `secretWriteTarget` drops the request entirely; everything is Main, unchanged.

Per route: all four call `secretWriteTarget(req)`, which reads `group` from the body (PUT/share/profiles) or the query (DELETE) and threads it as `requestedGroup` into `secretWriteDecision` (multi-tenant) / `secretOwnerGroup` (mono-tenant). `createdBy` stays server-stamped (`secretCreatedBy`). share/profiles edit the resolved owner group's slice.

### `canWriteSecretGroup` evolved (groups.ts)
Task 10 had restricted → admin-only. The brief's HUMAN rule is "restricted → member OR admin", and the group selector is useless to a member who cannot write their own group, so `canWriteSecretGroup` now returns `viewer.role === "admin" || memberOf(g, viewer.name)` for non-private groups. Main has no members, so it reduces to admin-only (unchanged); private stays owner-only. This overturned two Task-10 assertions that encoded the old admin-only rule (`canWriteSecretGroup(comex, ada) → false`; `secretWriteDecision({viewer: ada}) → refused`); both were updated to the new rule and are green.

### Client (public/index.html)
Added `secretWriteGroup()` (grouped mode → `panelGroup`, else null) + `withSecretGroup(body)`. The panel sends the selected group as `group` on all four calls in grouped mode and omits it in flat/mono mode: `PUT /secrets` (add/edit submit + `.env` paste loop), `DELETE /secrets` (query `&group=`), `PUT /secrets/share`, `PUT /secrets/profiles`.

### vaultGroups finding
`vaultGroups` is already fetched from `GET /groups` (`loadVault`, `fetch("/groups")`), which returns `loadGroups()` — the PROMOTED server-owned `Group[]` with `nature`/`members` (Task 2). It is NOT the legacy cosmetic UI tab-groups (the client's separate `groups`). `secretsPanelMode`/`secretSections` key off these real group ids. No fix needed — confirmed correct as-is.

### Tests
- **Strengthened no-value assertion** (`test/server-acl.test.ts`, SALES case): now loops EVERY returned row (own + shared-in + main, `seen.length === 3`) asserting no `value` key — the critical never-leak-a-value invariant, not just one entry.
- **New decision tests** (`test/server-acl.test.ts`): `secretOwnerGroup` honours a browser request / ignores an agent's / blank falls back; `secretWriteDecision` member-targets-G → OK, non-member → refused, admin→restricted → OK, admin→private-not-owned → refused (sealed), private-owner → OK, dangling → fail-closed, agent-G2 → writes only G1; omitted → own (back-compat); mono-tenant unchanged. (server-acl 16 → 19.)
- **New wiring lock** (`test/server-acl-leaks.test.ts`): source-scan that `secretWriteTarget` reads a body/query `group`, threads `requestedGroup` into `secretWriteDecision`, and mono-tenant keeps the identity-derived owner (server.ts is un-importable; invariant-24 defence). (7 → 8.)

Full suite: `# tests 1574 # pass 1574 # fail 0`.
