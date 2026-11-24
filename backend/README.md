# Local CUDA backend

The frontend remains WynnBuilder. It supplies candidate item pools, actual rolls, powders, selected tomes, abilities, aspects, buffs, targets and ranking priorities to a local service. CUDA produces large batches of equipment combinations, measures skill and target shortfalls, and repairs promising candidates. Native CPU validators calculate final combat stats for the shortlist and return functioning builds to the page.

## Start

Use Node.js 22+, Python 3.10+ and a CUDA-capable NVIDIA GPU with a driver compatible with the CUDA 12 NVRTC package.

```sh
pnpm cuda:setup
pnpm cuda:check
pnpm dev
```

Open `http://127.0.0.1:8000/builder/`. Select **CUDA backend** and set the CPU worker count, CUDA batch size and native shortlist size. **Check CUDA backend** verifies driver access and kernel compilation from the page. Driver or compiler failures are displayed explicitly. CPU search modes can be selected manually.

Setup installs NumPy and `nvidia-cuda-nvrtc-cu12` into `backend/.venv`. NVRTC compiles `search.cu` at runtime, so the normal setup uses the NVIDIA driver and packaged compiler. Compiled PTX is cached by source hash, compiler version and GPU compute capability in `backend/.cuda-cache`. NVIDIA's driver also manages its device-code cache.

For Python environments managed elsewhere, install `backend/requirements.txt` there and set `WYNN_CUDA_PYTHON` to that environment's Python executable before starting the server. `WYNN_CUDA_DEVICE` selects a GPU by ordinal, starting at 0. `WYNN_CUDA_NVRTC` can point directly to an NVRTC library. A CUDA driver error about unsupported PTX generally requires a compatible driver/compiler combination. `pnpm cuda:check` prints the underlying CUDA error.

`pnpm preview` serves the generated frontend with this backend. Keep the repository and its backend when running it. The service binds to `127.0.0.1` and shares the frontend's port. It accepts one GPU search at a time.

## Search and calculation boundaries

1. The browser prepares the actual item stats using WynnBuilder's selected game-data version and roll/powder rules.
2. The backend uploads compact item rows to CUDA once per search. The kernel runs 256 threads per block. The default 256 blocks propose 65,536 combinations per batch.
3. Threads select random equipment or mutate/cross over promising builds from previous batches. Locked slots retain their only candidate.
4. CUDA computes net skill support for the entire loadout. It includes the selected guild tome, excludes a piece's own bonus from its requirement, excludes weapon/crafted bonuses as support, and measures manual point budget and per-skill cap violations. Near-feasible states may remain as search parents, allowing later pieces to repair skill gaps. Every accepted result passes strict native skill validation.
5. Target bounds are compiled dynamically into GPU guidance. All numeric item ID targets are supported, alongside proxies for HP, final HP regen, mana with base, total mana, effective HP, assigned/total skills and generic damage. GPU checks are soft guidance because abilities, set effects, buffs and conversions can alter native results. Unsupported targets remain native-only and the page reports the guidance count. The generic damage proxy includes elemental raw/percentage damage, weapon powder damage, raw distribution, elemental skill boosts and expected critical damage.
6. Blocks alternate between aggregate target fitness, objective exploration and target specialists. Elite offspring receive small one/two-piece repair tournaments. Each block retains a guided winner and an exploratory sample. Locked slots retain their exact items and rolls. An independent random population remains available for exploration.
7. Up to eight Node worker threads evaluate the shortlist with the same native `Build`, final-stat, ability, aspect, buff, powder and damage functions used by the page. Only candidates passing every target and skill check enter the displayed results. Invalid intermediate states are reported only as search diagnostics. Primary and secondary rankings use these native scores.
8. Near-target candidates and validated elites seed subsequent GPU batches. The native parent population preserves closest candidates, offensive champions and alternatives with different shortfalls. A continuous GPU producer fills a bounded reservoir while native validators process a separate shortlist. CUDA batch size and native shortlist size are independent. The search runs until stopped. Stopping it disconnects the stream and terminates its GPU process and validators.

