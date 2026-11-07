import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import {
  buildChildEnv, createHarness, OwnedResources, parseProcStat, RpcSession,
  selectOwnedProcesses, validateVersions,
} from "../e2e/harness.ts";
import { createMockLlm, encodeAssistantSse } from "../e2e/mock-llm.ts";

// Only the OS boundaries are faked: no sockets, package installs, or real children.
class FakeChild extends EventEmitter {
  pid = 100;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes: Record<string, unknown>[] = [];
  onWrite?: (record: Record<string, unknown>) => void;
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      const record = JSON.parse(chunk.toString());
      this.writes.push(record);
      this.onWrite?.(record);
      callback();
    },
  });
  record(record: Record<string, unknown>) { this.stdout.write(JSON.stringify(record) + "\n"); }
  finish(code = 0) {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}
const childType = (child: FakeChild) => child as unknown as import("node:child_process").ChildProcessWithoutNullStreams;
const procRecord = (pid: number, overrides = {}) => ({
  pid, uid: 42, startTime: "12345", state: "S", environ: "PATH=/bin\0HEADROOM_E2E_RUN_ID=owned\0", ...overrides,
});
function fakeProc(initial = [procRecord(100)]) {
  const records = new Map(initial.map(record => [record.pid, record]));
  const signals: Array<[number, string]> = [];
  return {
    records, signals,
    async listPids() { return [...records.keys()]; },
    async read(pid: number) { return records.get(pid) ?? null; },
    signal(pid: number, signal: string) { signals.push([pid, signal]); if (signal === "SIGKILL") records.delete(pid); },
  };
}
function resources(child = new FakeChild()) {
  const proc = fakeProc();
  const spawns: Array<{ command: string; args: string[]; options: any }> = [];
  const owner = new OwnedResources({
    runId: "owned", uid: 42, proc, pause: async () => {},
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      return childType(child);
    },
    signals: false,
  });
  return { owner, child, proc, spawns };
}
const runOptions = { cwd: "/disposable", env: { PATH: "/bin" }, timeoutMs: 30_000 };

async function advanceCleanup(t: import("node:test").TestContext, pending: Promise<void>) {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < 5_000 && !settled; elapsed += 10) {
    for (let i = 0; i < 40; i++) await Promise.resolve();
    t.mock.timers.tick(10);
  }
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(settled, true, "cleanup must settle within its five-second bound");
  await pending;
}

test("exact Pi and canonical Headroom pins are retained verbatim", () => {
  for (const pi of ["1.5.0", "1.5.0-beta.1", "1.5.0+build.01", "0.0.0-alpha-1"]) {
    for (const headroom of ["0.42.0", "0.43.0rc1", "1.0.0a0", "1.0.0b2"]) {
      assert.deepEqual(validateVersions(pi, headroom), { piVersion: pi, headroomVersion: headroom });
    }
  }
});

test("invalid pins cannot reach package-manager execution through the harness gate", () => {
  let spawned = 0;
  const options = { spawn: () => { spawned++; throw new Error("must not execute"); }, signals: false };
  const invalid = [undefined, "", "latest", "^1.5.0", ">=0.42", "*", " 1.5.0", "1.5.0\n", "--help", "1.5.0; touch bad", "https://invalid/pkg", "pkg@1.5.0"];
  for (const pin of invalid) {
    assert.throws(() => createHarness(pin, "0.42.0", options), /versions: invalid Pi version/);
    assert.throws(() => createHarness("1.5.0", pin, options), /versions: invalid Headroom version/);
  }
  for (const pin of ["v1.5.0", "01.5.0", "1.5.0-beta.01", "1.5.0-", "1.5.0+", "9007199254740992.0.0"]) {
    assert.throws(() => createHarness(pin, "0.42.0", options));
  }
  for (const pin of ["0.43.0-rc.1", "00.42.0", "0.43.0rc01", "0.43.0.dev1", "0.43.0.post1", "0.43.0+local", "1!0.43.0", "0.43.0RC1"]) {
    assert.throws(() => createHarness("1.5.0", pin, options));
  }
  assert.equal(spawned, 0);
});

