import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const backend = fileURLToPath(new URL(".", import.meta.url));
const initial =
  process.env.WYNN_CUDA_PYTHON ||
  (process.platform === "win32" ? "python" : "python3");
const venv = path.join(backend, ".venv");
const python = path.join(
  venv,
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
for (const [command, args] of [
  [initial, ["-m", "venv", venv]],
  [
    python,
    ["-m", "pip", "install", "-r", path.join(backend, "requirements.txt")],
  ],
]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(
      result.error?.message ||
        "CUDA dependency setup failed. Python 3.10+ and pip/venv are required.",
    );
    process.exit(1);
  }
}
console.log("CUDA dependencies installed. Run pnpm cuda:check, then pnpm dev.");
