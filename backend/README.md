# Local CUDA backend

The frontend remains WynnBuilder. It supplies candidate item pools, actual rolls, powders, selected tomes, abilities, aspects, buffs, targets and ranking priorities to a local service. CUDA produces large batches of equipment combinations and checks complete-loadout skill feasibility. Native CPU validators calculate final combat stats for the shortlist and return functioning builds to the page.

## Start

Use Node.js 22+, Python 3.10+ and a CUDA-capable NVIDIA GPU with a driver compatible with the CUDA 12 NVRTC package.

```sh
pnpm cuda:setup
pnpm cuda:check
pnpm dev
```

Open `http://127.0.0.1:8000/builder/`. Select **CUDA backend** and set the time budget, CPU worker count and CUDA batch size. **Check CUDA backend** verifies driver access and kernel compilation from the page. Driver or compiler failures are displayed explicitly. CPU search modes can be selected manually.

Setup installs NumPy and `nvidia-cuda-nvrtc-cu12` into `backend/.venv`. NVRTC compiles `search.cu` at runtime, so the normal setup uses the NVIDIA driver and packaged compiler. Compiled PTX is cached by source hash, compiler version and GPU compute capability in `backend/.cuda-cache`. NVIDIA's driver also manages its device-code cache.

For Python environments managed elsewhere, install `backend/requirements.txt` there and set `WYNN_CUDA_PYTHON` to that environment's Python executable before starting the server. `WYNN_CUDA_DEVICE` selects a GPU by ordinal, starting at 0. `WYNN_CUDA_NVRTC` can point directly to an NVRTC library. A CUDA driver error about unsupported PTX generally requires a compatible driver/compiler combination. `pnpm cuda:check` prints the underlying CUDA error.

`pnpm preview` serves the generated frontend with this backend. Keep the repository and its backend when running it. The service binds to `127.0.0.1` and shares the frontend's port. It accepts one GPU search at a time.

## Search and calculation boundaries

1. The browser prepares the actual item stats using WynnBuilder's selected game-data version and roll/powder rules.
2. The backend uploads compact item rows to CUDA once per search. The kernel runs 256 threads per block. The default 256 blocks propose 65,536 combinations per batch.
3. Threads select random equipment or mutate/cross over promising builds from previous batches. Locked slots retain their only candidate.
4. CUDA computes net skill support for the entire loadout. It includes the selected guild tome, excludes a piece's own bonus from its requirement, excludes weapon/crafted bonuses as support, and checks the manual point budget and per-skill cap. Borderline floating-point cases receive a small permissive margin and are checked strictly by the native validator.
5. Each block retains a winner under a cheap item-stat proxy and a randomly selected skill-feasible candidate. The proxy covers additive item IDs and a simplified generic damage model. Full abilities, set effects, spell-specific logic and final-stat thresholds are evaluated by the native validators.
6. Up to eight Node worker threads evaluate the shortlist with the same native `Build`, final-stat, ability, aspect, buff, powder and damage functions used by the page. Only candidates passing every target and skill check enter the displayed results. Primary and secondary rankings use these native scores.
7. Near-target candidates and validated elites seed subsequent GPU batches. GPU work overlaps native evaluation. At the deadline the backend returns the best validated builds found. Stopping the search disconnects the stream and terminates its GPU process and validators.

This is an approximate GPU-assisted optimization search. Results have no global optimality guarantee. The GPU proxy can favor different candidates from the full final-stat score. Random block samples and native-scored feedback provide exploration alongside it. Exhaustive CPU mode remains available for restricted pools.

## Tuning

- Start with 65,536 candidates per GPU batch and a 30-second budget.
- CPU workers control native final-stat validation concurrency. Increase this if shortlist evaluation is the bottleneck.
- Larger GPU batches increase proposal volume and also increase the native shortlist. A block produces at most two candidates. The selectable batch sizes range from 4,096 to 1,048,576.
- Locks, level/tier filters and imported pools reduce the equipment space without changing selected items' native calculations.
- Initialization and the last in-flight validation batch add overhead beyond the search budget.

## Verification

`npm test` includes a host-compiled test of the CUDA kernel's shared skill-allocation function against native allocations, when `g++` is installed. `npm run test:integration` tests the local streaming service, native score parity, cancellation and concurrency handling using a clearly identified GPU protocol test double. GPU execution is covered separately by the hardware check.

```sh
pnpm cuda:compile
pnpm cuda:check
```

The first command checks NVRTC compilation without requiring GPU execution. The second loads the driver, selects the device, compiles and loads the module, then launches a deterministic kernel smoke test. Actual kernel launch and performance require NVIDIA hardware. During development here, PTX compilation and host/service tests were verified. A CUDA device was unavailable, so hardware execution and throughput remain unverified.

The loader selects the primary NVRTC library from NVIDIA's wheel and preloads its bundled Windows `nvrtc-builtins64_*.dll`. Alternate `.alt` compiler variants are excluded from automatic discovery. If upgrading from a version that reported `nvrtc-builtins.alt64_129.dll`, pull the loader fix and rerun `pnpm cuda:check` with the dependencies already installed.