test("child environment allowlists platform/network/cache settings and explicit isolated homes only", () => {
  const env = buildChildEnv({
    PATH: "/bin", HOME: "/real-home", LANG: "C.UTF-8", HTTPS_PROXY: "http://proxy", NO_PROXY: "localhost",
    XDG_CACHE_HOME: "/cache", npm_config_cache: "/npm-cache", SSL_CERT_FILE: "/cert",
    OPENAI_API_KEY: "private", NPM_TOKEN: "private", NODE_OPTIONS: "--require bad",
    PI_CODING_AGENT_DIR: "/real-pi", HEADROOM_URL: "http://foreign", HEADROOM_DISABLED: "1",
    HEADROOM_VERSION: "9.9.9", HEADROOM_TELEMETRY: "on", PIP_INDEX_URL: "https://private-index",
  }, { HOME: "/isolated", PI_CODING_AGENT_DIR: "/isolated/pi", HEADROOM_HOME: "/isolated/hr", HEADROOM_VERSION: "0.42.0" }, "owned");
  assert.deepEqual(env, {
    PATH: "/bin", LANG: "C.UTF-8", HTTPS_PROXY: "http://proxy", NO_PROXY: "localhost",
    XDG_CACHE_HOME: "/cache", npm_config_cache: "/npm-cache", SSL_CERT_FILE: "/cert",
    HOME: "/isolated", PI_CODING_AGENT_DIR: "/isolated/pi", HEADROOM_HOME: "/isolated/hr", HEADROOM_VERSION: "0.42.0",
    HEADROOM_E2E_RUN_ID: "owned", HEADROOM_TELEMETRY: "off", HEADROOM_BEACON: "off", DO_NOT_TRACK: "1",
    PYTHONUNBUFFERED: "1", npm_config_update_notifier: "false", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
  });
});

test("each run generates a fresh marker, tags every child, and uses argument arrays without a shell", async () => {
  const first = resources();
  const second = new OwnedResources({ signals: false });
  const third = new OwnedResources({ signals: false });
  assert.notEqual(second.runId, third.runId);
  first.owner.spawnOwned("npm", ["install", "literal;not-shell"], runOptions);
  assert.equal(first.spawns[0].options.env.HEADROOM_E2E_RUN_ID, "owned");
  assert.equal(first.spawns[0].options.shell, false);
  assert.equal(first.spawns[0].options.cwd, "/disposable");
  assert.deepEqual(first.spawns[0].args, ["install", "literal;not-shell"]);
  await first.owner.cleanup();
});

test("owned command captures bounded output in memory without leaking it in errors", async () => {
  const { owner, child } = resources();
  const pending = owner.runOwned("inspection", [], runOptions);
  child.stdout.write("x".repeat(2_000_000));
  child.stderr.write("diagnostic");
  child.finish();
  const result = await pending;
  assert.ok(result.stdout.length > 0 && result.stdout.length <= 1_048_576);
  assert.equal(result.stderr, "diagnostic");
  await owner.cleanup();
});

for (const failure of ["exit", "spawn", "timeout"] as const) {
  test(`owned command rejects ${failure} with stage-safe errors and cleans registered children`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { owner, child, proc } = resources();
    const pending = owner.runOwned("sensitive-command", ["private-argument"], { ...runOptions, timeoutMs: 10 });
    const rejected = assert.rejects(pending, error => {
      assert.match(String(error), /process: (exit|spawn|timeout)/);
      assert.doesNotMatch(String(error), /sensitive|private|secret/);
      return true;
    });
    child.stderr.write("secret-body");
    if (failure === "exit") child.finish(7);
    if (failure === "spawn") child.emit("error", new Error("secret-spawn-path"));
    if (failure === "timeout") t.mock.timers.tick(10);
    await rejected;
    assert.ok(proc.signals.some(([pid, signal]) => pid === 100 && signal === "SIGKILL"));
  });
}

for (const [command, args, cap] of [["inspection", [], 30_000], ["/bin/npm", ["install", "exact-package"], 300_000]] as const) {
  test(`owned ${command} execution enforces its stage cap without an early timeout`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { owner, child } = resources();
    const rejected = assert.rejects(owner.runOwned(command, [...args], { ...runOptions, timeoutMs: 500_000 }), /process: timeout/);
    t.mock.timers.tick(cap - 1);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(child.stdin.writableEnded, false);
    t.mock.timers.tick(1);
    await rejected;
    await owner.cleanup();
  });
}

