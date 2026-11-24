"""Small CUDA Driver/NVRTC bridge. Kernels are compiled once per device/source version."""
import ctypes as ct
import ctypes.util
import hashlib
import importlib.util
import os
from pathlib import Path
import sys

_dll_handles = []

def load_nvrtc():
    candidates = [os.environ.get("WYNN_CUDA_NVRTC"), ctypes.util.find_library("nvrtc")]
    try:
        spec = importlib.util.find_spec("nvidia.cuda_nvrtc")
    except ModuleNotFoundError:
        spec = None
    if spec and spec.submodule_search_locations:
        for root in spec.submodule_search_locations:
            candidates += [str(p) for p in Path(root).glob("**/*nvrtc*.*") if "builtins" not in p.name]
    cuda_path = os.environ.get("CUDA_PATH")
    if cuda_path:
        candidates += [str(p) for p in Path(cuda_path).glob("bin/nvrtc64*.dll") if "builtins" not in p.name]
        candidates += [str(p) for p in Path(cuda_path).glob("lib64/libnvrtc.so*")]
    for filename in candidates:
        if filename:
            try:
                # NVRTC locates its companion builtins library alongside itself.
                if sys.platform == "win32" and os.path.isabs(filename):
                    _dll_handles.append(os.add_dll_directory(str(Path(filename).parent)))
                return ct.CDLL(filename)
            except OSError:
                pass
    raise RuntimeError("NVRTC is unavailable. Install backend/requirements.txt into the Python selected by WYNN_CUDA_PYTHON, or set WYNN_CUDA_NVRTC.")


def compile_kernel(source, architecture):
    lib = load_nvrtc()
    program = ct.c_void_p()
    lib.nvrtcCreateProgram.argtypes = [ct.POINTER(ct.c_void_p), ct.c_char_p, ct.c_char_p, ct.c_int, ct.c_void_p, ct.c_void_p]
    lib.nvrtcCompileProgram.argtypes = [ct.c_void_p, ct.c_int, ct.POINTER(ct.c_char_p)]
    for name in ["nvrtcGetProgramLogSize", "nvrtcGetPTXSize"]:
        getattr(lib, name).argtypes = [ct.c_void_p, ct.POINTER(ct.c_size_t)]
    for name in ["nvrtcGetProgramLog", "nvrtcGetPTX"]:
        getattr(lib, name).argtypes = [ct.c_void_p, ct.c_void_p]
    lib.nvrtcDestroyProgram.argtypes = [ct.POINTER(ct.c_void_p)]
    status = lib.nvrtcCreateProgram(ct.byref(program), source, b"search.cu", 0, None, None)
    if status:
        raise RuntimeError(f"nvrtcCreateProgram failed ({status})")
    try:
        options = [b"--std=c++14", b"--fmad=false", f"--gpu-architecture=compute_{architecture}".encode()]
        result = lib.nvrtcCompileProgram(program, len(options), (ct.c_char_p * len(options))(*options))
        size = ct.c_size_t()
        lib.nvrtcGetProgramLogSize(program, ct.byref(size))
        log = ct.create_string_buffer(size.value)
        lib.nvrtcGetProgramLog(program, log)
        if result:
            raise RuntimeError("CUDA kernel compilation failed. " + log.value.decode(errors="replace"))
        lib.nvrtcGetPTXSize(program, ct.byref(size))
        ptx = ct.create_string_buffer(size.value)
        lib.nvrtcGetPTX(program, ptx)
        return ptx.raw
    finally:
        lib.nvrtcDestroyProgram(ct.byref(program))


