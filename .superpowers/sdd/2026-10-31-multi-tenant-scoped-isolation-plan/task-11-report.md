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