test("operation caps and the shared deadline prevent late spawns", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const proc = fakeProc();
  const children: FakeChild[] = [];
  const owner = new OwnedResources({
    runId: "owned", uid: 42, proc, signals: false, now: () => now, deadline: 1_000_000, pause: async () => {},
    spawn: () => { const child = new FakeChild(); children.push(child); return childType(child); },
  });
  assert.equal(owner.timeout("inspect"), 30_000);
  assert.equal(owner.timeout("rpc"), 30_000);
  assert.equal(owner.timeout("prompt"), 120_000);
  assert.equal(owner.timeout("provision"), 300_000);
  now = 994_000; // five seconds are reserved for cleanup
  assert.ok(owner.timeout("provision") <= 1_000);
  now = 999_000;
  assert.throws(() => owner.spawnOwned("npm", [], runOptions), /deadline/);
  assert.equal(children.length, 0);
  await owner.cleanup();
});

function rpc() { const child = new FakeChild(); return { child, session: new RpcSession(childType(child)) }; }

test("RPC frames partial/batched LF records and preserves split UTF-8 and Unicode separators", async () => {
  const { child, session } = rpc();
  const text = Buffer.from('{"type":"notice","text":"snow ☃\u2028paragraph\u2029end"}\r\n{"type":"agent_settled"}\n');
  const split = text.indexOf(Buffer.from("☃")) + 1;
  child.stdout.write(text.subarray(0, split));
  child.stdout.write(text.subarray(split, text.length - 2));
  child.stdout.write(text.subarray(text.length - 2));
  const notice = await session.waitFor(record => record.type === "notice", 100);
  assert.equal(notice.text, "snow ☃\u2028paragraph\u2029end");
  assert.equal((await session.waitFor(record => record.type === "agent_settled", 100)).type, "agent_settled");
  await session.close();
});

test("RPC subscribes before writes and correlates interleaved command IDs, not response order", async () => {
  const { child, session } = rpc();
  const first = session.command({ type: "get_state" }, 100);
  const second = session.command({ type: "get_messages" }, 100);
  const [a, b] = child.writes;
  assert.notEqual(a.id, b.id);
  child.record({ id: b.id, type: "response", success: true, data: "second" });
  child.record({ id: a.id, type: "response", success: true, data: "first" });
  assert.equal((await first).data, "first");
  assert.equal((await second).data, "second");
  child.onWrite = record => child.record({ type: "response", id: record.id, success: true });
  assert.equal((await session.command({ type: "get_state" }, 100)).success, true);
  await session.close();
});

test("prompt acceptance is not completion; fast completion and notifications remain available", async () => {
  const { child, session } = rpc();
  child.onWrite = record => {
    child.record({ type: "response", id: record.id, success: true, data: { disposition: "started" } });
    child.record({ type: "extension_ui_request", method: "notify", message: "fixture" });
    child.record({ type: "agent_settled" });
  };
  const completion = session.waitFor(record => record.type === "agent_settled", 100);
  const accepted = await session.command({ type: "prompt", message: "fixture" }, 100);
  assert.deepEqual(accepted.data, { disposition: "started" });
  await completion;
  assert.equal((await session.waitFor(record => record.method === "notify", 100)).message, "fixture");
  await session.close();
});

for (const failure of ["timeout", "eof", "exit", "error", "invalid", "oversized", "write"] as const) {
  test(`RPC rejects pending operations on ${failure} without logging raw records`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { child, session } = rpc();
    if (failure === "write") child.stdin.destroy();
    const pending = session.command({ type: "get_state" }, 10);
    const rejected = assert.rejects(pending, error => {
      assert.match(String(error), /rpc:/);
      assert.doesNotMatch(String(error), /secret/);
      return true;
    });
    if (failure === "timeout") t.mock.timers.tick(10);
    if (failure === "eof") child.stdout.end();
    if (failure === "exit") child.emit("exit", 9, null);
    if (failure === "error") child.emit("error", new Error("secret-error"));
    if (failure === "invalid") child.stdout.write("secret-invalid-json\n");
    if (failure === "oversized") child.stdout.write("s".repeat(5_000_000));
    await rejected;
    await session.close();
    assert.ok(child.stdin.writableEnded || child.stdin.destroyed);
  });
}

