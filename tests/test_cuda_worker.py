"""Exercise the actual persistent Python worker without requiring a CUDA device."""
import ctypes as ct
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import gpu


class FakeCuda:
    name = 'Test CUDA device'
    def __init__(self, _device):
        self.arrays = []
        self.closed = False
    def compile(self, _path):
        return 'propose'
    def upload(self, array):
        pointer = ct.c_uint64(len(self.arrays))
        self.arrays.append(array.copy())
        return pointer
    def write(self, pointer, array):
        self.arrays[pointer.value][:] = array
    def read(self, array, pointer):
        array[:] = self.arrays[pointer.value]
    def launch(self, function, blocks, args):
        assert function == 'propose' and len(args) == 17
        self.arrays[5][:] = self.arrays[1]
        self.arrays[6][0] = blocks * 256
        self.arrays[8][:] = 500
        self.arrays[9][12] = 3
    def close(self):
        self.closed = True


class WorkerProtocolTest(unittest.TestCase):
    def run_worker(self, payload, commands):
        source = io.StringIO('\n'.join(json.dumps(row) for row in [payload] + commands) + '\n')
        output = io.StringIO()
        with patch.object(gpu, 'Cuda', FakeCuda), \
             patch.object(sys, 'argv', ['gpu.py']), \
             patch.object(sys, 'stdin', source), \
             patch.object(sys, 'stdout', output):
            gpu.run()
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_large_candidate_payload_and_multiple_batches(self):
        # Larger than a typical packed full catalog and much larger than a pipe buffer.
        sizes = [1000] * 9
        offsets = list(range(0, 9000, 1000))
        payload = dict(items=[[0.] * 32 for _ in range(9000)], offsets=offsets,
                       sizes=sizes, base=[0.] * 47, rings=list(range(9000)),
                       budget=200, objective=2, direction=1, duplicateRings=False, blocks=256)
        rows = self.run_worker(payload, [dict(seed=1729), dict(seed=4294967295, elites=[offsets])])
        self.assertEqual(rows[0], dict(initialized=True, device='Test CUDA device'))
        self.assertTrue(rows[1]['ready'])
        for batch in rows[2:]:
            self.assertEqual(batch['tested'], 65536)
            self.assertEqual(batch['estimatedUnique'], 1)
            self.assertEqual(batch['candidates'], [offsets] * 512)
            self.assertTrue(all(np.isfinite(batch['proxyScores'])))

    def test_driver_failure_precedes_catalog_read(self):
        source = io.StringIO('not JSON and must not be read')
        with patch.object(gpu, 'Cuda', side_effect=RuntimeError('driver failure')), \
             patch.object(sys, 'argv', ['gpu.py']), \
             patch.object(sys, 'stdin', source):
            with self.assertRaisesRegex(RuntimeError, 'driver failure'):
                gpu.run()
        self.assertEqual(source.tell(), 0)
        self.assertEqual(gpu.phase, 'initializing CUDA driver')


if __name__ == '__main__':
    unittest.main()
