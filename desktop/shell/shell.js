// The sidebar. Holds no state of its own: main.mjs owns the list and pushes
// it here on every change, and every action goes back through window.desktop.

const $ = (id) => document.getElementById(id);
const mod = window.desktop.platform === "darwin" ? "⌘" : "Ctrl+";

let current = { instances: [], active: null, status: {} };
let renaming = null; // id being renamed — a push must not wipe the input

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}

function render() {
  if (renaming) return;
  const { instances, active, status } = current;
  const list = $("list");
  list.replaceChildren();
  instances.forEach((inst, i) => {
    const st = status[inst.id] || {};
    const li = document.createElement("li");
    li.dataset.id = inst.id;
    li.draggable = true;
    if (inst.id === active) li.classList.add("active");

    const dot = document.createElement("span");
    dot.className = "dot" + (st.error ? " error" : st.attention ? " attention" : st.loading ? " loading" : "");
    dot.title = st.error ? "Unreachable" : st.attention ? "An agent is waiting" : "";

    const label = document.createElement("div");
    label.className = "label";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = inst.name;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = hostOf(inst.url);
    label.append(name, sub);

    const key = document.createElement("span");
    key.className = "key";
    if (i < 9) key.textContent = `${mod}${i + 1}`;

    const tools = document.createElement("span");
    tools.className = "tools";
    tools.append(
      toolButton("↻", "Reload", () => window.desktop.reload(inst.id)),
      toolButton("✎", "Rename", () => startRename(li, inst)),
      toolButton("✕", "Remove", () => {
        if (confirm(`Remove "${inst.name}"?\n\nThe cockpit itself is not touched; this app only forgets its address and its login.`)) {
          window.desktop.remove(inst.id);
        }
      }),
    );

    li.append(dot, label, key, tools);
    li.addEventListener("click", () => window.desktop.activate(inst.id));
    li.addEventListener("dblclick", () => startRename(li, inst));
    wireDrag(li, i);
    list.append(li);
  });

  const activeInst = instances.find((x) => x.id === active);
  const failed = activeInst && status[active]?.error;
  $("empty").hidden = instances.length > 0;
  $("failed").hidden = !failed;
  if (failed) {
    $("failedName").textContent = activeInst.name;
    $("failedUrl").textContent = activeInst.url;
    $("failedWhy").textContent = status[active].error;
  }
}

function toolButton(text, title, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

function startRename(li, inst) {
  renaming = inst.id;
  const name = li.querySelector(".name");
  const input = document.createElement("input");
  input.className = "rename";
  input.value = inst.name;
  name.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renaming = null;
    if (save) window.desktop.rename(inst.id, input.value);
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

let dragId = null;
function wireDrag(li, index) {
  li.addEventListener("dragstart", (e) => {
    dragId = li.dataset.id;
    e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragover", (e) => {
    if (!dragId) return;
    e.preventDefault();
    li.classList.add("drag-over");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    li.classList.remove("drag-over");
    if (dragId && dragId !== li.dataset.id) window.desktop.move(dragId, index);
    dragId = null;
  });
  li.addEventListener("dragend", () => (dragId = null));
}

// ---------------------------------------------------------- add dialog --

function openAdd() {
  $("addUrl").value = "";
  $("addName").value = "";
  $("addError").textContent = "";
  window.desktop.setOverlay(true);
  $("addDialog").showModal();
  $("addUrl").focus();
}

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await window.desktop.add($("addUrl").value, $("addName").value);
  if (!res?.ok) {
    $("addError").textContent = res?.reason || "Could not add that instance.";
    return;
  }
  $("addDialog").close();
});
// `close` fires for every way out — Add, Cancel, and Escape.
$("addDialog").addEventListener("close", () => window.desktop.setOverlay(false));
$("addCancel").addEventListener("click", () => $("addDialog").close());
$("addUrl").addEventListener("input", () => ($("addError").textContent = ""));
$("addBtn").addEventListener("click", openAdd);
$("emptyAdd").addEventListener("click", openAdd);
$("retry").addEventListener("click", () => current.active && window.desktop.reload(current.active));

window.desktop.onCommand((c) => {
  if (c === "add") openAdd();
});
window.desktop.onState((s) => {
  current = s;
  render();
});
window.desktop.getState().then((s) => {
  current = s;
  render();
});
