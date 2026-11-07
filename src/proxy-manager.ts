/**
 * Managed Headroom installation and proxy lifecycle.
 *
 * Responsibilities:
 *  - find a suitable Python interpreter (>= 3.10, or >= 3.11 when the pin needs it)
 *  - create a dedicated virtual environment under ~/.pi/agent/make-headroom/venv
 *  - install an exact `headroom-ai[proxy]` version from PyPI
 *  - start/stop a local proxy and wait until it is healthy
 *  - reuse a healthy proxy left by a previous Pi process
 *
 * Everything here uses Node built-ins only.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  rmSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

import { HeadroomClient } from "./headroom-client.ts";
import type { HealthInfo } from "./types.ts";

const IS_WINDOWS = process.platform === "win32";
const execFileAsync = promisify(execFile) as (
  cmd: string,
  args: string[],
  options?: { timeout?: number; windowsHide?: boolean; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface ProxyManagerOptions {
  version: string;
  extras: string;
  home: string;
  host: string;
  port: number;
  python?: string;
  installTimeoutMs: number;
  startTimeoutMs: number;
}

export interface EnsureResult {
  ok: boolean;
  version?: string;
  installed: boolean;
  detail?: string;
}

export interface ManagerStatus {
  online: boolean;
  url: string;
  port: number;
  version?: string;
  pinnedVersion: string;
  managed: boolean;
  adopted: boolean;
  venv: string;
  proxyLog: string;
  installLog: string;
  installedVersion?: string;
  lastError?: string;
}

interface RuntimeState {
  pid: number;
  port: number;
  host: string;
  version: string;
  startedAt: string;
  venv: string;
}

export interface PythonCandidate {
  cmd: string;
  args: string[];
}

/** Internal signal: stop() was called while setup was in progress. */
class SetupCancelledError extends Error {
  constructor() {
    super("Headroom setup cancelled");
    this.name = "SetupCancelledError";
  }
}

// ---------------------------------------------------------------------------
// Public helpers (also used by tests)
// ---------------------------------------------------------------------------

export function venvPaths(home: string): {
  venvDir: string;
  python: string;
  headroom: string;
} {
  const venvDir = join(home, "venv");
  const bin = join(venvDir, IS_WINDOWS ? "Scripts" : "bin");
  return {
    venvDir,
    python: join(bin, IS_WINDOWS ? "python.exe" : "python"),
    headroom: join(bin, IS_WINDOWS ? "headroom.exe" : "headroom"),
  };
}

/** Headroom 0.43+ requires Python 3.11; earlier versions require 3.10. */
export function requiredPythonMinor(version: string): number {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return 10;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 0 || minor >= 43) return 11;
  return 10;
}

