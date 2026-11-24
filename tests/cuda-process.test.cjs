const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");

async function mockProcess(write) {
  const { gpuProcess } = await import("../backend/process.mjs");
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new EventEmitter();
  child.stdin.write = write;
  child.kill = () => child.emit("close", null, "SIGTERM");
  const channel = gpuProcess([], undefined, { spawn: () => child });
  return { child, channel };
}

test("CUDA transport preserves the Python error when Windows write EOF arrives first", async () => {
  const { child, channel } = await mockProcess((_line, callback) => {
    const error = Object.assign(new Error("write EOF"), { code: "EOF" });
    callback(error);
    child.stdin.emit("error", error);
    setImmediate(() => {
      child.emit("exit", 1);
      child.stdout.write(JSON.stringify({ error: "CUDA worker failed while initializing CUDA driver: driver mismatch" }) + "\n");
      child.stderr.write("Python traceback: driver mismatch\n");
      child.emit("close", 1);
    });
  });
  try {
    await assert.rejects(channel.send({ items: [] }), /initializing CUDA driver: driver mismatch/);
    await assert.rejects(channel.send({ seed: 1 }), /driver mismatch/);
  } finally { channel.close(); }
});

test("CUDA transport drains stderr after process exit before reporting an input pipe failure", async () => {
  const { child, channel } = await mockProcess((_line, callback) => {
    callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    child.emit("exit", 1);
    setImmediate(() => {
      child.stderr.write("ImportError: cannot load CUDA companion DLL\n");
      child.emit("close", 1);
    });
  });
  try {
    await assert.rejects(channel.send({ items: [] }), /exit code 1.*ImportError: cannot load CUDA companion DLL/);
  } finally { channel.close(); }
});

test("CUDA transport keeps a final response and rejects subsequent reads after a clean exit", async () => {
  const { child, channel } = await mockProcess(() => {});
  child.emit("exit", 0);
  child.stdout.write('{"available":true}\n');
  child.emit("close", 0);
  try {
    assert.deepEqual(await channel.receive(), { available: true });
    await assert.rejects(channel.receive(), /exit code 0/);
  } finally { channel.close(); }
});

test("stopping a CUDA process rejects outstanding reads", async () => {
  const { channel } = await mockProcess(() => {});
  const pending = channel.receive();
  channel.close();
  await assert.rejects(pending, /worker was stopped/);
});

test("CUDA transport identifies failures to launch Python", async () => {
  const { child, channel } = await mockProcess(() => {});
  const pending = channel.receive();
  child.emit("error", new Error("spawn ENOENT"));
  try {
    await assert.rejects(pending, /Cannot start CUDA Python.*spawn ENOENT/);
  } finally { channel.close(); }
});

test("a broken CUDA input pipe cannot leave a still-live worker hanging", async () => {
  const { child, channel } = await mockProcess((_line, callback) => callback(new Error("write EOF")));
  // The watchdog itself is unref'ed so it cannot keep a real server alive.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(channel.send({ seed: 1 }), /CUDA Python input pipe closed.*write EOF/);
  } finally { clearTimeout(keepAlive); channel.close(); }
});

test("real Python pipe handles a multi-megabyte catalog and UTF-8 independently of console encoding", async () => {
  const { gpuProcess } = await import("../backend/process.mjs");
  const source = [
    "import sys,json",
    "print(json.dumps({'initialized':True}),flush=True)",
    "for line in sys.stdin:",
    " data=json.loads(line)",
    " print(json.dumps({'length':len(data['items']),'name':data['name'],'encoding':sys.stdin.encoding}),flush=True)",
  ].join("\n");
  const channel = gpuProcess([], undefined, {
    spawn: (python, _args, options) => spawn(python, ["-u", "-c", source], options),
  });
  try {
    assert.equal((await channel.receive()).initialized, true);
    const payload = { items: "x".repeat(4 * 1024 * 1024), name: "Tűz – 輝き" };
    const result = await channel.send(payload);
    assert.equal(result.length, payload.items.length);
    assert.equal(result.name, payload.name);
    assert.match(result.encoding, /utf-?8/i);
    assert.equal((await channel.send({ items: "x", name: "next batch" })).length, 1);
  } finally { channel.close(); }
});

test("real Python startup failure survives a concurrent large catalog write", async () => {
  const { gpuProcess } = await import("../backend/process.mjs");
  const source = "import sys,json; print(json.dumps({'error':'CUDA worker failed: simulated driver exception'}),flush=True); sys.exit(1)";
  const channel = gpuProcess([], undefined, {
    spawn: (python, _args, options) => spawn(python, ["-u", "-c", source], options),
  });
  try {
    await assert.rejects(channel.send({ items: "x".repeat(4 * 1024 * 1024) }), /simulated driver exception/);
  } finally { channel.close(); }
});