test("RPC fails unsuccessful commands safely and bounds retained event history", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, session } = rpc();
  child.onWrite = record => child.record({ type: "response", id: record.id, success: false, error: "secret" });
  await assert.rejects(session.command({ type: "bad" }, 100), /^Error: rpc: command failed$/);
  child.record({ type: "evicted" });
  for (let i = 0; i < 300; i++) child.record({ type: "recent", index: i });
  const missing = assert.rejects(session.waitFor(record => record.type === "evicted", 10), /timeout/);
  t.mock.timers.tick(10);
  await missing;
  assert.equal((await session.waitFor(record => record.index === 299, 100)).index, 299);
  await session.close();
});

test("RPC honors stdin backpressure before writing another outstanding command", async t => {
  const child = new FakeChild();
  const written: Record<string, unknown>[] = [];
  const callbacks: Array<() => void> = [];
  child.stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    written.push(JSON.parse(chunk.toString())); callbacks.push(callback);
  } });
  const session = new RpcSession(childType(child));
  t.after(async () => { child.stdin.destroy(); await session.close(); });
  const first = session.command({ type: "get_state" }, 100);
  const second = session.command({ type: "get_messages" }, 100);
  void first.catch(() => {}); void second.catch(() => {});
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const buffered = child.stdin.writableLength;
  // Only one serialized record may be buffered, even while the first response is outstanding.
  assert.equal(buffered, Buffer.byteLength(JSON.stringify(written[0]) + "\n"));
  callbacks.shift()!();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(written.length, 2);
  child.record({ type: "response", id: written[1].id, success: true });
  child.record({ type: "response", id: written[0].id, success: true });
  callbacks.shift()!();
  await Promise.all([first, second]);
  await session.close();
});

test("RPC never writes another command after terminal EOF", async () => {
  const { child, session } = rpc();
  child.stdout.end();
  await new Promise<void>(resolve => child.stdout.once("end", resolve));
  await assert.rejects(session.command({ type: "get_state" }, 100), /rpc: EOF/);
  assert.equal(child.writes.length, 0);
  await session.close();
});

test("RPC inspection and prompt operations enforce their distinct caps", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session } = rpc();
  let promptFinished = false;
  const inspection = assert.rejects(session.command({ type: "get_state" }, 500_000), /timeout/);
  const prompt = assert.rejects(session.command({ type: "prompt", message: "fixture" }, 500_000), /timeout/).then(() => { promptFinished = true; });
  t.mock.timers.tick(30_000);
  await inspection;
  assert.equal(promptFinished, false);
  t.mock.timers.tick(90_000);
  await prompt;
  await session.close();
});

test("proc stat parser handles spaces/parentheses and keeps exact start-time identity", () => {
  // Fields 3..21 precede starttime (22); comm may itself contain ')'.
  const stat = `101 (pip (detached) worker) S ${Array(18).fill("0").join(" ")} 987654321 0 0`;
  assert.deepEqual(parseProcStat(stat), { pid: 101, state: "S", startTime: "987654321" });
  assert.equal(parseProcStat("malformed"), null);
});

test("ownership selection finds same-user detached descendants without runtime.json", () => {
  const selected = selectOwnedProcesses([
    procRecord(100), procRecord(200),
    procRecord(201, { uid: 99 }),
    procRecord(202, { environ: "HEADROOM_E2E_RUN_ID=owned-other\0" }),
    procRecord(203, { environ: "OTHER_HEADROOM_E2E_RUN_ID=owned\0" }),
    procRecord(204, { environ: "PATH=/bin\0" }),
    procRecord(205, { state: "Z" }), procRecord(-3),
  ], "owned", 42);
  assert.deepEqual(selected.map(record => record.pid), [100, 200]);
});

