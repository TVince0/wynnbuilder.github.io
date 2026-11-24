"""Coverage stays bounded and repeated proposals do not inflate its estimate."""
from pathlib import Path
import random
import sys
import unittest
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from gpu import estimate_unique


class CoverageTest(unittest.TestCase):
    def test_empty_and_repeated_proposals(self):
        registers = np.zeros(16384, dtype=np.uint32)
        self.assertEqual(estimate_unique(registers), 0)
        for _ in range(10000):
            registers[12] = max(registers[12], 3)
        self.assertEqual(estimate_unique(registers), 1)

    def test_distinct_hashes_and_repeat_stability(self):
        registers = np.zeros(16384, dtype=np.uint32)
        generator = random.Random(1729)
        hashes = [generator.getrandbits(64) for _ in range(50000)]
        def apply():
            for value in hashes:
                bucket = value & 16383
                rank = 51 - (value >> 14).bit_length()
                registers[bucket] = max(registers[bucket], rank)
        apply()
        first = estimate_unique(registers)
        self.assertLess(abs(first-50000)/50000, .04)
        apply()
        self.assertEqual(estimate_unique(registers), first)


if __name__ == '__main__':
    unittest.main()
