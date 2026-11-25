import { Worker } from "node:worker_threads";
import { gpuProcess, closeGpuProcesses } from "./process.mjs";
let active = null,
  probePromise = null;
export function shutdownCuda() {
  active?.cancel?.();
  closeGpuProcesses();
}
process.once("exit", () => {
  if (active?.pid) {
    try {
      process.kill(active.pid);
    } catch {}
  }
});
export function revive(_key, value) {
  if (value && typeof value === "object") {
    if (value.__wynnType === "Map") return new Map(value.value);
    if (value.__wynnType === "Set") return new Set(value.value);
  }
  return value;
}
function validate(request) {
  if (
    !Array.isArray(request.pools) ||
    request.pools.length !== 9 ||
    request.pools.some((pool) => !Array.isArray(pool) || !pool.length)
  )
    throw Error("CUDA search needs nine nonempty item pools.");
  const entries = request.pools.flat();
  if (
    entries.length > 100000 ||
    entries.some(
      (entry) => typeof entry.key !== "string" || !(entry.map instanceof Map),
    )
  )
    throw Error("Invalid or oversized CUDA item pools.");
  const config = request.config;
  if (config) config.cudaShortlist ??= 256;
  if(config?.seedBuilds!=null && (!Array.isArray(config.seedBuilds)||config.seedBuilds.length>8||config.seedBuilds.some(seed=>!Array.isArray(seed)||seed.length!==9||seed.some(key=>typeof key!=='string'))))
    throw Error('Starting builds must contain up to eight arrays of nine item keys.');
  for(const key of ['repairSeeds','excludeCrafted','excludeGuildTome'])
    if(config?.[key]!=null && typeof config[key]!=='boolean')throw Error('Invalid repair option: '+key);
  if (
    !config ||
    !Number.isInteger(config.level) ||
    config.level < 1 ||
    config.level > 121 ||
    !Number.isInteger(config.workers) ||
    config.workers < 1 ||
    config.workers > 8 ||
    !Number.isInteger(config.limit) ||
    config.limit < 1 ||
    config.limit > 100 ||
    !Number.isInteger(config.cudaBlocks) ||
    config.cudaBlocks < 16 ||
    config.cudaBlocks > 4096 ||
    !Number.isInteger(config.cudaShortlist) ||
    config.cudaShortlist < 32 ||
    config.cudaShortlist > 4096 ||
    typeof config.objective !== "string" ||
    !config.finalContext ||
    !Array.isArray(config.rules) ||
    !Array.isArray(request.tomes) ||
    request.tomes.some((map) => !(map instanceof Map)) ||
    !Array.isArray(request.sets)
  )
    throw Error("Invalid CUDA search configuration.");
}
async function probe() {
  if (!probePromise) {
    const child = gpuProcess(["--probe"]);
    let timeout;
    probePromise = Promise.race([
      child.receive(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(Error("CUDA initialization timed out.")),
          30000,
        );
      }),
    ])
      .catch((error) => ({ available: false, error: error.message }))
      .finally(() => {
        clearTimeout(timeout);
        child.close();
        setTimeout(() => {
          probePromise = null;
        }, 10000).unref();
      });
  }
  return probePromise;
}
export async function handleCuda(req, res) {
  const url = new URL(req.url, "http://" + req.headers.host);
  if (!url.pathname.startsWith("/api/cuda/")) return false;
  const expectedOrigin = "http://" + req.headers.host;
  if (req.headers.origin && req.headers.origin !== expectedOrigin) {
    res.writeHead(403, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        error: "CUDA requests must originate from this local site.",
      }),
    );
    return true;
  }
  if (url.pathname === "/api/cuda/status" && req.method === "GET") {
    res
      .writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(JSON.stringify(await probe()));
    return true;
  }
  if (url.pathname !== "/api/cuda/search" || req.method !== "POST") {
    res.writeHead(404).end();
    return true;
  }
  if (active) {
    res.writeHead(409).end(
      JSON.stringify({
        error:
          "A CUDA search is already running. Stop it before starting another.",
      }),
    );
    return true;
  }
  // Reserve the GPU while reading the request as well as during execution.
  const reservation = {};
  active = reservation;
  let worker,
    pid,
    timer,
    done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (pid) {
      try {
        process.kill(pid);
      } catch {}
    }
    if (worker) {
      worker.postMessage({ cancel: true });
      const force = setTimeout(() => worker.terminate(), 1500);
      force.unref();
      worker.once("exit", () => clearTimeout(force));
    }
    if (active === reservation) active = null;
  };
  reservation.cancel = () => {
    cleanup();
    res.end();
  };
  res.on("close", cleanup);
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw Error("CUDA request exceeds 64 MB.");
      chunks.push(chunk);
    }
    if (done) return true;
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"), revive);
    validate(request);
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.flushHeaders();
    worker = new Worker(new URL("job.mjs", import.meta.url), {
      workerData: request,
    });
    const send = (data) => {
      if (done || (data.progress && res.writableLength > 256 * 1024)) return;
      res.write(JSON.stringify(data) + "\n");
    };
    worker.on("message", (message) => {
      if (message.pid) {
        pid = message.pid;
        reservation.pid = pid;
        if (done) {
          try {
            process.kill(pid);
          } catch {}
        }
        return;
      }
      if (message.progress?.phase === "searching") clearTimeout(timer);
      if (message.error) console.error(`[CUDA search] ${message.error}`);
      send(message);
      if (message.result || message.error) {
        cleanup();
        res.end();
      }
    });
    worker.on("error", (error) => {
      send({ error: error.message });
      cleanup();
      res.end();
    });
    worker.on("exit", (code) => {
      if (!done) {
        send({ error: `CUDA search exited unexpectedly (${code}).` });
        cleanup();
        res.end();
      }
    });
    timer = setTimeout(() => {
      send({
        error: "CUDA initialization timed out.",
      });
      cleanup();
      res.end();
    }, 120000);
    timer.unref();
  } catch (error) {
    if (!res.headersSent)
      res.writeHead(400, { "Content-Type": "application/json" });
    if (!done) res.end(JSON.stringify({ error: error.message }) + "\n");
    cleanup();
  }
  return true;
}
