import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("isWalled and groupDisplayName are defined; private shows Personal", () => {
  assert.match(html, /function isWalled\(nature\)\s*\{[^}]*"private"[^}]*"restricted"/);
  assert.match(html, /function groupDisplayName\(g\)\s*\{[^}]*"private"[^}]*"Personal"/);
});

test("groupTypeLabel maps the three natures", () => {
  const m = html.match(/function groupTypeLabel\(nature\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, "groupTypeLabel defined");
  assert.match(m![0], /"Public"/);
  assert.match(m![0], /"Private"/);
  assert.match(m![0], /"Personal"/);
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

test("create-group form offers exactly Public and Private, never Personal/restricted", () => {
  const block = createFormBlock();
  assert.match(block, /class="overlay"|class="overlay /);
  assert.doesNotMatch(block, /<select id="groupCreateType"/);
  assert.match(block, /<button type="button" class="nature-card[^"]*" data-nature="public"[^>]*>[\s\S]*?Public/);
  assert.match(block, /<button type="button" class="nature-card[^"]*" data-nature="restricted"[^>]*>[\s\S]*?Private/);
  assert.equal((block.match(/<button [^>]*class="nature-card/g) ?? []).length, 2);
  assert.doesNotMatch(block, /Personal/);
  assert.doesNotMatch(block, />[^<]*restricted[^<]*</i);
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
  assert.match(s, /data-nature="restricted"[^\n]*\.disabled\s*=\s*!capable/);
  assert.match(s, /\.nature-card/);
});

test("choosing Private reveals a picker sourced from GET /accounts", () => {
  const s = createFormScript();
  assert.match(s, /fetch\("\/accounts"/);
  assert.match(s, /groupMembersField/);
  assert.match(createFormBlock(), /id="groupMembersField"/);
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
  assert.match(html, /e\.target === ggear\)[^\n]*openGroupPanel\(group\.id\)/);
  assert.match(html, /id="groupPanelOverlay" class="overlay"/);
});

test("member list + add/remove exist only in the restricted branch", () => {
  const s = groupPanelScript();
  assert.match(s, /nature === "restricted"/);
  const priv = s.match(/nature === "private"[\s\S]*?(?=nature === "restricted"|$)/);
  assert.ok(priv);
  assert.doesNotMatch(priv![0], /gpAdd|gpMembers|\/accounts/);
  assert.match(s, /fetch\("\/accounts"/);
});

test("private shows a sealed only-you state with no add control", () => {
  const s = groupPanelScript();
  assert.match(s, /🔒/);
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

test("cross-group tab drops are no-ops on a capable instance", () => {
  const g = fnBlock("function tabMoveAllowed(zone)");
  assert.match(g, /groupCapable !== true/);
  const dnd = html.slice(html.indexOf('tabbar.addEventListener("dragover"'), html.indexOf("// ── Groups column"));
  assert.equal((dnd.match(/tabMoveAllowed\(/g) || []).length, 3);
  assert.match(html, /dragTabEl\.parentNode !== body && tabMoveAllowed\(body\)/);
});

test("walled group x routes to DELETE /groups; public keeps dissolveGroup", () => {
  const b = fnBlock("async function closeGroupGesture(group, after)");
  assert.match(b, /fetch\("\/groups",\s*\{\s*method:\s*"DELETE"/);
  assert.match(b, /"x-shadok-instance":\s*instanceKey/);
  assert.match(b, /confirm\(/);
  assert.match(b, /dissolveGroup\(group\)/);
  assert.match(html, /e\.target === gclose\) return closeGroupGesture\(group\)/);
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
  assert.match(fn![0], /nm\.textContent = me \? name \+ " \(you\)" : name/);
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
});

test("restricted panel: avatar grid + 'Save members' that diffs and POSTs /groups/members", () => {
  const s = groupPanelScript();
  const restricted = s.slice(s.indexOf('nature === "restricted"'));
  assert.match(restricted, /renderMemberGrid\(grid,/);
  assert.match(restricted, /Save members/);
  assert.match(restricted, /save\.disabled = !d\.add\.length && !d\.remove\.length/);
  assert.match(restricted, /post\(\{ group: g\.id, add: n \}\)/);
  assert.match(restricted, /post\(\{ group: g\.id, remove: n \}\)/);
  assert.match(restricted, /return openGroupPanel\(groupId\)/);
  assert.doesNotMatch(restricted, /<select|gpAdd|"Remove"/);
});

test("private panel stays sealed: no grid", () => {
  const priv = groupPanelScript().match(/nature === "private"[\s\S]*?(?=nature === "restricted")/);
  assert.ok(priv);
  assert.doesNotMatch(priv![0], /renderMemberGrid|member-grid/);
});
