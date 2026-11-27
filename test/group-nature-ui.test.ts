import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("isWalled and groupDisplayName are defined; private shows Personal", () => {
  assert.match(html, /function isWalled\(nature\)\s*\{[^}]*"private"[^}]*"restricted"[^}]*"external"/);
  assert.match(html, /function groupDisplayName\(g\)\s*\{[^}]*"private"[^}]*"Personal"/);
});

test("groupTypeLabel maps the four natures", () => {
  const m = html.match(/function groupTypeLabel\(nature\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, "groupTypeLabel defined");
  assert.match(m![0], /"Public"/);
  assert.match(m![0], /"Private"/);
  assert.match(m![0], /"Personal"/);
  // The operator never reads the internal word: `external` shows as External,
  // which is the one nature whose NAME is the same inside and out.
  assert.match(m![0], /"External"/);
});

test("the lock is gated on isWalled in the group head and in the rail", () => {
  assert.match(html, /isWalled\(opts\.nature\)|isWalled\(group\.nature\)/);
  assert.match(html, /glock/);
  // The rail keeps the group's own icon; the padlock is a small badge on it.
  assert.doesNotMatch(html, /icon:\s*isWalled\([^)]*\)\s*\?\s*"🔒"/);
  assert.match(html, /icon:\s*el\._group\.icon\b/);
  const rail = html.match(/function railItem\([\s\S]*?\n  \}\n/);
  assert.ok(rail, "railItem defined");
  assert.match(rail![0], /isWalled\(group\.nature\)/);
  assert.match(rail![0], /rail-lock/);
  assert.match(html, /\.rail-lock\s*\{/);
});

test("a walled group's icon stays editable — openIconPicker is not gated on isWalled", () => {
  // Since TWEAK 1 the padlock is a small corner badge over the group's OWN
  // icon, not the icon itself, so a private/personal group's icon is editable
  // like any other. A stale `isWalled(...) return` guard used to block it.
  const fn = html.match(/function openIconPicker\([\s\S]*?\n  \}/);
  assert.ok(fn, "openIconPicker must exist");
  assert.doesNotMatch(
    fn![0],
    /isWalled\([^)]*\)\)\s*return/,
    "openIconPicker must not early-return for a walled group",
  );
  // The group-head icon click must not gate the picker on isWalled either.
  assert.doesNotMatch(html, /gicon\)\s*\{[^}]*isWalled\([^)]*\)\)\s*return/);
});

test("createGroup threads nature and owner onto the group object", () => {
  const m = html.match(/function createGroup\(opts = \{\}\)[\s\S]*?\n  \}\n/);
  assert.ok(m);
  assert.match(m![0], /opts\.nature/);
  assert.match(m![0], /opts\.owner/);
  assert.match(m![0], /nature[,:]/);
});

test("'restricted' is only ever compared, never shown as a label", () => {
  const block = html.match(/function isWalled[\s\S]*?function groupTypeLabel[\s\S]*?\n  \}/);
  assert.ok(block);
  for (const line of block![0].split("\n")) {
    if (!/restricted/.test(line)) continue;
    assert.match(line, /===\s*"restricted"|case "restricted"/, line);
    assert.doesNotMatch(line, /textContent|title\s*=|label\s*:/);
  }
});

test("the synthetic Main view and the commons fold are preserved", () => {
  assert.match(html, /\{ view: "ungrouped", icon: "📥", name: "Main" \}/);
  assert.match(html, /String\(sg\.id\) === COMMONS_GROUP_ID\) continue/);
});

// ── Create-group form ────────────────────────────────────────────
function createFormBlock(): string {
  const m = html.match(/<div id="groupCreateOverlay"[\s\S]*?<!-- END group-create-form -->/);
  assert.ok(m, "groupCreateOverlay markup present");
  return m![0];
}
function createFormScript(): string {
  const m = html.match(/let groupCapable[\s\S]*?\/\/ END group-create/);
  assert.ok(m, "group-create script block present");
  return m![0];
}

