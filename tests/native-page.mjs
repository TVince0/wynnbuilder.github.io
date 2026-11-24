import { Window } from "happy-dom";
import * as idb from "fake-indexeddb";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const project = fileURLToPath(new URL("..", import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : project,
  address = "http://localhost:8000/builder/";
const win = new Window({
  url: address,
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
    disableIframePageLoading: true,
    disableJavaScriptEvaluation: true,
  },
});
for (const [key, value] of Object.entries(idb))
  if (key !== "default") win[key] = value;
win.structuredClone = structuredClone;
win.fetch = async function (input) {
  const url = new URL(input?.url ?? input, address);
  let file = path.join(root, url.pathname);
  return new win.Response(fs.readFileSync(file, "utf8"), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
class WorkerShim {
  constructor(url) {
    const location = new URL(url, address),
      workerPath = path.join(root, location.pathname);
    const ctx = vm.createContext({
      console,
      performance,
      navigator: { userAgent: "worker" },
      location,
      postMessage: (data) => this.onmessage?.({ data: structuredClone(data) }),
    });
    ctx.self = ctx;
    ctx.importScripts = (...files) => {
      for (const file of files)
        vm.runInContext(
          fs.readFileSync(path.join(path.dirname(workerPath), file), "utf8"),
          ctx,
          { filename: file },
        );
    };
    vm.runInContext(fs.readFileSync(workerPath, "utf8"), ctx, {
      filename: workerPath,
    });
    this.ctx = ctx;
  }
  postMessage(data) {
    setTimeout(
      () => this.ctx.self.onmessage({ data: structuredClone(data) }),
      1,
    );
  }
  terminate() {}
}
win.Worker = WorkerShim;
win.HTMLElement.prototype.scrollIntoView = function () {};
win.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
win.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
win.document.write(fs.readFileSync(root + "/builder/index.html", "utf8"));
for (const script of win.document.querySelectorAll("script")) {
  const file =
    script.src && path.join(root, new URL(script.src, address).pathname);
  vm.runInContext(
    file ? fs.readFileSync(file, "utf8") : script.textContent,
    win,
    { filename: file || "inline" },
  );
}
const doc = win.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, message) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await sleep(100);
  }
  throw Error(
    message +
      " " +
      doc.querySelector("#err-box")?.textContent +
      " " +
      doc.querySelector("#optimizer-message")?.textContent,
  );
};
await wait(
  () => doc.getElementById("optimizer-run"),
  "optimizer did not mount",
);
assert.match(doc.getElementById("optimizer-count").textContent, /5,5/);
const names = [
  "Third Eye",
  "Aquarius",
  "Vaward",
  "Memento",
  "Concentration",
  "Prism",
  "Prowess",
  "Diamond Hydro Necklace",
  "Cascade",
];
for (const [i, name] of names.entries()) {
  const input = doc.getElementById(
    [
      "helmet",
      "chestplate",
      "leggings",
      "boots",
      "ring1",
      "ring2",
      "bracelet",
      "necklace",
      "weapon",
    ][i] + "-choice",
  );
  input.value = name;
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}
doc.getElementById("level-choice").value = "106";
doc
  .getElementById("level-choice")
  .dispatchEvent(new win.Event("input", { bubbles: true }));
await sleep(650);
const mode = doc.getElementById("optimizer-mode");
mode.value = "realistic";
mode.dispatchEvent(new win.Event("change", { bubbles: true }));
await sleep(100);
for (const cb of doc.querySelectorAll(".optimizer-pin input"))
  cb.checked = true;
doc.getElementById("optimizer-rules").replaceChildren();
doc.getElementById("optimizer-run").click();
await wait(() => doc.querySelector(".optimizer-result"), "no result");
const stats = vm.runInContext(
  "OptimizerModel.measurements(build_node.get_value())",
  win,
);
assert.ok(Number.isFinite(stats.health));
const resultText = doc.querySelector(".optimizer-result").textContent;
console.log(
  "SEARCH",
  doc.querySelector("#optimizer-message").textContent,
  "stats",
  stats.health,
  stats.regen,
  stats.mr,
);
doc.querySelector(".optimizer-result .optimizer-primary").click();
await sleep(200);
assert.equal(
  vm.runInContext(
    "OptimizerModel.measurements(build_node.get_value()).health",
    win,
  ),
  stats.health,
);
assert.equal(
  vm.runInContext(
    "OptimizerModel.measurements(build_node.get_value()).regen",
    win,
  ),
  stats.regen,
);
doc.querySelector('[aria-label="Edit Helmet actual rolls"]').click();
assert.ok(doc.querySelector(".optimizer-dialog[open]"));
const mr = doc.querySelector(".optimizer-dialog input[data-stat=mr]");
mr.value = "0";
doc
  .querySelector(".optimizer-dialog form")
  .dispatchEvent(new win.Event("submit", { cancelable: true, bubbles: true }));
