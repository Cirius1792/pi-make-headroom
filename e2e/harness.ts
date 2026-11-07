// Linux-only live-smoke infrastructure. Importing this module does not start a run.
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export function validateVersions(pi: string | undefined, headroom: string | undefined): { piVersion: string; headroomVersion: string } {
  const number = "(?:0|[1-9][0-9]*)";
  const core = `${number}\\.${number}\\.${number}`;
  const identifier = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const npm = new RegExp(`^${core}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  const python = new RegExp(`^${core}(?:(?:a|b|rc)${number})?$`);
  // JS '$' also matches before a final LF; compare the entire matched string.
  if (!pi || npm.exec(pi)?.[0] !== pi || pi.length > 256 ||
      pi.split(/[.+-]/).slice(0, 3).some(n => !Number.isSafeInteger(Number(n)))) {
    throw new Error("versions: invalid Pi version");
  }
  if (!headroom || python.exec(headroom)?.[0] !== headroom) throw new Error("versions: invalid Headroom version");
  return { piVersion: pi, headroomVersion: headroom };
}

export interface IsolatedEnvironment {
  HOME?: string;
  PI_CODING_AGENT_DIR?: string;
  HEADROOM_HOME?: string;
  HEADROOM_VERSION?: string;
  HEADROOM_PYTHON?: string;
}

// Never inherit API keys, NODE_OPTIONS, npm/pip auth/config, or arbitrary Pi/Headroom overrides.
// Network/cache variables are explicit so provisioning still works on managed Linux runners.
const ENV_ALLOWLIST = [
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TMP", "TEMP",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
  "XDG_CACHE_HOME", "npm_config_cache", "NPM_CONFIG_CACHE", "PIP_CACHE_DIR", "HF_HOME", "HF_HUB_CACHE",
];
export function buildChildEnv(source: NodeJS.ProcessEnv, isolated: IsolatedEnvironment = {}, runId = randomUUID()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  for (const key of ["HOME", "PI_CODING_AGENT_DIR", "HEADROOM_HOME", "HEADROOM_VERSION", "HEADROOM_PYTHON"] as const) {
    if (isolated[key] !== undefined) env[key] = isolated[key];
  }
  return {
    ...env, HEADROOM_E2E_RUN_ID: runId, HEADROOM_TELEMETRY: "off", HEADROOM_BEACON: "off",
    DO_NOT_TRACK: "1", PYTHONUNBUFFERED: "1", npm_config_update_notifier: "false", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
  };
}

export interface ProcRecord {
  pid: number;
  uid: number;
  startTime: string;
  state: string;
  environ: string;
}
export interface ProcAccess {
  listPids(): Promise<number[]>;
  read(pid: number): Promise<ProcRecord | null>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}
export function parseProcStat(text: string): { pid: number; state: string; startTime: string } | null {
  const match = /^(\d+) \(.*\) ([^\n]*)$/.exec(text.trim());
  if (!match) return null;
  const fields = match[2].split(" "); // state is field 3, starttime is field 22
  if (!/^[0-9]+$/.test(fields[19] ?? "")) return null;
  return { pid: Number(match[1]), state: fields[0], startTime: fields[19] };
}
function gone(error: unknown): boolean {
  return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
const linuxProc: ProcAccess = {
  async listPids() {
    if (process.platform !== "linux") throw new Error("cleanup: Linux /proc required");
    return (await readdir("/proc")).filter(name => /^[1-9][0-9]*$/.test(name)).map(Number);
  },
  async read(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return null;
    try {
      const directory = `/proc/${pid}`;
      const metadata = await stat(directory);
      if (metadata.uid !== process.getuid?.()) return null;
      // A user-namespace /proc can expose foreign processes whose directory
      // appears owned by us while environ is not. Such a process cannot carry
      // our readable marker; treat it as not owned rather than a scan failure.
      const environMetadata = await stat(`${directory}/environ`);
      if (environMetadata.uid !== process.getuid?.()) return null;
      const before = parseProcStat(await readFile(`${directory}/stat`, "utf8"));
      if (!before || before.pid !== pid || before.state === "Z" || before.state === "X") return null;
      const environ = await readFile(`${directory}/environ`, "utf8");
      const after = parseProcStat(await readFile(`${directory}/stat`, "utf8"));
      const recheck = await stat(directory);
      if (!after || before.startTime !== after.startTime || metadata.uid !== recheck.uid) return null;
      return { ...after, uid: recheck.uid, environ };
    } catch (error) {
      if (gone(error)) return null;
      throw new Error("cleanup: process inspection failed");
    }
  },
  signal(pid, signal) { process.kill(pid, signal); },
};
export function selectOwnedProcesses(records: ProcRecord[], runId: string, uid: number): ProcRecord[] {
  if (!runId || runId.includes("\0")) return [];
  return records.filter(record => Number.isSafeInteger(record.pid) && record.pid > 0 && record.pid !== process.pid &&
    record.uid === uid && /^[0-9]+$/.test(record.startTime) && !["Z", "X"].includes(record.state) &&
    record.environ.split("\0").includes(`HEADROOM_E2E_RUN_ID=${runId}`));
}

type Spawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
interface OwnerOptions {
  isolated?: IsolatedEnvironment;
  deadline?: number;
  // Boundary injection keeps the offline suite entirely in memory.
  spawn?: Spawn;
  proc?: ProcAccess;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  uid?: number;
  runId?: string;
  signals?: boolean;
}
interface RunOptions { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
const childOwners = new WeakMap<ChildProcessWithoutNullStreams, OwnedResources>();
const CAPS = { inspect: 30_000, rpc: 30_000, prompt: 120_000, provision: 300_000 };
const MAX_CAPTURE = 1_048_576;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function endStdin(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  const input = child.stdin;
  if (input.destroyed || input.writableFinished) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      input.off("finish", onFinish); input.off("error", onError); input.off("close", onFinish);
      if (error) reject(error); else resolve();
    };
    const onFinish = () => finish();
    const onError = () => finish(new Error("rpc: shutdown failed"));
    const timer = setTimeout(() => finish(new Error("rpc: shutdown timeout")), Math.max(1, timeoutMs));
    input.once("finish", onFinish); input.once("error", onError); input.once("close", onFinish);
    if (!input.writableEnded) input.end();
  });
}

/** A single run owns one marker, deadline, all children and cleanup hooks. No runtime.json dependency. */
export class OwnedResources {
  readonly runId: string;
  readonly deadline: number;
  private readonly options: OwnerOptions;
  private readonly proc: ProcAccess;
  private readonly now: () => number;
  private readonly uid: number;
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly rpcClosers = new Set<() => Promise<void>>();
  private readonly resources: Array<{ close: () => Promise<void>; remove?: () => Promise<void> }> = [];
  private cleanupPromise?: Promise<void>;
  private closed = false;
  private installedSignals = false;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private readonly onInterrupt = () => { process.exitCode = 130; void this.cleanup().catch(() => { process.exitCode = 1; }); };
  private readonly onTerminate = () => { process.exitCode = 143; void this.cleanup().catch(() => { process.exitCode = 1; }); };

  constructor(options: OwnerOptions = {}) {
    this.options = options;
    this.runId = options.runId ?? randomUUID();
    if (!this.runId || this.runId.includes("\0")) throw new Error("ownership: invalid marker");
    this.now = options.now ?? Date.now;
    this.deadline = options.deadline ?? this.now() + 30 * 60_000;
    this.uid = options.uid ?? process.getuid?.() ?? -1;
    this.proc = options.proc ?? linuxProc;
  }

  timeout(stage: keyof typeof CAPS): number {
    // Reserve fifteen seconds INSIDE the thirty-minute absolute deadline.
    const remaining = this.deadline - this.now() - 15_000;
    if (remaining <= 0) throw new Error("deadline: run expired");
    return Math.min(CAPS[stage], remaining);
  }

  private activate(): void {
    if (this.closed) throw new Error("ownership: run closed");
    this.deadlineTimer ??= setTimeout(() => {
      process.exitCode = 1;
      void this.cleanup().catch(() => {});
    }, Math.max(1, this.deadline - this.now() - 15_000));
    if (this.options.signals !== false && !this.installedSignals) {
      process.on("SIGINT", this.onInterrupt);
      process.on("SIGTERM", this.onTerminate);
      this.installedSignals = true;
    }
  }

  spawnOwned(command: string, args: string[], options: RunOptions): ChildProcessWithoutNullStreams {
    this.timeout("inspect");
    this.activate();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.options.spawn ?? spawn)(command, args, {
        cwd: options.cwd, env: buildChildEnv(options.env, this.options.isolated, this.runId),
        shell: false, stdio: "pipe",
      }) as ChildProcessWithoutNullStreams;
    } catch { throw new Error("process: spawn failed"); }
    // Registration is immediate, before returning the handle to RPC/inspection callers.
    this.children.add(child);
    childOwners.set(child, this);
    child.on("error", () => {}); // callers attach their own stage-safe error handling
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {}); // continuously drain, never log
    return child;
  }

  async runOwned(command: string, args: string[], options: RunOptions): Promise<{ stdout: string; stderr: string }> {
    const cap = /^(npm|npm\.cmd)$/.test(command.split("/").at(-1) ?? "") && args.includes("install") ? "provision" : "inspect";
    const timeoutMs = Math.min(options.timeoutMs, this.timeout(cap));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("process: invalid timeout");
    try {
      const child = this.spawnOwned(command, args, options);
      return await new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const out = new StringDecoder("utf8");
        const err = new StringDecoder("utf8");
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve({ stdout, stderr });
        };
        const timer = setTimeout(() => finish(new Error("process: timeout")), timeoutMs);
        child.stdout.on("data", chunk => { stdout = (stdout + out.write(Buffer.from(chunk))).slice(-MAX_CAPTURE); });
        child.stderr.on("data", chunk => { stderr = (stderr + err.write(Buffer.from(chunk))).slice(-MAX_CAPTURE); });
        child.stdout.on("error", () => finish(new Error("process: output failed")));
        child.stderr.on("error", () => finish(new Error("process: output failed")));
        child.on("error", () => finish(new Error("process: spawn failed")));
        child.on("close", (code, signal) => {
          stdout = (stdout + out.end()).slice(-MAX_CAPTURE);
          stderr = (stderr + err.end()).slice(-MAX_CAPTURE);
          finish(code === 0 && !signal ? undefined : new Error("process: exit failed"));
        });
      });
    } catch (error) {
      await this.cleanup().catch(() => {}); // the original stage remains authoritative; cleanup() retains its failure
      throw error;
    }
  }

  registerRpc(close: () => Promise<void>): void { this.activate(); this.rpcClosers.add(close); }
  registerResource(close: () => Promise<void>, remove?: () => Promise<void>): void {
    this.activate(); this.resources.push({ close, remove });
  }

  cleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.closed = true;
      clearTimeout(this.deadlineTimer);
      this.cleanupPromise = this.performCleanup();
    }
    return this.cleanupPromise;
  }

  private async performCleanup(): Promise<void> {
    const startedAt = this.now();
    const stopAt = Math.min(this.deadline, startedAt + 15_000);
    const reserve = Math.max(0, stopAt - startedAt) / 10;
    const orderlyUntil = startedAt + reserve;
    // Separate budgets for orderly close, three escalation passes, final discovery,
    // and removal. Neither a hook nor one stalled /proc record can spend them all.
    const passMs = Math.max(0, stopAt - reserve - orderlyUntil) / 4;
    let failed = false;
    const reasons = new Set<string>();
    const fail = (reason: string) => { failed = true; reasons.add(reason); };
    let survivors = false;
    const within = async <T>(action: () => Promise<T>, until = stopAt): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(action),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cleanup timeout")), Math.max(1, until - this.now())); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    const bounded = async (action: () => Promise<void>, until = stopAt) => {
      try { await within(action, until); } catch { fail("bounded"); }
    };
    const inspect = (pid: number, until: number) => within(() => this.proc.read(pid), Math.min(until, this.now() + 100));
    // Bound /proc traffic so a large host cannot starve per-record deadlines.
    const eachLimited = async <T>(items: T[], limit: number, action: (item: T) => Promise<void>) => {
      for (let offset = 0; offset < items.length; offset += limit) {
        await Promise.all(items.slice(offset, offset + limit).map(action));
      }
    };
    const scan = async (until: number) => {
      const records: ProcRecord[] = [];
      try {
        const pids = await within(() => this.proc.listPids(), until);
        await eachLimited(pids, 8, async pid => {
          try {
            const record = await inspect(pid, until);
            if (record && record.pid === pid) records.push(record);
            else if (record) fail("record");
          } catch { fail("inspect"); } // timeouts also leave other verified records usable
        });
      } catch { fail("list"); }
      return selectOwnedProcesses(records, this.runId, this.uid);
    };
    const pause = async (ms: number, until: number) => {
      if (this.now() < until) await bounded(() => (this.options.pause ?? sleep)(Math.min(ms, until - this.now())), until);
    };
    try {
      // Closing stdin requests Pi's orderly runtime disposal before any signalling.
      await Promise.all([...this.children].map(child => bounded(() => endStdin(child, orderlyUntil - this.now()), orderlyUntil)));
      await Promise.all([
        ...[...this.rpcClosers].map(close => bounded(close, orderlyUntil)),
        ...this.resources.map(resource => bounded(resource.close, orderlyUntil)),
      ]);
      await pause(100, orderlyUntil);
      // New detached/reparented children can appear between passes. Preserve first-seen
      // PID/start-time identities so a reused PID is never adopted during escalation.
      const identities = new Map<number, string>();
      let pass = 0;
      for (const signal of ["SIGTERM", "SIGKILL", "SIGKILL"] as const) {
        const until = orderlyUntil + ++pass * passMs;
        await eachLimited(await scan(until), 8, async record => {
          if (!identities.has(record.pid)) identities.set(record.pid, record.startTime);
          if (identities.get(record.pid) !== record.startTime) return;
          let current: ProcRecord | null;
          try { current = await inspect(record.pid, until); }
          catch { fail("revalidate"); return; }
          if (this.now() >= until) { fail("expired"); return; }
          if (!current || current.pid !== record.pid || current.startTime !== record.startTime ||
              selectOwnedProcesses([current], this.runId, this.uid).length !== 1) return;
          try { this.proc.signal(record.pid, signal); }
          catch (error) { if (!gone(error)) fail("signal"); }
        });
        await pause(200, until);
      }
      survivors = (await scan(stopAt - reserve)).length > 0;
    } catch { fail("unexpected"); }
    finally {
      for (const resource of [...this.resources].reverse()) if (resource.remove) await bounded(resource.remove);
      for (const child of this.children) {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      }
      this.children.clear();
      this.rpcClosers.clear();
      this.resources.length = 0;
      if (this.installedSignals) {
        process.off("SIGINT", this.onInterrupt); process.off("SIGTERM", this.onTerminate);
      }
    }
    if (survivors) throw new Error("cleanup: owned processes remain");
    if (failed) throw new Error(`cleanup: resource failure (${[...reasons].sort().join(",")})`);
  }
}

/** Live runners must enter through this gate BEFORE invoking any package manager. */
export function createHarness(pi: string | undefined, headroom: string | undefined, options: OwnerOptions = {}) {
  const versions = validateVersions(pi, headroom);
  const owner = new OwnedResources({ ...options, isolated: { ...options.isolated, HEADROOM_VERSION: versions.headroomVersion } });
  return { ...versions, owner };
}

// Convenience interface for inspection callers; full runners should use their gated owner.
let defaultOwner: OwnedResources | undefined;
export function runOwned(command: string, args: string[], options: RunOptions): Promise<{ stdout: string; stderr: string }> {
  return (defaultOwner ??= new OwnedResources()).runOwned(command, args, options);
}
export async function cleanupOwned(): Promise<void> { await defaultOwner?.cleanup(); }

type HistoryMessage = { role: string; content: unknown };

/** Text-only smoke fixtures: unsupported content is an assertion failure, never a lossy coercion. */
export function fixtureText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length > 0 && content.every(part =>
    part && part.type === "text" && typeof part.text === "string")) return content.map(part => part.text).join("");
  throw new Error("assertion: expected text-only fixture");
}

export function assertCompressedHistory(original: HistoryMessage[], upstream: HistoryMessage[], targetPrompt: string): { beforeChars: number; afterChars: number } {
  const conversation = (messages: HistoryMessage[]) => messages.filter(m => !["system", "developer"].includes(m.role));
  const before = conversation(original);
  const after = conversation(upstream);
  if (!targetPrompt || before.length === 0 || before.length % 2 !== 0 || after.length !== before.length + 1 ||
      after.at(-1)?.role !== "user" || fixtureText(after.at(-1)?.content) !== targetPrompt) {
    throw new Error("assertion: target or conversation layout mismatch");
  }
  let beforeChars = 0;
  let afterChars = 0;
  const anchors = new Set<string>([targetPrompt]);
  for (let i = 0; i < before.length; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    if (before[i].role !== role || after[i].role !== role) throw new Error("assertion: conversation roles mismatch");
    const a = fixtureText(before[i].content);
    const b = fixtureText(after[i].content);
    if (!a || !b) throw new Error("assertion: missing fixture text");
    if (role === "user") {
      if (anchors.has(a) || a !== b) throw new Error("assertion: user anchors missing or reordered");
      anchors.add(a);
    } else {
      beforeChars += a.length;
      afterChars += b.length;
    }
  }
  if (afterChars >= beforeChars) throw new Error("assertion: historical assistant text was not reduced");
  return { beforeChars, afterChars };
}

export function assertTargetCompression(original: HistoryMessage[], upstream: HistoryMessage[], targetPrompt: string, savedTokensBefore: number, savedTokensAfter: number) {
  const lengths = assertCompressedHistory(original, upstream, targetPrompt);
  if (![savedTokensBefore, savedTokensAfter].every(n => Number.isSafeInteger(n) && n >= 0) || savedTokensAfter <= savedTokensBefore) {
    throw new Error("assertion: no positive target-turn token savings");
  }
  return { ...lengths, savedTokensBefore, savedTokensAfter, targetSavedTokens: savedTokensAfter - savedTokensBefore };
}

export function assertCompletedTurn(message: Record<string, unknown>, state: Record<string, unknown>, expected: string): void {
  if (message.role !== "assistant" || message.stopReason !== "stop" || fixtureText(message.content) !== expected ||
      state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0) {
    throw new Error("assertion: expected completed assistant turn and idle state");
  }
}

export type FailureCategory = "input" | "provisioning" | "environment" | "protocol" | "assertion" | "timeout" | "cleanup";
export class SmokeFailure extends Error {
  readonly stage: string;
  readonly category: FailureCategory;
  // Only harness-owned literals may be supplied here, never exception/command/request text.
  constructor(stage: string, category: FailureCategory, message: string) {
    super(message); this.stage = stage; this.category = category;
  }
}
type CheckName = "installation" | "healthStatus" | "compression";
type Check = { status: "passed" | "failed" | "not_run" };
export interface SmokeResult {
  schemaVersion: 1;
  extensionCommit: string;
  requested: { piVersion: string; headroomVersion: string };
  actual: { piVersion?: string; headroomVersion?: string; nodeVersion: string; pythonVersion?: string };
  checks: Record<CheckName, Check>;
  outcome: "passed" | "failed";
  failure?: { stage: string; category: FailureCategory; message: string };
  compression?: ReturnType<typeof assertTargetCompression>;
  cleanup: Check;
}
export function createSmokeResult(extensionCommit: string, requested: SmokeResult["requested"]): SmokeResult {
  return {
    schemaVersion: 1, extensionCommit, requested, actual: { nodeVersion: process.version },
    checks: { installation: { status: "not_run" }, healthStatus: { status: "not_run" }, compression: { status: "not_run" } },
    outcome: "failed", cleanup: { status: "not_run" },
  };
}
export function recordSmokeFailure(result: SmokeResult, error: unknown, stage: string): void {
  result.outcome = "failed";
  result.failure = error instanceof SmokeFailure
    ? { stage: error.stage, category: error.category, message: error.message }
    : { stage, category: "protocol", message: "Smoke operation failed; raw diagnostics withheld" };
}

/** The same prerequisite/cleanup gate is exercised offline and used by the live runner. */
export async function runSmokeChecks(result: SmokeResult, owner: OwnedResources, steps: Record<CheckName, () => Promise<void>>): Promise<void> {
  for (const name of ["installation", "healthStatus", "compression"] as const) {
    try {
      await steps[name]();
      result.checks[name].status = "passed";
    } catch (error) {
      result.checks[name].status = "failed";
      recordSmokeFailure(result, error, name);
      break;
    }
  }
  try { await owner.cleanup(); result.cleanup.status = "passed"; }
  catch (cleanupError) {
    result.cleanup.status = "failed";
    // Cleanup errors use fixed literals only; surfacing them keeps remote
    // diagnosis actionable without exposing process output or file names.
    const detail = cleanupError instanceof Error && cleanupError.message.startsWith("cleanup: ")
      ? cleanupError.message : "Run-owned resource cleanup failed";
    if (!result.failure) recordSmokeFailure(result, new SmokeFailure("cleanup", "cleanup", detail), "cleanup");
  }
  if (!result.failure && result.cleanup.status === "passed" && Object.values(result.checks).every(c => c.status === "passed")) result.outcome = "passed";
}

type RecordValue = Record<string, unknown>;
interface Waiter {
  predicate: (record: RecordValue) => boolean;
  resolve: (record: RecordValue) => void;
  reject: (error: Error) => void;
}
const MAX_RPC_RECORD = 4_194_304;

export class RpcSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly owner?: OwnedResources;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private readonly recent: Array<{ record: RecordValue; bytes: number }> = [];
  private recentBytes = 0;
  private readonly waiters = new Set<Waiter>();
  private readonly pendingIds = new Set<string>();
  private readonly prefix = randomUUID();
  private sequence = 0;
  private failure?: Error;
  private backpressured = false;
  private readonly writeQueue: Array<{ id: string; line: string }> = [];
  private queuedBytes = 0;
  private readonly onDrain = () => {
    this.backpressured = false;
    while (!this.backpressured && this.writeQueue.length && !this.failure) {
      const { id, line } = this.writeQueue.shift()!;
      this.queuedBytes -= line.length;
      this.writeCommand(id, line);
    }
  };

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.owner = childOwners.get(child);
    this.owner?.registerRpc(() => this.close());
    child.stdout.on("data", chunk => this.receive(this.decoder.write(Buffer.from(chunk))));
    child.stdout.on("end", () => this.fail("EOF"));
    child.stdout.on("error", () => this.fail("output failed"));
    child.stdin.on("error", () => this.fail("write failed"));
    child.stderr.on("data", () => {});
    child.on("error", () => this.fail("process failed"));
    child.on("exit", () => this.fail("process exited"));
    child.on("close", () => this.fail("process closed"));
    if (child.exitCode !== null || child.signalCode !== null || child.stdout.readableEnded) this.fail("process exited");
  }

  private fail(reason: string): void {
    if (this.failure) return;
    this.failure = new Error(`rpc: ${reason}`);
    this.child.stdin.off("drain", this.onDrain);
    this.writeQueue.length = 0;
    this.queuedBytes = 0;
    for (const waiter of [...this.waiters]) waiter.reject(this.failure);
    this.buffer = "";
    this.recent.length = 0;
    this.recentBytes = 0;
  }

  private receive(text: string): void {
    if (this.failure) return;
    this.buffer += text;
    let lf: number;
    while ((lf = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, lf).replace(/\r$/, "");
      this.buffer = this.buffer.slice(lf + 1);
      if (line.length > MAX_RPC_RECORD) { this.fail("record limit exceeded"); return; }
      let record: RecordValue;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        record = value as RecordValue;
      } catch { this.fail("invalid record"); return; }
      let delivered = false;
      for (const waiter of [...this.waiters]) {
        try {
          if (waiter.predicate(record)) { delivered = true; waiter.resolve(record); }
        } catch { waiter.reject(new Error("rpc: predicate failed")); }
      }
      if (!delivered && record.type !== "response") {
        this.recent.push({ record, bytes: line.length });
        this.recentBytes += line.length;
        while (this.recent.length > 256 || this.recentBytes > MAX_RPC_RECORD) this.recentBytes -= this.recent.shift()!.bytes;
      }
    }
    if (this.buffer.length > MAX_RPC_RECORD) this.fail("record limit exceeded");
  }

  waitFor(predicate: (record: RecordValue) => boolean, timeoutMs: number): Promise<RecordValue> {
    if (this.failure) return Promise.reject(this.failure);
    try {
      const index = this.recent.findIndex(item => predicate(item.record));
      if (index >= 0) {
        const [item] = this.recent.splice(index, 1);
        this.recentBytes -= item.bytes;
        return Promise.resolve(item.record);
      }
    } catch { return Promise.reject(new Error("rpc: predicate failed")); }
    if (this.waiters.size >= 256) return Promise.reject(new Error("rpc: waiter limit exceeded"));
    let cap: number;
    try { cap = Math.min(timeoutMs, this.owner?.timeout("prompt") ?? CAPS.prompt); }
    catch { return Promise.reject(new Error("rpc: deadline expired")); }
    if (!Number.isFinite(cap) || cap <= 0) return Promise.reject(new Error("rpc: timeout"));
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      const waiter: Waiter = {
        predicate,
        resolve: record => { finish(); resolve(record); },
        reject: error => { finish(); reject(error); },
      };
      const timer = setTimeout(() => waiter.reject(new Error("rpc: timeout")), cap);
      this.waiters.add(waiter);
    });
  }

  private writeCommand(id: string, line: string): void {
    if (this.failure || !this.pendingIds.has(id)) return;
    if (this.backpressured) {
      if (this.queuedBytes + line.length > MAX_RPC_RECORD) { this.fail("write queue limit exceeded"); return; }
      this.writeQueue.push({ id, line }); this.queuedBytes += line.length;
      return;
    }
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) { this.fail("write failed"); return; }
    try {
      if (!this.child.stdin.write(line, error => { if (error) this.fail("write failed"); })) {
        this.backpressured = true;
        this.child.stdin.once("drain", this.onDrain);
      }
    } catch { this.fail("write failed"); }
  }

  async command(payload: RecordValue, timeoutMs: number): Promise<RecordValue> {
    if (this.failure) throw this.failure;
    if (this.pendingIds.size >= 256) throw new Error("rpc: command limit exceeded");
    const id = typeof payload.id === "string" ? payload.id : `${this.prefix}-${++this.sequence}`;
    if (this.pendingIds.has(id)) throw new Error("rpc: duplicate command ID");
    const stage = payload.type === "prompt" ? "prompt" : "rpc";
    let cap: number;
    let line: string;
    try {
      cap = Math.min(timeoutMs, this.owner?.timeout(stage) ?? CAPS[stage]);
      line = JSON.stringify({ ...payload, id }) + "\n";
    } catch { throw new Error("rpc: invalid command or deadline"); }
    if (!Number.isFinite(cap) || cap <= 0) throw new Error("rpc: timeout");
    if (line.length > MAX_RPC_RECORD) throw new Error("rpc: command limit exceeded");
    this.pendingIds.add(id);
    // This waiter exists before write(), including when a pipe replies synchronously.
    const response = this.waitFor(record => record.type === "response" && record.id === id, cap);
    try {
      this.writeCommand(id, line);
      const record = await response;
      if (record.success !== true) throw new Error("rpc: command failed");
      return record;
    } finally { this.pendingIds.delete(id); }
  }

  async close(): Promise<void> {
    this.fail("closed");
    await endStdin(this.child, Math.min(CAPS.rpc, (this.owner?.deadline ?? Date.now() + CAPS.rpc) - Date.now()));
  }
}