class Cuda:
    def __init__(self, device_index=0):
        try:
            self.lib = ct.CDLL("nvcuda.dll" if sys.platform == "win32" else "libcuda.so.1")
        except OSError as error:
            raise RuntimeError("NVIDIA CUDA driver is unavailable. Install an NVIDIA driver and run on a CUDA-capable GPU.") from error
        self.allocations = []
        self.module = ct.c_void_p()
        self.context = ct.c_void_p()
        self.device = ct.c_int()
        signatures = {
            "cuInit": [ct.c_uint], "cuDeviceGet": [ct.POINTER(ct.c_int), ct.c_int],
            "cuDeviceGetName": [ct.c_void_p, ct.c_int, ct.c_int],
            "cuDeviceGetAttribute": [ct.POINTER(ct.c_int), ct.c_int, ct.c_int],
            "cuDevicePrimaryCtxRetain": [ct.POINTER(ct.c_void_p), ct.c_int],
            "cuDevicePrimaryCtxRelease": [ct.c_int], "cuCtxSetCurrent": [ct.c_void_p],
            "cuMemAlloc_v2": [ct.POINTER(ct.c_uint64), ct.c_size_t], "cuMemFree_v2": [ct.c_uint64],
            "cuMemcpyHtoD_v2": [ct.c_uint64, ct.c_void_p, ct.c_size_t],
            "cuMemcpyDtoH_v2": [ct.c_void_p, ct.c_uint64, ct.c_size_t],
            "cuModuleLoadData": [ct.POINTER(ct.c_void_p), ct.c_void_p],
            "cuModuleUnload": [ct.c_void_p],
            "cuModuleGetFunction": [ct.POINTER(ct.c_void_p), ct.c_void_p, ct.c_char_p],
            "cuLaunchKernel": [ct.c_void_p] + [ct.c_uint]*7 + [ct.c_void_p, ct.c_void_p, ct.c_void_p],
            "cuCtxSynchronize": [], "cuGetErrorString": [ct.c_int, ct.POINTER(ct.c_char_p)],
        }
        for name, args in signatures.items():
            getattr(self.lib, name).argtypes = args
        self.call("cuInit", 0)
        self.call("cuDeviceGet", ct.byref(self.device), device_index)
        name = ct.create_string_buffer(256)
        self.call("cuDeviceGetName", name, len(name), self.device)
        self.name = name.value.decode(errors="replace")
        major, minor = ct.c_int(), ct.c_int()
        self.call("cuDeviceGetAttribute", ct.byref(major), 75, self.device)
        self.call("cuDeviceGetAttribute", ct.byref(minor), 76, self.device)
        self.architecture = f"{major.value}{minor.value}"
        self.call("cuDevicePrimaryCtxRetain", ct.byref(self.context), self.device)
        self.call("cuCtxSetCurrent", self.context)

    def call(self, name, *args):
        status = getattr(self.lib, name)(*args)
        if status:
            description = ct.c_char_p()
            self.lib.cuGetErrorString(status, ct.byref(description))
            detail = description.value.decode() if description.value else str(status)
            raise RuntimeError(f"{name}: {detail}")

    def compile(self, source_path):
        source = Path(source_path).read_bytes()
        # Include NVRTC version because generated PTX must match the installed driver.
        nvrtc = load_nvrtc()
        major, minor = ct.c_int(), ct.c_int()
        nvrtc.nvrtcVersion(ct.byref(major), ct.byref(minor))
        key = hashlib.sha256(source + f"{self.architecture}/{major.value}/{minor.value}".encode()).hexdigest()
        cache = Path(__file__).parent / ".cuda-cache"
        cache.mkdir(exist_ok=True)
        target = cache / (key + ".ptx")
        ptx = target.read_bytes() if target.exists() else compile_kernel(source, self.architecture)
        if not target.exists():
            temp = target.with_suffix(f".{os.getpid()}.tmp")
            temp.write_bytes(ptx)
            temp.replace(target)
        self.call("cuModuleLoadData", ct.byref(self.module), ct.create_string_buffer(ptx))
        function = ct.c_void_p()
        self.call("cuModuleGetFunction", ct.byref(function), self.module, b"propose")
        return function

    def upload(self, array):
        pointer = ct.c_uint64()
        self.call("cuMemAlloc_v2", ct.byref(pointer), max(1, array.nbytes))
        self.allocations.append(pointer)
        self.write(pointer, array)
        return pointer

    def write(self, pointer, array):
        self.call("cuMemcpyHtoD_v2", pointer, array.ctypes.data, array.nbytes)

    def read(self, array, pointer):
        self.call("cuMemcpyDtoH_v2", array.ctypes.data, pointer, array.nbytes)

    def launch(self, function, blocks, arguments):
        pointers = (ct.c_void_p * len(arguments))(*(ct.cast(ct.byref(value), ct.c_void_p) for value in arguments))
        self.call("cuLaunchKernel", function, blocks, 1, 1, 256, 1, 1, 0, None, pointers, None)
        self.call("cuCtxSynchronize")

    def close(self):
        for pointer in self.allocations:
            self.lib.cuMemFree_v2(pointer)
        if self.module.value:
            self.lib.cuModuleUnload(self.module)
        if self.context.value:
            self.lib.cuDevicePrimaryCtxRelease(self.device)
