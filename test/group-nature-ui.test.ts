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
  assert.match(html, /isWalled\(el\._group\.nature\)\s*\?\s*"🔒"/);
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
  assert.match(block, /<option value="public">Public<\/option>/);
  assert.match(block, /<option value="restricted">Private<\/option>/);
  assert.equal((block.match(/<option /g) ?? []).length, 2);
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
  assert.match(s, /disabled/);
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