test("create-group form offers exactly Public, Private and External, never Personal/restricted", () => {
  const block = createFormBlock();
  assert.match(block, /class="overlay"|class="overlay /);
  assert.doesNotMatch(block, /<select id="groupCreateType"/);
  assert.match(block, /<button type="button" class="nature-card[^"]*" data-nature="public"[^>]*>[\s\S]*?Public/);
  assert.match(block, /<button type="button" class="nature-card[^"]*" data-nature="restricted"[^>]*>[\s\S]*?Private/);
  assert.match(block, /<button type="button" class="nature-card[^"]*" data-nature="external"[^>]*>[\s\S]*?External/);
  assert.equal((block.match(/<button [^>]*class="nature-card/g) ?? []).length, 3);
  // A Personal group is created with its account, never here; and the internal
  // word "restricted" never reaches the operator.
  assert.doesNotMatch(block, /Personal/);
  assert.doesNotMatch(block, />[^<]*restricted[^<]*</i);
});

test("each type says what it MEANS where the choice is made", () => {
  // The nature is picked at creation and never converted, so this is the only
  // moment the operator can be told — and External is the one that needs it:
  // the wall is between the GUESTS, not towards the members.
  const s = createFormScript();
  assert.match(s, /const NATURE_NOTE = \{/);
  assert.match(s, /external:\s*"For STRANGERS: each conversation is sealed/);
  assert.match(s, /Cannot be changed afterwards/);
  assert.match(s, /groupCreateNatureNote/);
});

test("create-group submit POSTs /groups with a nature", () => {
  const s = createFormScript();
  assert.match(s, /fetch\("\/groups",\s*\{\s*method:\s*"POST"/);
  assert.match(s, /nature/);
  assert.match(s, /"x-shadok-instance":\s*instanceKey/);
  assert.match(s, /fetch\("\/groups\/members",\s*\{\s*method:\s*"POST"/);
});

test("Private is gated on the capability mode", () => {
  const s = createFormScript();
  assert.match(s, /mode\s*===\s*"multi-tenant"/);
  // BOTH walled types: a type that cannot pose its wall must not be offerable
  // at all (invariant 47), and External is the sharper case — it would read as
  // "each conversation is sealed" while every stranger shared one account.
  assert.match(s, /for \(const n of \["restricted", "external"\]\)/);
  assert.match(s, /\.disabled = !capable;/);
  assert.match(s, /\.nature-card/);
});

test("choosing Private reveals a picker sourced from the roster candidates", () => {
  const s = createFormScript();
  // One loader for both halves of the roster — the accounts AND the invited
  // agents (`rosterCandidates`), so a picker can never offer people only.
  assert.match(s, /rosterCandidates\(/);
  assert.match(s, /groupMembersField/);
  assert.match(createFormBlock(), /id="groupMembersField"/);
});

test("rosterCandidates asks for BOTH halves: the accounts and the invited agents", () => {
  // A group's roster holds bare principal names, so an invited agent joins one
  // exactly like a person (invariant 81). Fetching only `/accounts` is what made
  // that capability unreachable from the UI.
  assert.match(html, /fetch\("\/accounts"\)/);
  assert.match(html, /fetch\("\/peers\/names"/);
  const m = html.match(/async function rosterCandidates\([\s\S]*?\n  \}\n/);
  assert.ok(m, "rosterCandidates defined");
  // The agent half degrades on its own: a failing route leaves a people-only
  // picker rather than an empty one.
  assert.match(m![0], /catch \{[^\n]*\}/);
  // And the grid is TOLD which names are machines, or the two kinds are
  // indistinguishable on screen.
  assert.match(html, /renderMemberGrid\([^)]*agents/);
});

test("submitGroupCreate has an early in-flight guard", () => {
  const m = html.match(/async function submitGroupCreate\(\)\s*\{[\s\S]*?\n  \}\n/);
  assert.ok(m, "submitGroupCreate defined");
  assert.match(m![0], /^[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(\$\("groupCreateSubmit"\)\.disabled\) return;/);
});

// ---- Task 6: group settings / members panel ----
function groupPanelScript(): string {
  const m = html.match(/\/\/ BEGIN group-panel[\s\S]*?\/\/ END group-panel/);
  assert.ok(m, "group-panel script block present");
  return m![0];
}

test("openGroupPanel exists and is opened from a group-head control", () => {
  assert.match(groupPanelScript(), /async function openGroupPanel\(groupId\)/);
  assert.match(html, /on\(ggear\)\)[^\n]*openGroupPanel\(group\.id\)/);
  assert.match(html, /id="groupPanelOverlay" class="overlay"/);
});

test("member list + add/remove exist only in the roster branch", () => {
  const s = groupPanelScript();
  // Private and External share it: both are rosters of people.
  assert.match(s, /isRosterNature\(g\.nature\)/);
  const priv = s.match(/nature === "private"[\s\S]*?(?=isRosterNature\(g\.nature\)|$)/);
  assert.ok(priv);
  assert.doesNotMatch(priv![0], /gpAdd|gpMembers|\/accounts|rosterCandidates/);
  assert.match(s, /rosterCandidates\(g\.id\)/);
});

test("private shows a sealed only-you state with no add control", () => {
  const s = groupPanelScript();
  assert.match(s, /LineIcons\.el\("lock"/);
  assert.match(s, /Only you — this space is sealed/);
});

test("public shows a label note and no membership controls", () => {
  const s = groupPanelScript();
  assert.match(s, /Anyone can see this — it is a label/);
});

test("add and remove call POST /groups/members; header uses type label, never 'restricted' text", () => {
  const s = groupPanelScript();
  assert.match(s, /fetch\("\/groups\/members",\s*\{\s*method:\s*"POST"/);
  assert.match(s, /\{ group: [^}]*add[^}]*\}/);
  assert.match(s, /\{ group: [^}]*remove[^}]*\}/);
  assert.match(s, /"x-shadok-instance":\s*instanceKey/);
  assert.match(s, /groupTypeLabel\(/);
  assert.doesNotMatch(s, /textContent\s*=\s*"[^"]*restricted/i);
});

test("panel never builds rows via innerHTML (invariant 13)", () => {
  assert.doesNotMatch(groupPanelScript(), /innerHTML/);
});

test("add/remove surfaces a failure instead of silently re-rendering", () => {
  const s = groupPanelScript();
  assert.match(s, /!res\.ok/);
  assert.match(s, /sec-note warn/);
  assert.match(s, /\.error\b/);
  assert.match(s, /catch \(/);
});

function fnBlock(name: string): string {
  const i = html.indexOf(name);
  assert.ok(i >= 0, name + " defined");
  return html.slice(i, i + 1500);
}

test("cross-group tab drops follow groupMoveRefusal on a capable instance, and a refusal is said", () => {
  const g = fnBlock("function tabMoveRefusal(zone)");
  assert.match(g, /groupCapable !== true/); // mono-tenant: cosmetic groups always move
  assert.match(g, /window\.groupMoveRefusal\(/);
  assert.match(fnBlock("function tabMoveAllowed(zone)"), /tabMoveRefusal\(zone\) === null/);
  const dnd = html.slice(html.indexOf('tabbar.addEventListener("dragover"'), html.indexOf("// ── Groups column"));
  assert.equal((dnd.match(/tabMoveAllowed\(/g) || []).length, 4); // every dragover target is checked (tab, folder header, group header, zone)
  assert.match(dnd, /if \(why\) moveNotice\(why\);/); // the column's drop says why
  assert.match(html, /const why = dragTabEl\.parentNode !== body \? tabMoveRefusal\(body\) : null;\s*if \(why\) moveNotice\(why\);/);
});

test("walled group x routes to DELETE /groups; public keeps dissolveGroup", () => {
  const b = fnBlock("async function closeGroupGesture(group, after)");
  assert.match(b, /fetch\("\/groups",\s*\{\s*method:\s*"DELETE"/);
  assert.match(b, /"x-shadok-instance":\s*instanceKey/);
  assert.match(b, /confirm\(/);
  assert.match(b, /dissolveGroup\(group\)/);
  assert.match(html, /on\(gclose\)\) return closeGroupGesture\(group\)/);
  assert.doesNotMatch(html, /e\.target === gclose\) return dissolveGroup/);
});

test("Personal exposes neither delete nor rename", () => {
  const b = fnBlock("async function closeGroupGesture(group, after)");
  assert.match(b, /group\.nature === "private"\) return/);
  assert.match(html, /group\.nature === "private"\) return; \/\/ the personal space is not renamable/);
});

test("the restricted × title is destructive wording, not Ungroup; Personal's is not Ungroup", () => {
  assert.match(html, /Delete group \(destroys its agents and files\)/);
  assert.match(html, /function groupCloseTitle\(nature\)/);
  const m = html.match(/function groupCloseTitle\(nature\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m);
  assert.match(m![0], /"restricted"[\s\S]*Delete group/);
  assert.match(m![0], /"private"[\s\S]*Personal space/);
  assert.match(html, /gclose\.title = groupCloseTitle\(opts\.nature\)/);
  assert.match(html, /del\.title = groupCloseTitle\(group\.nature\)/);
});

test("closeGroupGesture surfaces the server's error on a failed delete", () => {
  const b = fnBlock("async function closeGroupGesture(group, after)");
  assert.match(b, /data\.error \|\| "Could not delete the group\."/);
});

// ---- Avatar toggle grid (member picker) ----
test("create picker is a member-grid container, not a <select multiple>", () => {
  assert.match(html, /<div id="groupMembersPick" class="member-grid"/);
  assert.doesNotMatch(html, /<select[^>]*id="groupMembersPick"/);
  assert.doesNotMatch(html, /Ctrl\/Cmd-click/);
  assert.match(html, /Click to add others/);
});

test("renderMemberGrid builds aria-pressed button tiles with textContent and a locked self", () => {
  const fn = html.match(/function renderMemberGrid\([\s\S]*?\n  \}\n/);
  assert.ok(fn, "renderMemberGrid defined");
  assert.match(fn![0], /createElement\("button"\)/);
  assert.match(fn![0], /type = "button"/);
  assert.match(fn![0], /"aria-pressed"/);
  assert.match(fn![0], /nm\.textContent = isSelf \? name \+ " \(you\)" : name/);
  assert.match(fn![0], /member-lock/);
  assert.match(fn![0], /style\.background = memberColor\(name\)/);
  // The only innerHTML is the constant check SVG.
  assert.deepEqual(fn![0].match(/innerHTML[^\n]*/g), ["innerHTML = MEMBER_CHECK_SVG; }"]);
  assert.match(html, /\.member-grid\s*\{/);
  assert.match(html, /\.member-tile\[aria-pressed="true"\]/);
});

test("submitGroupCreate reads the selected tiles", () => {
  const fn = html.match(/async function submitGroupCreate\(\)[\s\S]*?\n  \}\n/);
  assert.ok(fn);
  assert.match(fn![0], /readMemberGrid\(\$\("groupMembersPick"\)\)/);
  assert.doesNotMatch(fn![0], /selectedOptions/);
  assert.match(html, /function readMemberGrid[\s\S]*?\.member-tile\[aria-pressed="true"\]/);
  // The locked self/owner tile is aria-pressed for a11y but must NOT be returned
  // as a pick (owner is implicit) — the selector excludes it with :not(.me).
  assert.match(html, /function readMemberGrid[\s\S]*?\.member-tile\[aria-pressed="true"\]:not\(\.me\)/);
});

test("roster panel: avatar grid + 'Save members' that diffs and POSTs /groups/members", () => {
  const s = groupPanelScript();
  const restricted = s.slice(s.indexOf("isRosterNature(g.nature)"));
  assert.match(restricted, /renderMemberGrid\(grid,/);
  assert.match(restricted, /Save members/);
  // The enable rule moved to the shared pure helper, which also feeds the
  // footer's wording and the tiles' marks — one source for "is anything
  // pending", so the button and the sentence beside it cannot disagree.
  assert.match(restricted, /save\.disabled = !window\.memberDiffPending\(d\)/);
  assert.match(restricted, /post\(\{ group: g\.id, add: n \}\)/);
  assert.match(restricted, /post\(\{ group: g\.id, remove: n \}\)/);
  assert.match(restricted, /return openGroupPanel\(groupId\)/);
  assert.doesNotMatch(restricted, /<select|gpAdd|"Remove"/);
});

test("private panel stays sealed: no grid", () => {
  const priv = groupPanelScript().match(/nature === "private"[\s\S]*?(?=isRosterNature\(g\.nature\))/);
  assert.ok(priv);
  assert.doesNotMatch(priv![0], /renderMemberGrid|member-grid/);
});

test("roster Save keeps `current` equal to server truth after each POST", () => {
  const restricted = groupPanelScript().slice(groupPanelScript().indexOf("isRosterNature(g.nature)"));
  assert.match(restricted, /current\.push\(/);
  assert.match(restricted, /current\.splice\(/);
});

test("panel locks the group's owner (not /me); locked tile is aria-pressed; surrogate-safe initial", () => {
  const restricted = groupPanelScript().slice(groupPanelScript().indexOf("isRosterNature(g.nature)"));
  assert.match(restricted, /g\.owner/);
  assert.match(html, /\[\.\.\.String\(name\)\]\[0\]/);
  assert.match(html, /isSelf\) \{ b\.setAttribute\("aria-disabled", "true"\); b\.setAttribute\("aria-pressed", "true"\)/);
});

test("syncChannels prunes a server-seen group absent from a fulfilled /groups", () => {
  const create = html.match(/function createGroup\(opts = \{\}\)[\s\S]*?\n  \}\n/);
  assert.ok(create);
  assert.match(create![0], /serverSeen:\s*false/);
  const sync = html.match(/async function syncChannels\(\)[\s\S]*?const current = new Set/);
  assert.ok(sync);
  const body = sync![0];
  // Additive create/update is intact and marks groups as server-seen.
  assert.match(body, /createGroup\(sg\)\.serverSeen = true/);
  assert.match(body, /g\.serverSeen = true/);
  // The prune lives inside the fulfilled-array guard (a null /groups never prunes).
  const guard = body.indexOf("if (Array.isArray(srvGroups))");
  const prune = body.indexOf("g.serverSeen !== true");
  assert.ok(guard >= 0 && prune > guard, "prune must sit inside the Array.isArray(srvGroups) guard");
  assert.match(body, /COMMONS_GROUP_ID \|\| g\.serverSeen !== true \|\| visible\.has/);
  assert.match(body, /g\.el\.remove\(\)/);
  assert.doesNotMatch(body.slice(prune), /dissolveGroup/);
});

test("a NEW agent's launch message names the on-screen group (never on resume)", () => {
  assert.match(html, /if \(mode === "new"\) \{\s*const tg = viewGroupId\(\);\s*if \(tg\) msg\.group = tg;/);
});

test("a NEW agent created on the Main view names the commons group (multi-tenant only)", () => {
  // Without it the server files it into the creator's Personal and the tab jumps there.
  assert.match(html, /else if \(commonsOnServer && setupGroup == null && railShown\(\)\) msg\.group = COMMONS_GROUP_ID;/);
  // commonsOnServer is learned from the server's /groups, at boot AND on each sync.
  assert.match(html, /if \(groupsR\.status === "fulfilled"\) noteCommons\(groupsR\.value\);/);
  assert.match(html, /noteCommons\(srvGroups\);/);
});

test("the tweak agent is started in the commons group, where /tweak/prepare put its clone", () => {
  assert.match(html, /const tweakStart = \{ cwd: data\.cwd, worktree: true, profile: "Shadok-Tweak" \};\s*if \(commonsOnServer\) tweakStart\.group = COMMONS_GROUP_ID;\s*launchTab\(t, tweakStart\);/);
});

test("the EXTERNAL panel says what the nature is, before the roster", () => {
  // The members see every conversation — that is the product — so the line has
  // to say BOTH halves: sealed from each other, open to you.
  const s = groupPanelScript();
  const block = s.slice(s.indexOf("isRosterNature(g.nature)"));
  assert.match(block, /g\.nature === "external"/);
  assert.match(block, /each conversation is sealed from the others/);
  assert.match(block, /You and the other members see them all/);
});

test("deleting an EXTERNAL group warns about the conversations, not 'its agents'", () => {
  const fn = html.match(/async function closeGroupGesture\([\s\S]*?\n  \}\n/);
  assert.ok(fn);
  assert.match(fn![0], /isRosterNature\(group\.nature\)/);
  assert.match(fn![0], /Every conversation in it is destroyed, with its files and its system account/);
});

// ── The group panel's member Save (scan: index.html is not importable) ───

test("group panel: the Save button lives OUTSIDE the scrolling body", () => {
  // `.modal-body` is `overflow: auto`, so a button appended into it scrolls
  // away on a long roster — which is how ticking tiles came to look like the
  // whole act. The footer is `flex: 0 0 auto`, so it cannot.
  assert.match(html, /<div class="modal-foot" id="groupPanelFoot" hidden><\/div>/);
  assert.match(html, /foot\.append\(pending, save\);/);
  // And NOT into the body any more: that spelling is the bug.
  assert.doesNotMatch(html, /body\.append\(grid, save\)/);
});

test("group panel: the pending change is said in words and marked on the tiles", () => {
  assert.match(html, /pending\.textContent = window\.memberDiffLabel\(d\)/);
  assert.match(html, /tile\.dataset\.pending = "add"/);
  assert.match(html, /tile\.dataset\.pending = "remove"/);
  // The tile style has to exist, or `data-pending` is invisible.
  assert.match(html, /\.member-tile\[data-pending\]/);
});

test("group panel: EVERY door out of it goes through the unsaved-changes guard", () => {
  // Three ways to close a modal, and a guard on two of them is not a guard:
  // Escape is the fastest way to lose a roster edit.
  const doors = html.match(/groupPanelOverlay"\)\.hidden = true/g) ?? [];
  // Exactly one assignment remains — inside `closeGroupPanel` itself.
  assert.equal(doors.length, 1, "a close path still hides the panel without asking");
  assert.match(html, /\$\("groupPanelClose"\)\.addEventListener\("click", \(\) => \{ closeGroupPanel\(\); \}\)/);
  assert.match(html, /if \(e\.target === \$\("groupPanelOverlay"\)\) closeGroupPanel\(\)/);
  assert.match(html, /if \(!\$\("groupPanelOverlay"\)\.hidden\) \{ closeGroupPanel\(\); e\.preventDefault\(\); return; \}/);
});

test("group panel: a reopen after a successful save is not stopped by the guard", () => {
  // The save path reopens the panel to show the server's truth. Leaving the
  // closure in place would make that reopen ask whether to discard changes
  // that have just been written.
  assert.match(html, /groupPanelPending = null;\n        return openGroupPanel\(groupId\)/);
});
