# Task 3 report
- Helper: `mtCredentialMessage(capable, hasToken)` in src/claude-bin.ts (next to claudeStubMessage); names MT_CLAUDE_OAUTH_TOKEN and `claude setup-token`.
- Wiring: start handler in src/server.ts, right after ensureClaudeOnce. capable = DEPLOYMENT_MODE==="multi-tenant" && groupsMigrated (agents only drop to users, needing the token, after migration; a pre-migration root agent keeps keychain auth). Token presence via secretsFor. On message: fail(msg) and console.error once via module flag `mtTokenWarned`. No banner change.
- Docs: README multi-tenant section (setup-token, ~1yr, manual re-mint); isolation design credential section replaced by a superseded note pointing to the injection design.
- Test: test/mt-token-provisioning.test.ts (2 tests); failed before impl, passes after. Command: npx tsx --test test/mt-token-provisioning.test.ts.
- Build clean; full suite npm test: 1703 pass, 0 fail.
- Concern: gating on groupsMigrated is my choice; spawn is refused (not just logged) once migrated and token absent.
