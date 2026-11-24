import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import { nativeContext } from "./native.mjs";
try {
  const context = nativeContext(workerData);
  parentPort.postMessage({ ready: true });
  parentPort.on("message", (message) => {
    try {
      context.indices = message.indices;
      const rows = vm.runInContext(
        "OptimizerCuda.evaluateBatch(prepared, payload, indices)",
        context,
      );
      parentPort.postMessage({ rows });
    } catch (error) {
      parentPort.postMessage({ error: error.message });
    }
  });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
