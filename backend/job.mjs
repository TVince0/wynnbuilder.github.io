import { parentPort, workerData, Worker } from "node:worker_threads";
import vm from "node:vm";
import { nativeContext } from "./native.mjs";
import { gpuProcess } from "./process.mjs";
const validators = [];
let stopped = false,
  gpu,
  wake;
function stop() {
  stopped = true;
  wake?.();
  wake = null;
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
  if (payload.total === "0")
    throw Error("The current ring selections allow no candidate combinations.");
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
    seen = new Set(),
    proposals = new Map();
  const start = performance.now();
  const shortlist = config.cudaShortlist || 256;
  const capacity = Math.max(512, shortlist * 4);
  let tested = 0,
    feasible = 0,
    evaluated = 0,
    cycles = 0,
    estimatedUnique = 0;
  let gpuMs = 0,
    nativeMs = 0,
    lastReport = 0,
    producerError;
  const identity = (tuple) => {
    const local = tuple.map((index, slot) => index - payload.offsets[slot]);
    if (config.ringSymmetric && local[4] > local[5])
      [local[4], local[5]] = [local[5], local[4]];
    return local.join(",");
  };
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
    phase: "searching",
    fast: true,
    device: device.device,
    tested,
    feasible,
    evaluated,
    estimatedUnique: Math.min(estimatedUnique, Number(payload.total)),
    gpuMs,
    nativeMs,
    shortlist,
    examined: String(tested),
    elapsed: (performance.now() - start) / 1000,
    workers: count,
    total: payload.total,
    builds: [...best.values()].sort(compare).slice(0, config.limit),
  });
  const report = (force) => {
    if (!stopped && (force || performance.now() - lastReport >= 250)) {
      parentPort.postMessage({ progress: progress() });
      lastReport = performance.now();
    }
  };
  report(true);
  // A bounded reservoir keeps native validation independent of CUDA batch size.
  function select(values, limit) {
    const half = Math.ceil(limit / 2);
    const chosen = new Map(
      values
        .slice()
        .sort((a, b) => b.proxy - a.proxy)
        .slice(0, half)
        .map((row) => [row.key, row]),
    );
    for (const row of values.slice().sort((a, b) => b.ticket - a.ticket)) {
      if (chosen.size >= limit) break;
      chosen.set(row.key, row);
    }
    return [...chosen.values()];
  }
  // Keep the GPU producer running while native validators process prior proposals.
  const producer = (async () => {
    while (!stopped) {
      const batch = await gpu.send({
        elites,
        seed: (Date.now() + Math.imul(++cycles, 2654435761)) >>> 0,
      });
      if (stopped) break;
      tested += batch.tested;
      feasible += batch.feasible;
      gpuMs = batch.gpuMs || 0;
      estimatedUnique = batch.estimatedUnique ?? estimatedUnique;
      for (const [index, tuple] of batch.candidates.entries()) {
        const key = identity(tuple);
        if (!seen.has(key) && !proposals.has(key))
          proposals.set(key, {
            key,
            tuple,
            proxy: batch.proxyScores?.[index] || 0,
            ticket: Math.random(),
          });
      }
      if (proposals.size > capacity) {
        const retained = select([...proposals.values()], capacity);
        proposals.clear();
        for (const row of retained) proposals.set(row.key, row);
      }
      wake?.();
      wake = null;
      report(false);
    }
  })().catch((error) => {
    if (!stopped) producerError = error;
    wake?.();
    wake = null;
  });
  while (!stopped) {
    if (producerError) throw producerError;
    if (!proposals.size) {
      await new Promise((resolve) => {
        wake = resolve;
      });
      continue;
    }
    const chosen = select([...proposals.values()], shortlist);
    const unique = chosen.map((row) => row.tuple);
    for (const row of chosen) {
      proposals.delete(row.key);
      if (seen.size >= 200000) seen.clear();
      seen.add(row.key);
    }
    const chunk = Math.ceil(unique.length / count);
    const before = performance.now();
    const responses = await Promise.all(
      validators.map((member, index) =>
        member.evaluate(unique.slice(index * chunk, (index + 1) * chunk)),
      ),
    );
    nativeMs = performance.now() - before;
    evaluated += unique.length;
    if (stopped) break;
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
    report(true);
  }
  await producer;
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