test("cleanup closes RPC first, rescans detached children, escalates individually, then removes resources", async () => {
  const { owner, child, proc } = resources();
  owner.spawnOwned("pi", [], runOptions);
  const session = new RpcSession(childType(child));
  const order: string[] = [];
  owner.registerResource(async () => { order.push("server"); }, async () => { order.push("temp"); });
  child.stdin.on("finish", () => {
    order.push("stdin");
    proc.records.delete(100);
    proc.records.set(200, procRecord(200)); // reparented pip/proxy, no runtime state
  });
  const signal = proc.signal;
  proc.signal = (pid, sig) => { order.push(`${pid}:${sig}`); signal(pid, sig); };
  await owner.cleanup();
  await owner.cleanup();
  assert.deepEqual(order, ["stdin", "server", "200:SIGTERM", "200:SIGKILL", "temp"]);
  await session.close();
  assert.throws(() => owner.spawnOwned("npm", [], runOptions), /closed/);
});

test("cleanup revalidates marker, uid, and PID start-time before every individual signal", async () => {
  const proc = fakeProc([procRecord(100), procRecord(101), procRecord(102)]);
  let reads = 0;
  const original = proc.read;
  proc.read = async pid => {
    reads++;
    const record = await original(pid);
    if (reads > 3 && record) {
      if (pid === 100) return { ...record, startTime: "reused" };
      if (pid === 101) return { ...record, uid: 99 };
      return { ...record, environ: "PATH=/bin\0" };
    }
    return record;
  };
  const owner = new OwnedResources({ runId: "owned", uid: 42, proc, pause: async () => {}, signals: false });
  await owner.cleanup();
  assert.deepEqual(proc.signals, []);
});

test("cleanup still kills marked processes and finalizes resources when orderly close fails", async () => {
  const { owner, proc } = resources();
  let removed = false;
  owner.registerResource(async () => { throw new Error("secret-server-error"); }, async () => { removed = true; });
  await assert.rejects(owner.cleanup(), /^Error: cleanup: resource failure$/);
  assert.equal(removed, true);
  assert.deepEqual(proc.signals, [[100, "SIGTERM"], [100, "SIGKILL"]]);
});

test("cleanup reports surviving marked processes instead of claiming success", async () => {
  const { owner, proc } = resources();
  proc.signal = (pid, sig) => { proc.signals.push([pid, sig]); };
  await assert.rejects(owner.cleanup(), /cleanup: owned processes remain/);
  assert.ok(proc.signals.every(([pid]) => pid > 0));
});

test("cleanup refuses a numerically reused marked PID during KILL escalation and reports it", async () => {
  const proc = fakeProc();
  proc.signal = (pid, signal) => {
    proc.signals.push([pid, signal]);
    proc.records.set(pid, procRecord(pid, { startTime: "67890" }));
  };
  const owner = new OwnedResources({ runId: "owned", uid: 42, proc, pause: async () => {}, signals: false });
  await assert.rejects(owner.cleanup(), /cleanup: owned processes remain/);
  assert.deepEqual(proc.signals, [[100, "SIGTERM"]]);
});

test("run deadline triggers automatic cleanup even while the caller is idle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const proc = fakeProc();
  const child = new FakeChild();
  const owner = new OwnedResources({
    runId: "owned", uid: 42, proc, pause: async () => {}, signals: false,
    now: () => 0, deadline: 10_000, spawn: () => childType(child),
  });
  owner.spawnOwned("pi", [], runOptions);
  t.mock.timers.tick(5_000);
  assert.equal(process.exitCode, 1);
  assert.throws(() => owner.spawnOwned("pi", [], runOptions), /closed/);
  await owner.cleanup(); // await the already-started cleanup, including stream finish/nextTick
  assert.ok(proc.signals.some(([pid, signal]) => pid === 100 && signal === "SIGKILL"));
});

test("cleanup revalidation requires the exact PID as well as its start-time and marker", async () => {
  const proc = fakeProc();
  let reads = 0;
  proc.read = async pid => procRecord(++reads % 2 === 1 ? pid : pid + 100);
  const owner = new OwnedResources({ runId: "owned", uid: 42, proc, pause: async () => {}, signals: false });
  await assert.rejects(owner.cleanup(), /cleanup: owned processes remain/);
  assert.deepEqual(proc.signals, []);
});

