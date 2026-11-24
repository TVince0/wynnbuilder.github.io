"""DLL selection regressions matching NVIDIA's Windows 12.9.86 wheel."""
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class LoaderTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("cuda_loader_test", ROOT / "backend/cuda_runtime.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory(prefix=".cuda-test-", dir=ROOT)
        self.directory = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def files(self, names):
        for name in names:
            target = self.directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()

    def test_windows_wheel_selects_primary_and_preloads_companion(self):
        self.files(["bin/nvrtc64_120_0.alt.dll", "bin/nvrtc64_120_0.dll",
                    "bin/nvrtc-builtins64_129.dll", "include/nvrtc.h"])
        spec = SimpleNamespace(submodule_search_locations=[str(self.directory)])
        with patch.object(self.module.sys, "platform", "win32"), \
             patch.object(self.module.importlib.util, "find_spec", return_value=spec), \
             patch.object(self.module.ct.util, "find_library", return_value=None), \
             patch.object(self.module.os, "add_dll_directory", create=True) as add_directory, \
             patch.object(self.module.ct, "CDLL") as load, \
             patch.dict(os.environ, {"WYNN_CUDA_NVRTC": "", "CUDA_PATH": ""}):
            first = self.module.load_nvrtc()
            self.assertIs(first, self.module.load_nvrtc())
            self.assertEqual([Path(call.args[0]).name for call in load.call_args_list],
                             ["nvrtc-builtins64_129.dll", "nvrtc64_120_0.dll"])
            add_directory.assert_called_once_with(str(self.directory / "bin"))

    def test_linux_wheel_excludes_alternate_compiler(self):
        self.files(["lib/libnvrtc.alt.so.12", "lib/libnvrtc.so.12", "lib/libnvrtc-builtins.so.12.9"])
        with patch.object(self.module.sys, "platform", "linux"):
            paths = self.module.primary_nvrtc_files(self.directory)
        self.assertEqual([Path(path).name for path in paths], ["libnvrtc.so.12"])

    def test_missing_windows_companion_reports_its_directory(self):
        self.files(["bin/nvrtc64_120_0.dll"])
        with patch.object(self.module.sys, "platform", "win32"), \
             patch.object(self.module.os, "add_dll_directory", create=True), \
             patch.object(self.module.ct, "CDLL") as load, \
             patch.dict(os.environ, {"WYNN_CUDA_NVRTC": str(self.directory / "bin/nvrtc64_120_0.dll")}):
            with self.assertRaisesRegex(RuntimeError, "nvrtc-builtins64_"):
                self.module.load_nvrtc()
            load.assert_not_called()


if __name__ == "__main__":
    unittest.main()