await sleep(100);
assert.equal(
  vm.runInContext(
    "equip_inputs[0].get_value().statMap.get('maxRolls').get('mr')",
    win,
  ),
  0,
);
assert.ok(win.location.search.includes("optimizer="));
const displayStats = vm.runInContext("stat_agg_node.get_value()", win);
const nativeDefense = vm.runInContext(
  "getDefenseStats(stat_agg_node.get_value())",
  win,
);
const measured = vm.runInContext(
  "OptimizerModel.measurements(build_node.get_value())",
  win,
);
assert.equal(nativeDefense[0], measured.health);
assert.equal(nativeDefense[2], measured.regen);
assert.equal(displayStats.get("mr"), measured.mr);
const beforeGuild = measured.assigned;
const guildName = vm.runInContext(
  "[...tomeMap.values()].find(t=>t.type==='guildTome'&&t.str>0).displayName",
  win,
);
doc.getElementById("guildTome1-choice").value = guildName;
doc
  .getElementById("guildTome1-choice")
  .dispatchEvent(new win.Event("change", { bubbles: true }));
await sleep(75);
doc.getElementById("optimizer-run").click();
await wait(() => doc.querySelector(".optimizer-result"), "guild search");
const withGuild = vm.runInContext(
  "OptimizerModel.measurements(build_node.get_value())",
  win,
);
assert.ok(
  withGuild.assigned < beforeGuild,
  "guild skill bonuses lower the manual allocation",
);
assert.ok(doc.getElementById("optimizer-tome").textContent.includes(guildName));
doc.querySelector(".optimizer-result .optimizer-primary").click();
await sleep(75);
assert.equal(
  vm.runInContext("getDefenseStats(stat_agg_node.get_value())[0]", win),
  withGuild.health,
);

// Reopen the actual native share URL in a fresh document and compute graph.
const reloaded = new Window({
  url: win.location.href,
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
    disableIframePageLoading: true,
    disableJavaScriptEvaluation: true,
  },
});
for (const [key, value] of Object.entries(idb))
  if (key !== "default") reloaded[key] = value;
reloaded.structuredClone = structuredClone;
reloaded.Worker = WorkerShim;
reloaded.fetch = async function (input) {
  const url = new URL(input?.url ?? input, address);
  return new reloaded.Response(
    fs.readFileSync(path.join(root, url.pathname), "utf8"),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
reloaded.HTMLElement.prototype.scrollIntoView = function () {};
reloaded.document.write(fs.readFileSync(root + "/builder/index.html", "utf8"));
for (const script of reloaded.document.querySelectorAll("script")) {
  const file =
    script.src && path.join(root, new URL(script.src, address).pathname);
  vm.runInContext(
    file ? fs.readFileSync(file, "utf8") : script.textContent,
    reloaded,
    { filename: file || "inline" },
  );
}
await wait(
  () => reloaded.document.getElementById("optimizer-run"),
  "share reload",
);
assert.equal(
  vm.runInContext(
    "equip_inputs[0].get_value().statMap.get('maxRolls').get('mr')",
    reloaded,
  ),
  0,
);
assert.equal(
  vm.runInContext("getDefenseStats(stat_agg_node.get_value())[0]", reloaded),
  withGuild.health,
);
assert.equal(
  reloaded.document.getElementById("guildTome1-choice").value,
  guildName,
);
assert.equal(
  reloaded.document.getElementById("optimizer-mode").value,
  "realistic",
);
await reloaded.happyDOM.close();
win.importedData = JSON.parse(
  fs.readFileSync(root + "/data/2.2.6.0/items.json", "utf8"),
);
vm.runInContext("BuildOptimizer.importPool(importedData)", win);
assert.match(
  doc.getElementById("optimizer-message").textContent,
  /native templates/,
);
vm.runInContext("resetFields()", win);
assert.equal(doc.querySelectorAll(".optimizer-pin input:checked").length, 0);
assert.ok(!win.location.search.includes("optimizer="));
console.log(
  "PASS native and built page, search/apply, guild validity, zero rolls, share reload, JSON import and reset",
);
await win.happyDOM.close();
