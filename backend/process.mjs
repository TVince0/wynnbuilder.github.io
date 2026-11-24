import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
const localPython = fileURLToPath(
  new URL(
    process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python",
    import.meta.url,
  ),
);
export const python =
  process.env.WYNN_CUDA_PYTHON ||
  (fs.existsSync(localPython)
    ? localPython
    : process.platform === "win32"
      ? "python"
      : "python3");
export const gpuScript =
  process.env.WYNN_CUDA_WORKER_SCRIPT ||
  fileURLToPath(new URL("gpu.py", import.meta.url));
const children = new Set();
export function closeGpuProcesses() {
  for (const child of children) child.kill();
}
process.once("exit", closeGpuProcesses);
export function gpuProcess(args = [], onPid = () => {}, options = {}) {
  const child = (options.spawn || spawn)(python, ["-X", "faulthandler", "-u", gpuScript, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    // JSON protocol text must not depend on the Windows console code page.
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  if (child.pid) onPid(child.pid);
  const queued = [],
    waiting = [];
  let failure,
    pipeError,
    pipeTimer,
    stderr = "";
  const reject = (error) => {
    clearTimeout(pipeTimer);
    failure ??= error;
    for (const waiter of waiting.splice(0)) waiter.reject(failure);
  };
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-5000);
  });
  child.on("error", (error) =>
    reject(new Error(`Cannot start CUDA Python (${python}). ${error.message}`)),
  );
  // Wait for close, rather than exit, so stdout/stderr have been drained.
  // On Windows a child failure can emit "write EOF" before its JSON error.
  child.on("close", (code, signal) => {
    let status = signal ? `signal ${signal}` : `exit code ${code}`;
    if (process.platform === "win32" && code !== null && code !== 0)
      status += ` / 0x${(code >>> 0).toString(16).toUpperCase()}`;
    reject(new Error(
      `CUDA Python worker exited (${status}). ` +
      (stderr.trim() || pipeError?.message || "No Python diagnostic was produced. Run pnpm cuda:check for a standalone hardware check."),
    ));
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line);
      if (value.error) {
        reject(new Error(value.error));
        return;
      }
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(value);
      else queued.push(value);
    } catch (error) {
      reject(error);
    }
  });
  const receive = () => {
    if (queued.length) return Promise.resolve(queued.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  // Pipe errors describe the transport, not why the worker failed. Preserve
  // them as a fallback while allowing the worker's structured error to arrive.
  const onPipeError = (error) => {
    pipeError ??= error;
    // Give stdout/stderr time to drain, including errors emitted after exit.
    // A broken input pipe on a still-live worker must not hang a search forever.
    if (!failure && !pipeTimer) {
      pipeTimer = setTimeout(() => {
        reject(new Error(
          `CUDA Python input pipe closed. ${stderr.trim() || pipeError.message} ` +
          "Run pnpm cuda:check for a standalone hardware check.",
        ));
        child.kill();
      }, 1000);
      pipeTimer.unref();
    }
  };
  const send = (value) => {
    if (failure) return Promise.reject(failure);
    let line;
    try {
      line = JSON.stringify(value) + "\n";
    } catch (error) {
      return Promise.reject(error);
    }
    const response = receive();
    try {
      child.stdin.write(line, (error) => {
        if (error) onPipeError(error);
      });
    } catch (error) {
      onPipeError(error);
    }
    return response;
  };
  child.stdin.on("error", onPipeError);
  return {
    receive,
    send,
    close() {
      reject(new Error("CUDA Python worker was stopped."));
      queued.length = 0;
      child.kill();
      lines.close();
    },
  };
}