export async function findPython(
  requiredMinor: number,
  preferred?: string,
): Promise<{ candidate: PythonCandidate | null; best?: string }> {
  const candidates: PythonCandidate[] = [];
  const seen = new Set<string>();

  const add = (candidate: PythonCandidate) => {
    const key = `${candidate.cmd} ${candidate.args.join(" ")}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  };

  if (preferred) add({ cmd: preferred, args: [] });
  if (IS_WINDOWS) {
    for (const minor of ["3.13", "3.12", "3.11", "3.10"]) {
      add({ cmd: "py", args: [`-${minor}`] });
    }
    add({ cmd: "py", args: ["-3"] });
    add({ cmd: "python", args: [] });
    add({ cmd: "python3", args: [] });
  } else {
    add({ cmd: "python3", args: [] });
    add({ cmd: "python", args: [] });
    for (const minor of ["3.13", "3.12", "3.11", "3.10"]) {
      add({ cmd: `python${minor}`, args: [] });
    }
  }

  let best: string | undefined;
  for (const candidate of candidates) {
    const version = await getPythonVersion(candidate);
    if (!version) continue;
    const label = `${version.major}.${version.minor}.${version.patch}`;
    if (version.major === 3 && version.minor >= requiredMinor) {
      return { candidate, best: label };
    }
    best = label;
  }
  return { candidate: null, best };
}

async function getPythonVersion(
  candidate: PythonCandidate,
): Promise<{ major: number; minor: number; patch: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      candidate.cmd,
      [...candidate.args, "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"],
      { timeout: 5_000, windowsHide: true },
    );
    const match = /^(\d+)\.(\d+)\.(\d+)/m.exec(stdout.trim());
    if (!match) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proxy manager
// ---------------------------------------------------------------------------

export class ProxyManager {
  private readonly version: string;
  private readonly extras: string;
  private readonly home: string;
  private readonly host: string;
  private readonly basePort: number;
  private readonly preferredPython?: string;
  private readonly installTimeoutMs: number;
  private readonly startTimeoutMs: number;

  private proc: ChildProcess | null = null;
  private activeChild: ChildProcess | null = null;
  private heldLock: string | null = null;
  private runId = 0;
  private procRunId: number | null = null;
  private startedByUs = false;
  private adopted = false;
  private stopping = false;
  private portValue: number;
  private runtime: RuntimeState | null = null;
  private lastError = "";
  private tail = new TailBuffer(300);
  private installedNow = false;

  constructor(options: ProxyManagerOptions) {
    this.version = options.version;
    this.extras = options.extras;
    this.home = options.home;
    this.host = options.host;
    this.basePort = options.port;
    this.portValue = options.port;
    this.preferredPython = options.python || undefined;
    this.installTimeoutMs = options.installTimeoutMs;
    this.startTimeoutMs = options.startTimeoutMs;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.portValue}`;
  }

  get port(): number {
    return this.portValue;
  }

  get isManaged(): boolean {
    return this.startedByUs;
  }

  get isAdopted(): boolean {
    return this.adopted;
  }

  get venvDir(): string {
    return venvPaths(this.home).venvDir;
  }

  get proxyLog(): string {
    return join(this.home, "proxy.log");
  }

  get installLog(): string {
    return join(this.home, "install.log");
  }

  get lastErrorText(): string {
    return this.lastError;
  }

  async status(): Promise<ManagerStatus> {
    const info = await this.healthAt(this.portValue, 2_000);
    return {
      online: info !== null,
      url: this.baseUrl,
      port: this.portValue,
      version: info?.version,
      pinnedVersion: this.version,
      managed: this.startedByUs,
      adopted: this.adopted,
      venv: this.venvDir,
      proxyLog: this.proxyLog,
      installLog: this.installLog,
      installedVersion: await this.readInstalledVersion(),
      lastError: this.lastError || undefined,
    };
  }

  async ensureRunning(onStatus: (message: string) => void): Promise<EnsureResult> {
    const runId = ++this.runId;
    this.stopping = false;
    this.lastError = "";
    this.installedNow = false;
    this.ensureDirs();

    try {
      // 0. This manager may still own a live child (for example, after
      //    /headroom off followed by /headroom on). Keep ownership so shutdown
      //    can stop it instead of adopting it and leaking the process.
      if (this.proc && this.proc.exitCode === null) {
        const info = await this.healthAt(this.portValue, 2_000);
        this.checkRun(runId);
        if (info && versionsMatch(info.version, this.version)) {
          this.startedByUs = true;
          this.adopted = false;
          this.procRunId = runId;
          return { ok: true, version: info.version, installed: false };
        }
        // We own this child but it is not healthy (wedged or wrong version).
        // Stop it before starting another proxy so it cannot leak.
        killTree(this.proc);
        this.proc = null;
        this.procRunId = null;
        this.startedByUs = false;
        this.removeRuntime();
      }

      // 1. Reuse a proxy this extension left behind in a previous Pi process.
      const runtime = this.readRuntime();
      if (runtime && runtime.version === this.version && runtime.host === this.host) {
        const info = await this.healthAt(runtime.port, 2_000);
        this.checkRun(runId);
        if (info && versionsMatch(info.version, this.version)) {
          this.portValue = runtime.port;
          this.runtime = runtime;
          this.adopted = true;
          this.startedByUs = false;
          return { ok: true, version: info.version, installed: false };
        }
        this.removeRuntime();
      }

      // 2. Pick a free port. A foreign service on the configured port is skipped.
      const port = await this.pickPort();
      this.checkRun(runId);
      this.portValue = port;

      // 3. Install the pinned version into the dedicated venv when needed.
      await this.ensureVenv(onStatus, runId);
      this.checkRun(runId);

      // 4. Start the proxy.
      onStatus("Starting Headroom proxy…");
      this.startProxy(port, runId);
      const ok = await this.waitForHealth(port, onStatus, runId);
      if (!ok) {
        const cancelled = this.stopping || runId !== this.runId;
        const detail = cancelled
          ? "Headroom setup cancelled"
          : this.lastError || this.tail.text(20);
        this.killProcess(runId);
        return { ok: false, detail, installed: this.installedNow };
      }

      if (
        !this.proc ||
        this.procRunId !== runId ||
        this.proc.exitCode !== null
      ) {
        const detail = this.lastError || "Headroom proxy exited right after startup";
        this.killProcess(runId);
        return { ok: false, detail, installed: this.installedNow };
      }

      this.checkRun(runId);
      const info = await this.healthAt(port, 2_000);
      this.checkRun(runId);
      this.startedByUs = true;
      this.adopted = false;
      this.runtime = {
        pid: this.proc?.pid ?? 0,
        port,
        host: this.host,
        version: this.version,
        startedAt: new Date().toISOString(),
        venv: this.venvDir,
      };
      this.writeRuntime(this.runtime);
      return { ok: true, version: info?.version ?? this.version, installed: this.installedNow };
    } catch (error) {
      if (error instanceof SetupCancelledError) {
        this.killProcess(runId);
        return { ok: false, detail: "Headroom setup cancelled", installed: this.installedNow };
      }
      throw error;
    }
  }

  async tryRestart(onStatus: (message: string) => void): Promise<boolean> {
    if (this.proc && this.proc.exitCode === null) return false;
    this.stopping = false;
    this.proc = null;
    this.procRunId = null;
    this.startedByUs = false;
    this.adopted = false;
    const result = await this.ensureRunning(onStatus);
    return result.ok;
  }

  async restart(onStatus: (message: string) => void): Promise<EnsureResult> {
    await this.stop(true);
    this.stopping = false;
    return this.ensureRunning(onStatus);
  }

  async reinstall(onStatus: (message: string) => void): Promise<EnsureResult> {
    await this.stop(true);
    this.removeRuntime();
    try {
      rmSync(this.venvDir, { recursive: true, force: true });
    } catch {
      // Best effort; the venv may already be gone.
    }
    return this.ensureRunning(onStatus);
  }

  async stop(force = false): Promise<void> {
    this.stopping = true;
    this.runId++;

    // Abort an in-flight install (pip/venv) if setup is still running.
    const child = this.activeChild;
    this.activeChild = null;
    if (child) {
      killTree(child);
    }
    this.releaseHeldLock();

    const proc = this.proc;
    if (proc) {
      // A non-null ChildProcess handle means this manager started it, even if
      // health has not completed yet. Always stop it.
      await terminateProcess(proc);
      this.proc = null;
      this.procRunId = null;
      this.startedByUs = false;
      this.removeRuntime();
    } else if (force) {
      // We adopted a proxy that another Pi process (or a previous run) left
      // behind. There is no ChildProcess handle, so use the recorded pid.
      await this.stopAdopted();
    } else if (this.startedByUs) {
      this.removeRuntime();
    }

    this.adopted = false;
    // Keep `stopping` true. ensureRunning() resets it when setup is requested
    // again (e.g. /headroom restart).
  }

  private async stopAdopted(): Promise<void> {
    const runtime = this.runtime ?? this.readRuntime();
    if (runtime && runtime.pid > 0) {
      await terminatePid(runtime.pid);
    }
    this.runtime = null;
    this.removeRuntime();
  }

  async health(): Promise<HealthInfo | null> {
    return this.healthAt(this.portValue, 3_000);
  }

  // -------------------------------------------------------------------------
  // Port selection
  // -------------------------------------------------------------------------

  private async pickPort(): Promise<number> {
    for (let offset = 0; offset < 50; offset++) {
      const candidate = this.basePort + offset;
      if (candidate > 65_535) break;
      const open = await isPortOpen(this.host, candidate, 500);
      if (!open) return candidate;
    }
    throw new Error(
      `No free port found from ${this.basePort} to ${this.basePort + 49}. Set HEADROOM_PORT to a free port.`,
    );
  }

  private checkRun(runId: number): void {
    if (this.stopping || runId !== this.runId) throw new SetupCancelledError();
  }

  private releaseHeldLock(): void {
    const path = this.heldLock;
    this.heldLock = null;
    if (!path) return;
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }

  private async healthAt(port: number, timeoutMs: number): Promise<HealthInfo | null> {
    const client = new HeadroomClient({
      baseUrl: `http://${this.host}:${port}`,
      timeoutMs,
    });
    return client.health(timeoutMs);
  }

  // -------------------------------------------------------------------------
  // Virtual environment + installation
  // -------------------------------------------------------------------------

  private async ensureVenv(
    onStatus: (message: string) => void,
    runId: number,
  ): Promise<void> {
    this.checkRun(runId);
    if (await this.isInstalled()) return;
    this.checkRun(runId);

    const release = await this.acquireLock(onStatus, runId);
    try {
      this.checkRun(runId);
      if (await this.isInstalled()) return;
      this.checkRun(runId);

      this.ensureDirs();
      rotateLog(this.installLog, 5_000_000);
      const paths = venvPaths(this.home);
      const requiredMinor = requiredPythonMinor(this.version);

      if (!existsSync(paths.python)) {
        const found = await findPython(requiredMinor, this.preferredPython);
        if (!found.candidate) {
          const requiredLabel = `3.${requiredMinor}`;
          const foundText = found.best
            ? ` Found Python ${found.best}, but ${requiredLabel}+ is required.`
            : "";
          throw new Error(
            `Python ${requiredLabel}+ was not found. Install Python ${requiredLabel}+ and retry.${foundText}`,
          );
        }

        onStatus("Creating Python virtual environment…");
        const venvArgs = found.candidate.args.slice();
        venvArgs.push("-m", "venv");
        if (existsSync(paths.venvDir)) {
          venvArgs.push("--clear");
        }
        venvArgs.push(paths.venvDir);

        const created = await this.runInstallCommand(
          found.candidate.cmd,
          venvArgs,
          120_000,
          onStatus,
          "create-venv",
          runId,
        );
        this.checkRun(runId);
        if (created.code !== 0) {
          throw new Error(
            `Could not create the Python virtual environment (exit ${created.code})` +
              `${created.error ? `: ${created.error}` : ""}. On Debian/Ubuntu install python3-venv.`,
          );
        }
      }

      // `python -m venv` normally includes pip. Repair a venv that does not.
      const pipCheck = await this.runInstallCommand(
        paths.python,
        ["-m", "pip", "--version"],
        15_000,
        () => undefined,
        "check-pip",
        runId,
      );
      this.checkRun(runId);
      if (pipCheck.code !== 0) {
        const ensured = await this.runInstallCommand(
          paths.python,
          ["-m", "ensurepip", "--upgrade"],
          60_000,
          onStatus,
          "ensurepip",
          runId,
        );
        this.checkRun(runId);
        if (ensured.code !== 0) {
          throw new Error(
            `The virtual environment has no pip${ensured.error ? `: ${ensured.error}` : ""}. ` +
              "Recreate it with a Python that includes ensurepip.",
          );
        }
      }

      const requirementsPath = join(this.home, "requirements.txt");
      const requirement = `headroom-ai[${this.extras}]==${this.version}\n`;
      writeFileSync(
        requirementsPath,
        `# Generated by pi-make-headroom. Do not edit; change the version in config.json or HEADROOM_VERSION.\n${requirement}`,
      );

      onStatus(
        `Installing Headroom ${this.version} (first run, this can take a few minutes)…`,
      );
      const installed = await this.runInstallCommand(
        paths.python,
        [
          "-m",
          "pip",
          "install",
          "--upgrade",
          "--disable-pip-version-check",
          "--no-input",
          "-r",
          requirementsPath,
        ],
        this.installTimeoutMs,
        onStatus,
        "pip-install",
        runId,
      );

      this.checkRun(runId);
      if (installed.code !== 0) {
        throw new Error(
          `pip install failed (exit ${installed.code})` +
            `${installed.error ? `: ${installed.error}` : ""}. See ${this.installLog}.`,
        );
      }

      this.checkRun(runId);
      const version = await this.readInstalledVersion();
      this.checkRun(runId);
      if (version !== this.version) {
        throw new Error(
          `Installed headroom-ai version is ${version ?? "unknown"}, expected ${this.version}. See ${this.installLog}.`,
        );
      }

      if (!existsSync(paths.headroom)) {
        throw new Error(
          `headroom-ai ${this.version} installed, but the headroom executable is missing from ${paths.headroom}.`,
        );
      }

      this.checkRun(runId);
      writeFileSync(
        join(this.venvDir, "installed.json"),
        JSON.stringify(
          {
            version: this.version,
            extras: this.extras,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      this.installedNow = true;
    } finally {
      release();
    }
  }

  private async isInstalled(): Promise<boolean> {
    const paths = venvPaths(this.home);
    if (!existsSync(paths.python) || !existsSync(paths.headroom)) return false;

    try {
      const marker = JSON.parse(
        readFileSync(join(this.venvDir, "installed.json"), "utf8"),
      ) as { version?: string; extras?: string };
      if (marker.version !== this.version || marker.extras !== this.extras) return false;
    } catch {
      return false;
    }

    return (await this.readInstalledVersion()) === this.version;
  }

  private async readInstalledVersion(): Promise<string | undefined> {
    const paths = venvPaths(this.home);
    if (!existsSync(paths.python)) return undefined;
    try {
      const { stdout } = await execFileAsync(
        paths.python,
        ["-c", "import importlib.metadata as m; print(m.version('headroom-ai'))"],
        { timeout: 10_000, windowsHide: true },
      );
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async acquireLock(
    onStatus: (message: string) => void,
    runId: number,
  ): Promise<() => void> {
    const lockPath = join(this.home, "install.lock");
    const startedAt = Date.now();
    const timeoutMs = 20 * 60_000;

    while (true) {
      this.checkRun(runId);
      try {
        const fd = openSync(lockPath, "wx");
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        closeSync(fd);
        this.heldLock = lockPath;
        return () => {
          if (this.heldLock === lockPath) this.heldLock = null;
          try {
            unlinkSync(lockPath);
          } catch {
            // Already gone.
          }
        };
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
      }

      if (isLockStale(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Another waiter may have removed it first.
        }
        continue;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for ${lockPath}`);
      }
      onStatus("Waiting for another Pi session to finish installing Headroom…");
      await sleep(1_000);
    }
  }

  private async runInstallCommand(
    cmd: string,
    args: string[],
    timeoutMs: number,
    onStatus: (message: string) => void,
    label: string,
    runId: number,
  ): Promise<{ code: number | null; output: string; error?: string }> {
    this.checkRun(runId);
    const logPath = this.installLog;
    const started = Date.now();
    let lastStatusAt = 0;
    const linesToShow: string[] = [];

    let child: ChildProcess | null = null;
    const result = await runStreaming(cmd, args, {
      timeoutMs,
      env: buildChildEnv(),
      onSpawn: (proc) => {
        child = proc;
        if (this.stopping || runId !== this.runId) {
          killTree(proc);
          return;
        }
        this.activeChild = proc;
      },
      onClose: () => {
        if (this.activeChild === child) this.activeChild = null;
        child = null;
      },
      onOutput: (chunk) => {
        for (const raw of chunk.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) continue;
          if (/^(Collecting|Downloading|Installing|Successfully|Building|Preparing|Using cached|Requirement already)/i.test(line) ||
              /\d+%/.test(line)) {
            linesToShow.push(line);
            if (linesToShow.length > 50) linesToShow.shift();
          }
        }
        if (this.stopping || runId !== this.runId) return;
        const now = Date.now();
        if (now - lastStatusAt > 1_500 && linesToShow.length > 0) {
          lastStatusAt = now;
          const last = truncate(linesToShow[linesToShow.length - 1], 90);
          onStatus(`${label === "pip-install" ? "Installing Headroom" : "Headroom setup"} · ${last}`);
        }
      },
    });

    const header = `\n===== ${new Date().toISOString()} ${label}: ${cmd} ${args.join(" ")} (exit ${result.code}${result.error ? `, ${result.error}` : ""}, ${Math.round((Date.now() - started) / 1000)}s) =====\n`;
    try {
      appendFileSync(logPath, header + result.output.slice(-500_000) + "\n");
    } catch {
      // Logging is best effort.
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Runtime state
  // -------------------------------------------------------------------------

  private runtimePath(): string {
    return join(this.home, "runtime.json");
  }

  private readRuntime(): RuntimeState | null {
    try {
      const data = JSON.parse(readFileSync(this.runtimePath(), "utf8")) as RuntimeState;
      if (
        data &&
        typeof data.pid === "number" &&
        typeof data.port === "number" &&
        typeof data.host === "string" &&
        typeof data.version === "string"
      ) {
        return data;
      }
    } catch {
      // Missing or corrupt state.
    }
    return null;
  }

  private writeRuntime(state: RuntimeState): void {
    try {
      writeFileSync(this.runtimePath(), JSON.stringify(state, null, 2));
    } catch {
      // State is only an optimization; failing to persist it is not fatal.
    }
  }

  private removeRuntime(): void {
    try {
      unlinkSync(this.runtimePath());
    } catch {
      // Already gone.
    }
  }

  private ensureDirs(): void {
    mkdirSync(this.home, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Proxy process
  // -------------------------------------------------------------------------

  private startProxy(port: number, runId: number): void {
    this.checkRun(runId);
    this.ensureDirs();
    const paths = venvPaths(this.home);
    if (!existsSync(paths.headroom)) {
      throw new Error(`headroom executable not found at ${paths.headroom}`);
    }

    rotateLog(this.proxyLog);
    this.tail = new TailBuffer(300);

    const proc = spawn(paths.headroom, ["proxy", "--port", String(port), "--host", this.host], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !IS_WINDOWS,
      env: buildChildEnv(),
    });

    const logStream = createWriteStream(this.proxyLog, { flags: "a" });
    logStream.on("error", () => {
      // Logging is best effort.
    });

    const write = (chunk: Buffer) => {
      const text = chunk.toString();
      this.tail.push(text);
      logStream.write(text);
    };

    proc.stdout?.on("data", write);
    proc.stderr?.on("data", write);
    proc.on("error", (error) => {
      this.lastError = `Could not start headroom: ${error.message}`;
      this.tail.push(`spawn error: ${error.message}`);
      logStream.end();
      if (this.proc === proc) {
        this.proc = null;
        this.startedByUs = false;
      }
    });
    proc.on("exit", (code, signal) => {
      logStream.end();
      if (this.proc === proc) {
        if (!this.stopping && code !== 0 && code !== null) {
          this.lastError = `Headroom proxy exited with code ${code}${signal ? ` (${signal})` : ""}`;
        }
        this.proc = null;
        this.procRunId = null;
        this.startedByUs = false;
      }
    });

    this.proc = proc;
    this.procRunId = runId;
  }

  private async waitForHealth(
    port: number,
    onStatus: (message: string) => void,
    runId: number,
  ): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs;
    let tick = 0;
    let kompressDeadline = 0;

    while (Date.now() < deadline) {
      if (this.stopping || runId !== this.runId) return false;
      if (!this.proc || this.procRunId !== runId) return false;
      if (this.proc.exitCode !== null) return false;

      const info = await this.healthAt(port, 2_000);
      if (info && (info.ready || info.status === "healthy")) {
        if (info.version && !versionsMatch(info.version, this.version)) {
          this.lastError = `Proxy on port ${port} is version ${info.version}, expected ${this.version}`;
          return false;
        }

        // /health turns ready before the optional Kompress model finishes
        // warming. Sending the first request too early makes the router cache a
        // "skip" verdict for that content, so wait briefly for the compressor.
        if (info.kompressEnabled && !info.kompressReady) {
          if (kompressDeadline === 0) kompressDeadline = Date.now() + 30_000;
          if (Date.now() < kompressDeadline) {
            tick++;
            if (tick % 6 === 0) {
              onStatus("Waiting for the Headroom compression model…");
            }
            await sleep(500);
            continue;
          }
          onStatus("Headroom compression model is still warming; continuing.");
        }

        return true;
      }

      tick++;
      if (tick % 6 === 0) {
        const elapsed = Math.round((this.startTimeoutMs - (deadline - Date.now())) / 1000);
        onStatus(`Waiting for Headroom proxy… (${elapsed}s)`);
      }
      await sleep(500);
    }

    if (!this.lastError) {
      this.lastError = `Headroom proxy did not become healthy within ${Math.round(this.startTimeoutMs / 1000)}s`;
    }
    return false;
  }

  private killProcess(runId: number): void {
    if (this.procRunId !== runId) return;
    const proc = this.proc;
    this.proc = null;
    this.procRunId = null;
    this.startedByUs = false;
    if (proc) {
      killTree(proc);
    }
  }
}

// ---------------------------------------------------------------------------
// Process / IO helpers
// ---------------------------------------------------------------------------

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Privacy: opt out of Headroom's anonymous upload beacon and local telemetry
  // unless the user explicitly configured them.
  if (!env.HEADROOM_TELEMETRY) env.HEADROOM_TELEMETRY = "off";
  if (!env.HEADROOM_BEACON) env.HEADROOM_BEACON = "off";
  if (!env.DO_NOT_TRACK) env.DO_NOT_TRACK = "1";
  if (!env.PYTHONUNBUFFERED) env.PYTHONUNBUFFERED = "1";
  return env;
}

function versionsMatch(actual: string | undefined, expected: string): boolean {
  if (!actual) return true;
  return actual.trim() === expected.trim();
}

function runStreaming(
  cmd: string,
  args: string[],
  options: {
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    onOutput?: (chunk: string) => void;
    onSpawn?: (proc: ChildProcess) => void;
    onClose?: () => void;
  },
): Promise<{ code: number | null; output: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !IS_WINDOWS,
      env: options.env,
    });

    let output = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.onClose?.();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        killTree(proc);
        resolve({
          code: null,
          output,
          error: `Command timed out after ${Math.round(options.timeoutMs / 1000)}s`,
        });
      });
    }, options.timeoutMs);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 4_000_000) output = output.slice(-4_000_000);
      options.onOutput?.(text);
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (error) => {
      finish(() => resolve({ code: null, output, error: error.message }));
    });
    proc.on("close", (code) => {
      finish(() => resolve({ code, output }));
    });

    options.onSpawn?.(proc);
  });
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;

  if (IS_WINDOWS) {
    try {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Best effort.
    }
    return;
  }

  try {
    // The child is detached, so it leads its own process group. A negative
    // pid signals the whole group, including pip's ensurepip children.
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already dead.
    }
  }
}

async function terminateProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;

  if (IS_WINDOWS) {
    killTree(proc);
    await sleep(500);
    return;
  }

  try {
    if (proc.pid) {
      process.kill(-proc.pid, "SIGTERM");
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      return;
    }
  }

  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      proc.once("exit", () => resolve(true));
    }),
    sleep(3_000).then(() => false),
  ]);

  if (!exited && proc.exitCode === null) {
    killTree(proc);
  }
}

async function terminatePid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!(await looksLikeHeadroomProxy(pid))) return;

  if (IS_WINDOWS) {
    await runStreaming("taskkill", ["/pid", String(pid), "/T", "/F"], {
      timeoutMs: 10_000,
      env: buildChildEnv(),
    }).catch(() => undefined);
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  for (let i = 0; i < 30; i++) {
    if (!isProcessAlive(pid)) return;
    await sleep(100);
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function looksLikeHeadroomProxy(pid: number): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return cmdline.includes("headroom") && cmdline.includes("proxy");
    } catch {
      return false;
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
        timeout: 3_000,
      });
      return stdout.includes("headroom") && stdout.includes("proxy");
    } catch {
      return false;
    }
  }
  return true;
}

function isLockStale(path: string): boolean {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (typeof data.pid === "number" && Number.isInteger(data.pid) && data.pid > 0) {
      if (!isProcessAlive(data.pid)) return true;
    }
    return Date.now() - statSync(path).mtimeMs > 30 * 60_000;
  } catch {
    // Missing, unreadable, or malformed: treat as stale.
    return true;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it.
    return isErrorCode(error, "EPERM");
  }
}


function isPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function rotateLog(path: string, maxBytes = 2_000_000): void {
  try {
    if (existsSync(path) && statSync(path).size > maxBytes) {
      writeFileSync(path, "");
    }
  } catch {
    // Best effort.
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TailBuffer {
  private lines: string[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(chunk: string): void {
    this.lines.push(...chunk.split(/\r?\n/));
    if (this.lines.length > this.max) {
      this.lines.splice(0, this.lines.length - this.max);
    }
  }

  text(count: number): string {
    return this.lines.slice(-count).join("\n").trim();
  }
}