test("cleanup bounds a hung proc scan and still removes registered temporary resources", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const proc = fakeProc();
  proc.read = () => new Promise(() => {});
  const owner = new OwnedResources({ runId: "owned", uid: 42, proc, pause: async () => {}, signals: false });
  let removed = false;
  owner.registerResource(async () => {}, async () => { removed = true; });
  const pending = assert.rejects(owner.cleanup(), /cleanup: resource failure/);
  await advanceCleanup(t, pending);
  assert.equal(removed, true);
});

for (const stall of ["discovery", "revalidation"] as const) {
  test(`cleanup terminates a readable marked descendant despite stalled ${stall} of another record`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const proc = fakeProc([procRecord(100), procRecord(200)]);
    const read = proc.read;
    let stalledReads = 0;
    let readableReads = 0;
    const signalled: Array<[number, string, number]> = [];
    proc.read = pid => {
      if (pid === 100 && (++stalledReads > 1 || stall === "discovery")) return new Promise(() => {});
      if (pid === 200) readableReads++;
      return read(pid);
    };
    const signal = proc.signal;
    proc.signal = (pid, sig) => { signalled.push([pid, sig, readableReads]); signal(pid, sig); };
    const owner = new OwnedResources({ runId: "owned", uid: 42, proc, pause: async () => {}, signals: false });
    const pending = assert.rejects(owner.cleanup(), /^Error: cleanup: resource failure$/);
    await advanceCleanup(t, pending);
    // Two independent reads per signal: discovery followed by identity revalidation.
    assert.deepEqual(signalled, [[200, "SIGTERM", 2], [200, "SIGKILL", 4]]);
    assert.equal(proc.records.has(200), false);
    assert.ok(Date.now() <= 5_000);
  });
}

for (const stall of ["stdin", "rpc", "resource"] as const) {
  test(`cleanup reserves discovery and escalation time when orderly ${stall} close never settles`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const proc = fakeProc([procRecord(200)]);
    const child = new FakeChild();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final() {} });
    const owner = new OwnedResources({
      runId: "owned", uid: 42, proc, pause: async () => {}, signals: false,
      spawn: () => childType(child),
    });
    if (stall === "stdin") owner.spawnOwned("pi", [], runOptions);
    if (stall === "rpc") owner.registerRpc(() => new Promise(() => {}));
    let removed = false;
    owner.registerResource(stall === "resource" ? () => new Promise(() => {}) : async () => {}, async () => { removed = true; });
    const pending = assert.rejects(owner.cleanup(), /^Error: cleanup: resource failure$/);
    await advanceCleanup(t, pending);
    assert.deepEqual(proc.signals, [[200, "SIGTERM"], [200, "SIGKILL"]]);
    assert.equal(proc.records.has(200), false);
    assert.equal(removed, true);
    assert.ok(Date.now() <= 5_000);
  });
}

test("an unreadable proc record cannot prevent cleanup of other verified owned descendants", async () => {
  const proc = fakeProc([procRecord(100), procRecord(200)]);
  const read = proc.read;
  proc.read = pid => pid === 100 ? Promise.reject(new Error("private-process-detail")) : read(pid);
  const owner = new OwnedResources({ runId: "owned", uid: 42, proc, pause: async () => {}, signals: false });
  await assert.rejects(owner.cleanup(), /^Error: cleanup: resource failure$/);
  assert.deepEqual(proc.signals, [[200, "SIGTERM"], [200, "SIGKILL"]]);
});

test("signal handlers clean resources and unregister without real OS signals", async () => {
  const proc = fakeProc();
  const child = new FakeChild();
  const before = process.listeners("SIGTERM");
  const exitCode = process.exitCode;
  const owner = new OwnedResources({ runId: "owned", uid: 42, proc, pause: async () => {}, spawn: () => childType(child) });
  try {
    owner.spawnOwned("pi", [], runOptions);
    const handler = process.listeners("SIGTERM").find(listener => !before.includes(listener));
    assert.ok(handler);
    handler();
    await owner.cleanup();
    assert.equal(process.exitCode, 143);
    assert.deepEqual(process.listeners("SIGTERM"), before);
    assert.ok(proc.signals.some(([, signal]) => signal === "SIGKILL"));
  } finally { process.exitCode = exitCode; await owner.cleanup(); }
});

