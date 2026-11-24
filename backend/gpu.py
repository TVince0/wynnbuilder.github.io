"""Persistent CUDA batch worker. Newline JSON is only used between batches."""
import ctypes as ct
import json
from pathlib import Path
import sys
import traceback
from cuda_runtime import Cuda, compile_kernel


def emit(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def run():
    if "--compile-only" in sys.argv:
        ptx = compile_kernel(Path(__file__).with_name("search.cu").read_bytes(), "75")
        emit({"compiled": True, "ptxBytes": len(ptx)})
        return
    cuda = Cuda(int(__import__('os').environ.get('WYNN_CUDA_DEVICE', '0')))
    try:
        import numpy as np
        probe = "--probe" in sys.argv
        if probe:
            request = {"items": [[0.0]*32 for _ in range(9)], "offsets": list(range(9)),
                "sizes": [1]*9, "base": [0.0]*47, "rings": list(range(9)),
                "budget": 200, "objective": 2, "direction": 1, "duplicateRings": False, "blocks": 16}
            request["base"][26] = 500
        else:
            request = json.loads(sys.stdin.readline())
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
        function = cuda.compile(Path(__file__).with_name("search.cu"))
        elites = np.zeros((80, 9), dtype=np.int32)
        output = np.empty((blocks * 2, 9), dtype=np.int32)
        valid = np.zeros(1, dtype=np.uint32)
        pointers = [cuda.upload(value) for value in [items, offsets, sizes, base, elites, output, valid, rings]]
        def batch(command):
            rows = command.get("elites", [])[:80]
            if rows:
                elites[:len(rows)] = rows
            cuda.write(pointers[4], elites)
            valid[0] = 0
            cuda.write(pointers[6], valid)
            args = pointers[:5] + [ct.c_int(len(rows)), ct.c_int(request['budget']), ct.c_int(request['objective']),
                ct.c_int(request['direction']), ct.c_int(int(request['duplicateRings'])), pointers[7],
                ct.c_uint(command['seed']), pointers[5], pointers[6]]
            cuda.launch(function, blocks, args)
            cuda.read(output, pointers[5])
            cuda.read(valid, pointers[6])
            return {"candidates": output[output[:, 0] >= 0].tolist(), "tested": blocks * 256, "feasible": int(valid[0])}
        if probe:
            sample = batch({"seed": 1729})
            if sample["feasible"] != 4096 or sample["candidates"] != [list(range(9))]*32:
                raise RuntimeError("CUDA smoke test returned unexpected candidates")
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
        emit({"error": str(error)})
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
