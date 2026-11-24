import { Window } from "happy-dom";
import * as idb from "fake-indexeddb";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const project = fileURLToPath(new URL("..", import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : project;
const server = spawn(process.execPath, [path.join(project, "scripts/serve.mjs"), root], {
  env: { ...process.env, PORT: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});
process.on("exit", () => server.kill());
const [ready] = await Promise.race([
  once(server.stdout, "data"),
  once(server, "exit").then(([code]) => { throw Error("Server exited with code " + code); }),
]);
const address = String(ready).match(/http:\/\/[^\s]+/)[0];
function createWindow(url) {
  const window = new Window({
    url,
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      disableIframePageLoading: true,
      disableJavaScriptEvaluation: true,
    },
  });
  for (const [key, value] of Object.entries(idb))
    if (key !== "default") window[key] = value;
  window.structuredClone = structuredClone;
  window.Worker = WorkerShim;
  window.fetch = (input, options) => fetch(new URL(input?.url ?? input, url), options);
  window.HTMLElement.prototype.scrollIntoView = function () {};
  return window;
}
async function openBuilder(window) {
  const page = await fetch(window.location.href);
  assert.equal(page.status, 200);
  window.document.write(await page.text());
  const theme = window.document.querySelector('link[rel="stylesheet"][href$="/optimizer.css"]');
  assert.ok(theme, "The served builder must load the optimizer stylesheet");
  const css = await fetch(theme.href);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  for (const script of window.document.querySelectorAll("script")) {
    let source = script.textContent;
    if (script.src) {
      const response = await fetch(script.src);
      assert.equal(response.status, 200, script.src);
      assert.match(response.headers.get("content-type"), /javascript/, script.src);
      source = await response.text();
    }
    vm.runInContext(source, window, { filename: script.src || "inline" });
  }
}
let lastRequest;
class WorkerShim {
  constructor(url) {
    const location = new URL(url, address),
      workerPath = path.join(root, location.pathname);
    const ctx = vm.createContext({
      console,
      performance,
      structuredClone,
      setTimeout,
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
    if (data.pools) lastRequest = structuredClone(data);
    setTimeout(
      () => this.ctx.self.onmessage({ data: structuredClone(data) }),
      1,
    );
  }
  terminate() {}
}
const win = createWindow(address);
win.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
win.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
await openBuilder(win);
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
assert.equal(doc.getElementById("optimizer-strategy").value, "cuda");
doc.getElementById("optimizer-strategy").value = "exhaustive";
doc.getElementById("optimizer-strategy").dispatchEvent(new win.Event("change", {bubbles:true}));
assert.ok(doc.getElementById("optimizer-lock-helmet").disabled);
doc.getElementById("optimizer-edit-helmet").click();
assert.equal(doc.activeElement, doc.getElementById("helmet-choice"));
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
assert.equal(doc.getElementById("optimizer-piece-helmet").textContent, "HelmetThird Eye");
assert.ok(!doc.getElementById("optimizer-lock-helmet").disabled);
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
// Native final-node parity with active abilities and buffs, independent of the worker.
vm.runInContext(`
  for (const entry of atree_node.get_value()) {
    const state = atree_state_node.get_value().get(entry.ability.id);
    atree_set_state(state, true);
    atree_state_node.mark_dirty().update();
    if (atree_validate.get_value()[1].length) {
      atree_set_state(state, false);
      atree_state_node.mark_dirty().update();
    }
  }
  document.getElementById('radiance-boost').classList.add('toggleOn');
  radiance_node.mark_dirty().update();
`, win);
const parity = vm.runInContext(`(() => {
  const build = build_node.get_value();
  const candidate = OptimizerFinal.measurements(build, OptimizerFinal.snapshot());
  const live = OptimizerFinal.values(build, stat_agg_node.get_value(), atree_collect_spells.get_value());
  return {candidate, live};
})()`, win);
for (const [key, value] of Object.entries(parity.live)) {
  if (Number.isFinite(value)) assert.ok(Math.abs(parity.candidate[key] - value) < 1e-7, key + ' final parity');
}
assert.equal(doc.querySelector('.optimizer-dialog input[data-stat=hp]'), null);
// Cached structures must not freeze candidate-dependent stats or requested metrics.
const selectedChecks = vm.runInContext(`(() => {
  const original = build_node.get_value();
  const context = OptimizerFinal.snapshot();
  const requested = new Set(['health', 'regen', 'genericSpellHit']);
  return [0, 150, -50].map(delta => {
    const helmet = OptimizerModel.fromMap(original.equipment[0].statMap);
    helmet.statMap.set('hp', (helmet.statMap.get('hp') || 0) + delta);
    const build = OptimizerModel.assemble(original.level, [helmet, ...original.equipment.slice(1)], original.tomes, original.weapon);
    const full = OptimizerFinal.measurements(build, structuredClone(context));
    const reduced = OptimizerFinal.measurements(build, context, requested);
    return [...requested].map(key => [key, full[key], reduced[key]]);
  });
})()`, win);
for (const checks of selectedChecks) for (const [key, expected, actual] of checks) {
  assert.ok(Math.abs(expected - actual) < 1e-7, key + ' cached candidate parity');
}
const genericChecks = vm.runInContext(`(() => {
  const build = build_node.get_value();
  const stats = new Map(stat_agg_node.get_value());
  const spells = new Map();
  const score = () => OptimizerFinal.values(build, stats, spells).genericSpellHit;
  const base = score();
  stats.set('damMult', new Map(stats.get('damMult')));
  stats.get('damMult').set('Test:2.Blink DPS', 9999);
  const specific = score();
  stats.set('sdRaw', stats.get('sdRaw') + 100);
  const raw = score();
  stats.set('sdPct', stats.get('sdPct') + 100);
  return {base, specific, raw, percent:score()};
})()`, win);
assert.equal(genericChecks.base, genericChecks.specific);
assert.ok(genericChecks.raw > genericChecks.base);
assert.ok(genericChecks.percent > genericChecks.raw);
doc.getElementById('optimizer-add-ranking').click();
assert.equal(doc.querySelectorAll('.optimizer-secondary-row').length, 1);
assert.deepEqual(JSON.parse(win.localStorage.getItem('wynnbuilder.optimizer.v1')).secondary, [{stat:'health',direction:'max'}]);
const spellKey = Object.keys(parity.live).find(key => key.startsWith('spell:') && !key.includes(':0:') && !key.includes('cost'));
assert.ok(spellKey, 'selected abilities expose spell metrics');
const spellOption = doc.createElement('option');
spellOption.value = spellKey;
doc.getElementById('optimizer-objective').append(spellOption);
doc.getElementById('optimizer-objective').value = spellKey;
doc.getElementById('optimizer-run').click();
await wait(() => doc.querySelector('.optimizer-result'), 'final spell search');
assert.ok(doc.querySelector('.optimizer-result-title').textContent.includes(Number(parity.live[spellKey]).toLocaleString(undefined, {maximumFractionDigits: 2})), 'worker final spell score equals the native graph');
vm.runInContext(`document.getElementById('radiance-boost').classList.remove('toggleOn'); radiance_node.mark_dirty().update();`, win);
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
assert.equal(doc.getElementById("optimizer-tome"), null);
doc.querySelector(".optimizer-result .optimizer-primary").click();
await sleep(75);
assert.equal(
  vm.runInContext("getDefenseStats(stat_agg_node.get_value())[0]", win),
  withGuild.health,
);

const expectedCudaScore = vm.runInContext("OptimizerFinal.measurements(build_node.get_value(), OptimizerFinal.snapshot())", win)[lastRequest.config.objective];

// Reopen the actual native share URL in a fresh document and compute graph.
const reloaded = createWindow(win.location.href);
await openBuilder(reloaded);
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
// A missing startup file must replace the loading message on either cache path.
for (const [suffix, fresh] of [["/atree.json", false], ["/compress.json", true]]) {
  const failed = createWindow(address);
  if (fresh) failed.indexedDB = new idb.IDBFactory();
  const read = failed.fetch;
  failed.fetch = (input, options) => read(
    input.endsWith(suffix) ? new URL("/missing-test-data.json", address).href : input,
    options,
  );
  await openBuilder(failed);
  await wait(() => {
    const message = failed.document.getElementById("build-optimizer").textContent;
    return message.includes(suffix) && message.includes("HTTP 404");
  }, "missing data should identify the failed file on the page: " + suffix);
  await failed.happyDOM.close();
}
// Exercise the real local service and native validation using a protocol-only GPU test double.
// Kernel compilation and shared C++ formula tests are separate from this transport test.
const cudaTemp = fs.mkdtempSync(path.join(project, ".cuda-test-"));
const protocol = path.join(cudaTemp, "protocol.py");
fs.writeFileSync(protocol, [
  "import sys,json,time,pathlib",
  "def emit(value): print(json.dumps(value),flush=True)",
  "if '--probe' in sys.argv:",
  " emit({'available':True,'device':'Protocol test device'});sys.exit(0)",
  "if pathlib.Path(__file__).with_suffix('.fail').exists():",
  " emit({'error':'CUDA worker failed while initializing CUDA driver: simulated search startup failure'});sys.exit(1)",
  "emit({'initialized':True,'device':'Protocol test device'})",
  "request=json.loads(sys.stdin.readline())",
  "emit({'ready':True,'device':'Protocol test device'})",
  "for line in sys.stdin:",
  " json.loads(line);time.sleep(.02)",
  " emit({'tested':4096,'feasible':1,'candidates':[request['offsets']],'proxyScores':[1.0],'estimatedUnique':1,'gpuMs':.1})",
].join("\n"));
const cudaServer = spawn(process.execPath,[path.join(project,"scripts/serve.mjs"),root],{
  env:{...process.env,PORT:"0",WYNN_CUDA_WORKER_SCRIPT:protocol},stdio:["ignore","pipe","inherit"],
});
try {
  const [ready] = await once(cudaServer.stdout,"data");
  const origin = new URL(String(ready).match(/http:\/\/[^\s]+/)[0]).origin;
  const status = await (await fetch(origin+"/api/cuda/status")).json();
  assert.equal(status.device,"Protocol test device");
  const encode=(_key,value)=>value instanceof Map?{__wynnType:"Map",value:[...value]}:value instanceof Set?{__wynnType:"Set",value:[...value]}:value;
  const request=structuredClone(lastRequest);
  Object.assign(request.config,{strategy:"cuda",seconds:1,workers:2,cudaBlocks:16});
  const body=JSON.stringify(request,encode);
  const send=(signal)=>fetch(origin+"/api/cuda/search",{method:"POST",headers:{"Content-Type":"application/json"},body,signal});
  assert.equal((await fetch(origin+"/api/cuda/search",{method:"POST",headers:{Origin:"https://other.example"},body})).status,403);
  assert.equal((await fetch(origin+"/api/cuda/search",{method:"POST",body:"{}"})).status,400);
  const controller = new AbortController();
  const interrupted = await send(controller.signal);
  assert.equal(interrupted.status,200);
  assert.equal((await send()).status,409);
  controller.abort();
  await sleep(250);
  const completedController=new AbortController();
  const completed=await send(completedController.signal);
  assert.equal(completed.status,200);
  const reader=completed.body.getReader(), decoder=new TextDecoder();
  let buffer='', running;
  while(!running || running.elapsed < 1.3 || !running.builds.length) {
    const {value,done}=await reader.read();
    assert.ok(!done,"CUDA search must continue past the legacy one-second limit");
    buffer+=decoder.decode(value,{stream:true});
    let newline;
    while((newline=buffer.indexOf("\n"))>=0) {
      const event=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);
      assert.ok(!event.error,event.error);
      assert.ok(!event.result,"CUDA must run until stopped");
      if(event.progress?.phase === "searching")running=event.progress;
    }
  }
  assert.equal(running.estimatedUnique,1);
  assert.ok(BigInt(running.total)>=1n);
  assert.ok(Math.abs(running.builds[0].score-expectedCudaScore)<1e-7,"backend score must equal the native page");
  completedController.abort();
  await sleep(250);
  fs.writeFileSync(protocol.replace(/\.py$/, ".fail"), "");
  const failedSearch = await send();
  const failedEvents = (await failedSearch.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(failedEvents.at(-1).error, "CUDA worker failed while initializing CUDA driver: simulated search startup failure");
  assert.ok(!failedEvents.at(-1).error.includes("write EOF"));
  console.log("PASS CUDA service protocol, native validation parity, origin checks, busy handling and cancellation (test GPU process)");
} finally {cudaServer.kill();fs.rmSync(cudaTemp,{recursive:true,force:true});}
console.log(
  "PASS native and built page, search/apply, guild validity, zero rolls, share reload, JSON import and reset",
);
await win.happyDOM.close();
server.kill();