class MemoryResponse {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; return this; }
  end(body = "") { this.body += body; return this; }
}
async function request(mock: ReturnType<typeof createMockLlm>, payload: unknown, path = "/v1/chat/completions", method = "POST") {
  const input = new PassThrough() as PassThrough & { url: string; method: string; headers: Record<string, string> };
  input.url = path; input.method = method; input.headers = { "content-type": "application/json" };
  const response = new MemoryResponse();
  const pending = mock.handle(input, response);
  const text = JSON.stringify(payload);
  input.end(text);
  await pending;
  return response;
}
const llmRequest = { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "fixture" }] };

test("mock SSE encodes assistant role/text, finish, and DONE with JSON-safe Unicode/newlines", () => {
  const body = encodeAssistantSse("line\n\"quoted\"\u2028snow ☃", "gpt-4o");
  const events = body.trim().split("\n\n").map(line => line.slice(6));
  assert.equal(events.pop(), "[DONE]");
  const chunks = events.map(line => JSON.parse(line));
  assert.ok(chunks.every(chunk => chunk.object === "chat.completion.chunk" && chunk.model === "gpt-4o"));
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content ?? "").join(""), "line\n\"quoted\"\u2028snow ☃");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
});

test("mock handler captures requests only in memory and consumes scripted responses in order", async () => {
  const mock = createMockLlm();
  mock.enqueueAssistant("first"); mock.enqueueAssistant("second");
  const first = await request(mock, llmRequest);
  const second = await request(mock, llmRequest);
  assert.equal(first.status, 200);
  assert.equal(first.headers["content-type"], "text/event-stream");
  assert.match(first.body, /first/); assert.match(second.body, /second/);
  assert.deepEqual(mock.requests, [
    { model: "gpt-4o", messages: [{ role: "user", content: "fixture" }] },
    { model: "gpt-4o", messages: [{ role: "user", content: "fixture" }] },
  ]);
  assert.equal((await request(mock, llmRequest)).status, 400); // no unscripted successful fallback
});

test("mock rejects malformed JSON and oversized bodies without retaining raw payloads", async () => {
  const mock = createMockLlm(); mock.enqueueAssistant("ok");
  for (const body of ["private-not-json", JSON.stringify({ private: "x".repeat(4_194_305) })]) {
    const input = new PassThrough() as PassThrough & { url: string; method: string; headers: Record<string, string> };
    input.url = "/v1/chat/completions"; input.method = "POST"; input.headers = { "content-type": "application/json" };
    const response = new MemoryResponse();
    const pending = mock.handle(input, response);
    input.end(body);
    await pending;
    assert.equal(response.status, 400);
    assert.doesNotMatch(response.body, /private/);
  }
  assert.equal(mock.requests.length, 0);
  assert.equal((await request(mock, llmRequest)).status, 200);
});

test("mock fails unexpected routes/methods/shapes without consuming the next reply", async () => {
  const mock = createMockLlm(); mock.enqueueAssistant("ok");
  for (const [body, path, method] of [
    [llmRequest, "/v1/models", "GET"], [llmRequest, "/v1/chat/completions?x=1", "POST"],
    [llmRequest, "/v1/chat/completions", "GET"],
    [{ ...llmRequest, stream: false }, undefined, undefined],
    [{ ...llmRequest, model: "other" }, undefined, undefined],
    [{ ...llmRequest, messages: [] }, undefined, undefined],
    [{ ...llmRequest, messages: [{ role: "user" }] }, undefined, undefined],
    [{ ...llmRequest, messages: [{ role: "unknown", content: "secret" }] }, undefined, undefined],
    [null, undefined, undefined],
  ] as const) {
    const response = await request(mock, body, path, method);
    assert.equal(response.status, 400);
    assert.doesNotMatch(response.body, /secret/);
  }
  assert.equal(mock.requests.length, 0);
  assert.equal((await request(mock, llmRequest)).status, 200);
});
