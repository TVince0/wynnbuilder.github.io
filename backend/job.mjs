import { parentPort, workerData, Worker } from "node:worker_threads";
import vm from "node:vm";
import { nativeContext } from "./native.mjs";
import { gpuProcess } from "./process.mjs";
import { ProgressGate, RollingSet, RecentRates } from "./search_state.mjs";
import { NeighborhoodQueue, guide } from './neighborhood.mjs';
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
  const poolKeys = structuredClone(vm.runInContext('prepared.pools.map(pool=>pool.map(entry=>entry.key))',context));
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
  const readyGpu = (async () => {
    const initialized = await gpu.receive();
    if (!initialized.initialized)
      throw Error("Unexpected CUDA startup response. Restart pnpm dev after updating the backend.");
    return gpu.send(payload);
  })();
  const count = Math.max(1, Math.min(8, config.workers || 1));
  for (let i = 0; i < count; i++) validator(request);
  const [device] = await Promise.all([
    readyGpu,
    ...validators.map((member) => member.ready),
  ]);
  if (stopped) return;
  const archive = new Map(),
    best = new Map(),
    seen = new RollingSet(),
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
    gpuRoundTripMs = 0,
    nativeMs = 0,
    producerError,
    closest = null,
    firstValidSeconds = null,
    candidates = 0,
    duplicates = 0,
    duplicateAverage = 0,
    explorationBatches = 0,
    buildRevision = 0,
    previousBest = "",
    bestGuideViolation = Infinity,
    nativeSkillValid = 0,
    systematicEvaluations = 0;
  const local = config.repairSeeds ? new NeighborhoodQueue(payload) : null;
  const seeds = [];
  const progressGate = new ProgressGate();
  const recent = new RecentRates(start, {tested, evaluated, candidates, duplicates});
  const identity = (tuple) => {
    const local = tuple.map((index, slot) => index - payload.offsets[slot]);
    if (config.ringSymmetric && local[4] > local[5])
      [local[4], local[5]] = [local[5], local[4]];
    return local.join(",");
  };
  const indicesFor = (pieces) =>
    pieces.map((piece, slot) => {
      const index = poolKeys[slot].indexOf(piece.key);
      return index < 0 ? undefined : payload.offsets[slot] + index;
    });
  let elites = [];
  const suppliedStarts=[...(config.seedBuilds||[])];
  if(config.repairSeeds && config.initialComplete && config.initial)suppliedStarts.unshift(config.initial);
  for(const keys of suppliedStarts){
    if(!Array.isArray(keys)||keys.length!==9)continue;
    const tuple=indicesFor(keys.map(key=>({key})));
    if(tuple.every(index=>index!==undefined)&&!seeds.some(row=>identity(row.tuple)===identity(tuple))){
      const estimate=guide(payload,tuple);
      seeds.push({key:identity(tuple),tuple,source:'seed',proxy:estimate.score,violation:-1});
      elites.push(tuple);
    }
  }
  if (!elites.length && config.initial) {
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
    gpuMs, gpuRoundTripMs,
    nativeMs,
    shortlist, closest, firstValidSeconds, buildRevision, nativeSkillValid,
    repair:local?{evaluated:systematicEvaluations,expanded:local.expanded.size,pending:Math.max(0,local.rows.length-local.cursor),seeds:seeds.length}:null,
    rates: recent.read(performance.now(), {tested, evaluated, candidates, duplicates}),
    pipeline: {pending:proposals.size, cacheSize:seen.size, cacheLimit:seen.capacity, cacheEvictions:seen.evictions, explorationBatches},
    guidedRules: payload.guidedRules,
    totalRules: config.rules.filter(rule => rule.min != null || rule.max != null).length,
    examined: String(tested),
    elapsed: (performance.now() - start) / 1000,
    workers: count,
    total: payload.total,
    builds: [...best.values()].sort(compare).slice(0, config.limit),
  });
  // GPU and native completions share one cap. Native micro-batches must not
  // bypass it and flood worker/HTTP/browser queues with repeated build lists.
  const report = () => {
    if (!stopped && progressGate.due(performance.now()))
      parentPort.postMessage({ progress: progress() });
  };
  report();
  // A bounded reservoir keeps native validation independent of CUDA batch size.
  function select(values, limit) {
    const half = Math.ceil(limit / 2);
    const chosen = new Map(
      values
        .slice()
        .sort((a, b) => a.violation - b.violation || b.proxy - a.proxy)
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
      const serial = ++cycles;
      // When reduced proposals repeat heavily, periodically explore without
      // parents. Keep the validated archive and best builds throughout.
      const fresh = elites.length > 0 && duplicateAverage >= .8 && serial % 4 === 0;
      if (fresh) explorationBatches++;
      const roundTripStart = performance.now();
      const batch = await gpu.send({
        elites: fresh ? [] : elites,
        seed: (Date.now() + Math.imul(serial, 2654435761)) >>> 0,
      });
      if (stopped) break;
      gpuRoundTripMs = performance.now()-roundTripStart;
      tested += batch.tested;
      feasible += batch.feasible;
      gpuMs = batch.gpuMs || 0;
      estimatedUnique = batch.estimatedUnique ?? estimatedUnique;
      let batchDuplicates = 0;
      candidates += batch.candidates.length;
      for (const [index, tuple] of batch.candidates.entries()) {
        const key = identity(tuple);
        if (!seen.has(key) && !proposals.has(key))
          proposals.set(key, {
            key,
            tuple,
            proxy: batch.proxyScores?.[index] || 0,
            violation: batch.violations?.[index] || 0,
            ticket: Math.random(),
          });
        else batchDuplicates++;
      }
      duplicates += batchDuplicates;
      if (batch.candidates.length) duplicateAverage = duplicateAverage*.85 + .15*batchDuplicates/batch.candidates.length;
      if (proposals.size > capacity) {
        const retained = select([...proposals.values()], capacity);
        proposals.clear();
        for (const row of retained) proposals.set(row.key, row);
      }
      wake?.();
      wake = null;
      report();
    }
  })().catch((error) => {
    if (!stopped) producerError = error;
    wake?.();
    wake = null;
  });
  while (!stopped) {
    if (producerError) throw producerError;
    if (!proposals.size && !seeds.length && !local?.hasWork) {
      await new Promise((resolve) => {
        wake = resolve;
      });
      continue;
    }
    const chosen=seeds.splice(0,shortlist).filter(row=>!seen.has(row.key));
    if(local)chosen.push(...local.take(Math.max(0,Math.min(shortlist-chosen.length,proposals.size?Math.ceil(shortlist/2):shortlist)),seen));
    const chosenKeys=new Set(chosen.map(row=>row.key));
    chosen.push(...select([...proposals.values()].filter(row=>!chosenKeys.has(row.key)&&!seen.has(row.key)),shortlist-chosen.length));
    if(!chosen.length){await new Promise(resolve=>setTimeout(resolve,0));continue;}
    const unique = chosen.map((row) => row.tuple);
    systematicEvaluations+=chosen.filter(row=>row.source==='seed'||row.source==='local').length;
    for (const row of chosen) {
      proposals.delete(row.key);
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
        if(row.functioning){
          nativeSkillValid++;
          if(!closest||row.violation<closest.violation||(row.violation===closest.violation&&compare(row,closest)<0)){
            closest=row;local?.offer(row);
          }
        }
        if(row.violation<bestGuideViolation){bestGuideViolation=row.violation;local?.offer(row);}
        if (row.violation === 0 && row.functioning) {
          best.set(row.signature, row);
          firstValidSeconds ??= (performance.now() - start) / 1000;
        }
      }
    const rows = [...archive.values()];
    const ordered = rows.slice().sort((a, b) => a.violation - b.violation || compare(a, b));
    const selected = new Map(ordered.slice(0, 40).map(row => [row.signature, row]));
    const add = (candidates, count) => {
      for (const row of candidates.slice(0, count)) if (selected.size < 80) selected.set(row.signature, row);
    };
    // Preserve offensive champions and candidates missing different requirements.
    // This prevents a single recovery-heavy local optimum replacing all parents.
    add(rows.filter(row => row.functioning).sort(compare), 8);
    for (const rule of config.rules) {
      const gap = row => {
        const value = row.stats[rule.stat];
        return (rule.min == null ? 0 : Math.max(0, rule.min-value)/Math.max(1,Math.abs(rule.min)))
          + (rule.max == null ? 0 : Math.max(0,value-rule.max)/Math.max(1,Math.abs(rule.max)));
      };
      add(rows.slice().sort((a,b) => (a.violation-gap(a))-(b.violation-gap(b)) || compare(a,b)), 6);
    }
    add(ordered, 80);
    const population = [...selected.values()];
    archive.clear();
    for (const row of population) archive.set(row.signature, row);
    elites = population.map((row) => row.indices);
    // Only skill-valid native rows may be presented as the closest attempt.
    // Infeasible parents remain internal repair hints.
    const ranked = [...best.values()].sort(compare).slice(0, config.limit);
    best.clear();
    for (const row of ranked) best.set(row.signature, row);
    const fingerprint = JSON.stringify(ranked.map(row => [row.signature, row.score]));
    if (fingerprint !== previousBest) {previousBest = fingerprint; buildRevision++;}
    report();
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