This is an approximate GPU-assisted optimization search. Results have no global optimality guarantee. The GPU proxy can favor different candidates from the full final-stat score. Search fitness prioritizes reducing target shortfalls while retaining specialist and objective exploration. Random block samples and native-scored feedback provide exploration alongside it. Exhaustive CPU mode remains available for restricted pools.

## Progress and tuning

- Searches run until stopped or a result is applied. The initialization watchdog applies only while the CUDA process and validators start.
- The progress panel shows the closest native-evaluated attempt and its remaining shortfalls until a matching build is found, then the time to the first matching build. Coverage is an exploration statistic, not an ETA or a feasibility proof.
- The progress panel shows estimated distinct GPU combinations checked out of the total allowed candidate combinations, raw GPU proposals, native evaluations, elapsed time and throughput.
- CUDA coverage uses a 16,384-register HyperLogLog sketch in fixed memory. Repeated proposals hash to the same registers. It is a statistical estimate and can reach approximately 100% without an exhaustive completion proof. The total accounts for ring symmetry and the duplicate-ring setting. Native evaluations can include revisits after the bounded deduplication cache rolls over.
- CUDA base batch size is the number of initial proposal threads per kernel launch. Repair tournaments add candidate checks; the raw proposal counter includes those checks. Native shortlist size limits how many candidates are sent to the CPU in one validation cycle, independently of batch size.
- Start with 65,536 GPU proposals per batch and a native shortlist of 256. Compare 262,144 proposals on an RTX 4070 SUPER using the displayed proposal and native-evaluation rates. A larger batch amortizes launch/transfer overhead, increases per-launch work and delays feedback until the batch completes. Its best setting depends on the CPU and selected abilities as well as the GPU.
- The GPU producer keeps screening while CPUs validate previous candidates. High CPU use is expected with many native workers because full WynnBuilder calculations still execute there. GPU batch timings cover launch and synchronization. Native timings cover a complete validation cycle across workers. These stages overlap.
- The selectable CUDA batch sizes range from 4,096 to 1,048,576 proposals. Native shortlists range from 64 to 1,024 candidates. Smaller native shortlists reduce the work per cycle while keeping the GPU proposal count independent.
- Locks, level/tier filters and imported pools reduce the equipment space without changing selected items' native calculations.

## Verification

`npm test` includes a host-compiled test of the CUDA kernel's shared skill-allocation function against native allocations, when `g++` is installed. `npm run test:integration` tests the local streaming service, native score parity, cancellation and concurrency handling using a clearly identified GPU protocol test double. GPU execution is covered separately by the hardware check.

```sh
pnpm cuda:compile
pnpm cuda:check
```

The first command checks NVRTC compilation without requiring GPU execution. The second loads the driver, selects the device, compiles and loads the module, then launches a deterministic kernel smoke test. Actual kernel launch and performance require NVIDIA hardware. During development here, PTX compilation and host/service tests were verified. A CUDA device was unavailable, so hardware execution and throughput remain unverified.

The loader selects the primary NVRTC library from NVIDIA's wheel and preloads its bundled Windows `nvrtc-builtins64_*.dll`. Alternate `.alt` compiler variants are excluded from automatic discovery. If upgrading from a version that reported `nvrtc-builtins.alt64_129.dll`, pull the loader fix and rerun `pnpm cuda:check` with the dependencies already installed.

## Worker startup failures

If Find builds reports an error, the page and the `pnpm dev` terminal show the CUDA worker's diagnostic, including the initialization stage. The service waits for the worker to initialize its driver before sending the item catalog. Python protocol text uses UTF-8 on Windows regardless of the terminal code page.

A bare `write EOF` or `EPIPE` comes from the Node-to-Python input pipe closing; it does not identify the underlying CUDA problem. The transport preserves Python's structured error or drained stderr instead of letting a pipe error hide it. Native crashes with no Python traceback report their process exit status (including the hexadecimal status on Windows). Run `pnpm cuda:check` to check the same driver, compiler and kernel independently of the browser. After pulling backend changes, restart `pnpm dev`.
