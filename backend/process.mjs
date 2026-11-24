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
export function gpuProcess(args = [], onPid = () => {}) {
  const child = spawn(python, ["-u", gpuScript, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (child.pid) onPid(child.pid);
  const queued = [],
    waiting = [];
  let failure,
    stderr = "";
  const reject = (error) => {
    failure = error;
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  };
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-5000);
  });
  child.on("error", (error) =>
    reject(new Error(`Cannot start CUDA Python (${python}). ${error.message}`)),
  );
  child.on("exit", (code) => {
    if (code !== 0 || !queued.length)
      reject(new Error(`CUDA process exited (${code}). ${stderr}`));
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
  const send = (value) => {
    if (failure) return Promise.reject(failure);
    child.stdin.write(JSON.stringify(value) + "\n");
    return receive();
  };
  child.stdin.on("error", (error) => reject(error));
  return {
    receive,
    send,
    close() {
      child.kill();
      lines.close();
    },
  };
}
