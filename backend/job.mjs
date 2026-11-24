import { parentPort, workerData, Worker } from "node:worker_threads";
import vm from "node:vm";
import { nativeContext } from "./native.mjs";
import { gpuProcess } from "./process.mjs";
const validators = [];
let stopped = false,
  gpu;
function stop() {
  stopped = true;
  gpu?.close();
  for (const validator of validators) validator.worker.terminate();
}
parentPort.on("message", (message) => {
  if (message.cancel) stop();
});
function validator(request) {
  const worker = new Worker(new URL("validate.mjs", import.meta.url), {
    workerData: request,
  });
  let pending, failure;
  const ready = new Promise((resolve, reject) => {
    pending = { resolve, reject };
  });
  worker.on("message", (message) => {
    if (message.error) pending?.reject(new Error(message.error));
    else pending?.resolve(message);
    pending = null;
  });
  worker.on("error", (error) => {
    failure = error;
    pending?.reject(error);
  });
  worker.on("exit", (code) => {
    failure = new Error(`Native validator exited (${code}).`);
    pending?.reject(failure);
  });
  const instance = {
    worker,
    ready,
    evaluate(indices) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        worker.postMessage({ indices });
      });
    },
  };
  validators.push(instance);
  return instance;
}
async function run() {
  const request = workerData;
  const context = nativeContext(request);
  const payload = structuredClone(vm.runInContext("payload", context));
  const compare = vm.runInContext(
    "OptimizerSearch.createComparator(request.config)",
    context,
  );
  const config = request.config;
  parentPort.postMessage({
    progress: {
      message: "Initializing CUDA and native validators…",
      cuda: true,
    },
  });
  gpu = gpuProcess([], (pid) => parentPort.postMessage({ pid }));
  const readyGpu = gpu.send(payload);
  const count = Math.max(1, Math.min(8, config.workers || 1));
  for (let i = 0; i < count; i++) validator(request);
  const [device] = await Promise.all([
    readyGpu,
    ...validators.map((member) => member.ready),
  ]);
  if (stopped) return;
  const archive = new Map(),
    best = new Map(),
    seen = new Set();
  const start = performance.now(),
    end = start + config.seconds * 1000;
  let tested = 0,
    feasible = 0,
    evaluated = 0,
    cycles = 0;
  const indicesFor = (pieces) =>
    pieces.map((piece, slot) => {
      const index = request.pools[slot].findIndex(
        (entry) => entry.key === piece.key,
      );
      return index < 0 ? undefined : payload.offsets[slot] + index;
    });
  let elites = [];
  if (config.initial) {
    const initial = indicesFor(config.initial.map((key) => ({ key })));
    if (initial.every((index) => index !== undefined)) elites.push(initial);
  }
  const progress = () => ({
    cuda: true,
    fast: true,
    device: device.device,
    tested,
    feasible,
    evaluated,
    examined: String(tested),
    elapsed: (performance.now() - start) / 1000,
    workers: count,
    total: String(
      request.pools.reduce((n, pool) => n * BigInt(pool.length), 1n),
    ),
    builds: [...best.values()].sort(compare).slice(0, config.limit),
  });
  let pending = gpu.send({ elites, seed: Date.now() >>> 0 });
  while (!stopped && performance.now() < end) {
    const batch = await pending;
    tested += batch.tested;
    feasible += batch.feasible;
    // Overlap the next CUDA batch with CPU final-stat evaluation of this shortlist.
    pending = gpu.send({
      elites,
      seed: (Date.now() + ++cycles * 2654435761) >>> 0,
    });
    pending.catch(() => {});
    const unique = [];
    for (const tuple of batch.candidates) {
      const identity = tuple.map(
        (index, slot) => request.pools[slot][index - payload.offsets[slot]].key,
      );
      if (config.ringSymmetric && identity[4] > identity[5])
        [identity[4], identity[5]] = [identity[5], identity[4]];
      const key = JSON.stringify(identity);
      if (seen.has(key)) continue;
      if (seen.size > 200000) seen.clear();
      seen.add(key);
      unique.push(tuple);
    }
    const chunk = Math.ceil(unique.length / count);
    const responses = await Promise.all(
      validators.map((member, index) =>
        member.evaluate(unique.slice(index * chunk, (index + 1) * chunk)),
      ),
    );
    evaluated += unique.length;
    if (stopped) return;
    for (const { rows } of responses)
      for (const row of rows) {
        archive.set(row.signature, row);
        if (row.violation === 0) best.set(row.signature, row);
      }
    const population = [...archive.values()]
      .sort((a, b) => a.violation - b.violation || compare(a, b))
      .slice(0, 80);
    archive.clear();
    for (const row of population) archive.set(row.signature, row);
    elites = population.map((row) => row.indices);
    const ranked = [...best.values()].sort(compare).slice(0, config.limit);
    best.clear();
    for (const row of ranked) best.set(row.signature, row);
    parentPort.postMessage({ progress: progress() });
  }
  pending.catch(() => {});
  if (!stopped)
    parentPort.postMessage({ result: { ...progress(), complete: false } });
}
try {
  await run();
} catch (error) {
  if (!stopped)
    parentPort.postMessage({ error: error.message || String(error) });
} finally {
  stop();
  parentPort.close();
}
