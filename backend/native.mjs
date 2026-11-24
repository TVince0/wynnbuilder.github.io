import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const root = fileURLToPath(new URL("..", import.meta.url));
export function nativeContext(request) {
  const context = vm.createContext({
    performance,
    structuredClone,
    setTimeout,
    URL,
    console: { log() {}, warn() {}, error: console.error },
    navigator: { userAgent: "backend" },
    location: new URL("http://127.0.0.1:8000/js/optimizer/worker.js"),
    postMessage() {},
    request,
  });
  context.self = context;
  context.importScripts = (...files) => {
    for (const file of files) {
      const full = path.resolve(root, "js/optimizer", file);
      vm.runInContext(fs.readFileSync(full, "utf8"), context, {
        filename: full,
      });
    }
  };
  vm.runInContext(
    fs.readFileSync(path.join(root, "js/optimizer/worker.js"), "utf8"),
    context,
  );
  vm.runInContext(
    fs.readFileSync(path.join(root, "backend/native_search.js"), "utf8"),
    context,
  );
  vm.runInContext(
    "const prepared = prepareOptimizerRequest(request); const payload = OptimizerCuda.pack(prepared);",
    context,
  );
  return context;
}
