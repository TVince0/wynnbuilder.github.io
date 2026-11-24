"""Persistent CUDA batch worker. Newline JSON is only used between batches."""
import ctypes as ct
import json
from pathlib import Path
import sys
import traceback
import time
from cuda_runtime import Cuda, compile_kernel

phase = "starting Python worker"


def emit(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def estimate_unique(coverage):
    import numpy as np
    registers = coverage.astype(np.int32)
    buckets = len(registers)
    zeros = int(np.count_nonzero(registers == 0))
    estimate = (0.7213 / (1 + 1.079 / buckets)) * buckets * buckets / np.exp2(-registers).sum()
    if estimate <= 2.5 * buckets and zeros:
        estimate = buckets * np.log(buckets / zeros)
    return round(float(estimate))


def run():
    global phase
    if "--compile-only" in sys.argv:
        ptx = compile_kernel(Path(__file__).with_name("search.cu").read_bytes(), "75")
        emit({"compiled": True, "ptxBytes": len(ptx)})
        return
    phase = "initializing CUDA driver"
    cuda = Cuda(int(__import__('os').environ.get('WYNN_CUDA_DEVICE', '0')))
    try:
        phase = "loading NumPy"
        import numpy as np
        probe = "--probe" in sys.argv
        if probe:
            request = {"items": [[0.0]*32 for _ in range(9)], "offsets": list(range(9)),
                "sizes": [1]*9, "base": [0.0]*47, "rings": list(range(9)),
                "budget": 200, "objective": 1, "direction": 1, "duplicateRings": False, "blocks": 16,
                "rules": [[1, 100, 1e300, 100]], "ruleFeatures": [[0.0] for _ in range(9)], "ruleBase": [0.0],
                "combat": [[0.0]*42 for _ in range(9)], "combatBase": [0.0]*42}
            request["base"][26] = 500
            request["combat"][8][0] = request["combat"][8][1] = 100
        else:
            # Do not let Node write a large catalog while CUDA is initializing.
            emit({"initialized": True, "device": cuda.name})
            phase = "reading candidate data"
            request = json.loads(sys.stdin.readline())
        phase = "preparing GPU arrays"
        items = np.ascontiguousarray(request["items"], dtype=np.float64)
        offsets = np.asarray(request["offsets"], dtype=np.int32)
        sizes = np.asarray(request["sizes"], dtype=np.int32)
        base = np.asarray(request["base"], dtype=np.float64)
        rings = np.asarray(request["rings"], dtype=np.int32)
        if items.ndim != 2 or items.shape[1] != 32 or len(base) != 47 or len(sizes) != 9 or min(sizes) < 1:
            raise ValueError("Invalid compiled GPU item layout")
        blocks = int(request.get("blocks", 256))
        if not 16 <= blocks <= 4096:
            raise ValueError("CUDA blocks must be between 16 and 4096")
        phase = "compiling and loading CUDA kernel"
        function = cuda.compile(Path(__file__).with_name("search.cu"))
        elites = np.zeros((80, 9), dtype=np.int32)
        output = np.empty((blocks * 2, 9), dtype=np.int32)
        valid = np.zeros(2, dtype=np.uint32)
        scores = np.empty(blocks * 2, dtype=np.float64)
        coverage = np.zeros(16384, dtype=np.uint32)
        rules = np.asarray(request.get("rules", []), dtype=np.float64).reshape(-1, 4)
        rule_count = len(rules)
        features = np.asarray(request.get("ruleFeatures", []), dtype=np.float64).reshape(len(items), rule_count)
        rule_base = np.asarray(request.get("ruleBase", []), dtype=np.float64)
        errors = np.empty(blocks * 2, dtype=np.float64)
        combat = np.asarray(request.get('combat', np.zeros((len(items), 42))), dtype=np.float64).reshape(len(items),42)
        combat_base = np.asarray(request.get('combatBase', [0.]*42), dtype=np.float64)
        if len(rule_base) != rule_count:
            raise ValueError("Invalid GPU target layout")
        phase = "allocating GPU memory"
        pointers = [cuda.upload(value) for value in [items, offsets, sizes, base, elites, output, valid, rings, scores, coverage, features, rule_base, rules, errors, combat, combat_base]]
        def batch(command):
            rows = command.get("elites", [])[:80]
            if rows:
                elites[:len(rows)] = rows
            cuda.write(pointers[4], elites)
            valid[:] = 0
            cuda.write(pointers[6], valid)
            args = pointers[:5] + [ct.c_int(len(rows)), ct.c_int(request['budget']), ct.c_int(request['objective']),
                ct.c_int(request['direction']), ct.c_int(int(request['duplicateRings'])), pointers[7],
                ct.c_uint(command['seed']), pointers[5], pointers[6], pointers[8], pointers[9],
                ct.c_int(int(request.get('ringSymmetric', False))), pointers[10], pointers[11], pointers[12],
                ct.c_int(rule_count), pointers[13], pointers[14], pointers[15]]
            started = time.perf_counter()
            cuda.launch(function, blocks, args)
            gpu_ms = (time.perf_counter() - started) * 1000
            cuda.read(output, pointers[5])
            cuda.read(valid, pointers[6])
            cuda.read(scores, pointers[8])
            cuda.read(coverage, pointers[9])
            cuda.read(errors, pointers[13])
            # HyperLogLog keeps bounded memory over an unlimited stochastic search.
            estimate = estimate_unique(coverage)
            mask = output[:, 0] >= 0
            return {"candidates": output[mask].tolist(), "proxyScores": scores[mask].tolist(),
                "violations": errors[mask].tolist(), "tested": int(valid[1]), "feasible": int(valid[0]), "estimatedUnique": estimate,
                "gpuMs": gpu_ms}
        phase = "running CUDA batches"
        if probe:
            sample = batch({"seed": 1729})
            if sample["feasible"] != 4096 or sample["candidates"] != [list(range(9))]*32 or sample["estimatedUnique"] != 1 or sample["violations"] != [0.0]*32 or sample["proxyScores"] != [100.0]*32:
                raise RuntimeError("CUDA smoke test returned unexpected candidates")
            repeated = batch({"seed": 999, "elites": [list(range(9))]})
            if repeated["estimatedUnique"] != 1:
                raise RuntimeError("CUDA repeated proposals inflated the coverage estimate")
            emit({"available": True, "device": cuda.name, "computeCapability": cuda.architecture, "kernelSmokeTest": True})
            return
        emit({"ready": True, "device": cuda.name, "batchSize": blocks * 256})
        for line in sys.stdin:
            emit(batch(json.loads(line)))
    finally:
        cuda.close()


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        emit({"error": f"CUDA worker failed while {phase}: {type(error).__name__}: {error}"})
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
