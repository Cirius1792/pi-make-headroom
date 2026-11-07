// Explicitly invoked live test: real Pi CLI, packed checkout, managed Headroom; only the LLM is mocked.
import { access, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  assertCompletedTurn, assertTargetCompression, buildChildEnv, createHarness, createSmokeResult, fixtureText,
  recordSmokeFailure, RpcSession, runSmokeChecks, SmokeFailure, validateVersions,
  type FailureCategory, type OwnedResources,
} from "./harness.ts";
import { startMockLlm } from "./mock-llm.ts";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Fixed bounded fixture, identical for every pair. Never search/adapt to the candidate's counters.
export const FIXTURE_PROMPTS = [
  "SMOKE_ANCHOR_ALPHA: retain the reference notes.",
  "SMOKE_ANCHOR_BETA: retain the reference notes.",
  "SMOKE_ANCHOR_GAMMA: retain the reference notes.",
  "SMOKE_ANCHOR_DELTA: retain the reference notes.",
  "SMOKE_ANCHOR_EPSILON: retain the reference notes.",
  "SMOKE_ANCHOR_ZETA: retain the reference notes.",
];
export const TARGET_PROMPT = "SMOKE_ANCHOR_TARGET: acknowledge completion.";
const FINAL_REPLY = "Compatibility smoke completed.";
export function fixtureReply(index: number): string {
  return `Reference notebook ${index + 1}.\n` + Array.from({ length: 160 }, (_, row) =>
    `Note ${row + 1}: The local reference service binds to loopback. The reference service keeps redundant historical notes. ` +
    "The reference service preserves the current user instruction. The reference service is healthy and ready.\n").join("");
}

async function stage<T>(name: string, category: FailureCategory, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof SmokeFailure) throw error;
    const message = error instanceof Error ? error.message : "";
    const timedOut = /^(?:command:|process:|rpc:|deadline:).*?(?:timed out|timeout|deadline|exhausted|expired)/.test(message);
    const assertion = message.startsWith("assertion:");
    throw new SmokeFailure(name, timedOut ? "timeout" : assertion ? "assertion" : category,
      timedOut ? "Operation exceeded its bounded deadline" : assertion ? "Smoke acceptance assertion failed" : "Operation failed; raw diagnostics withheld");
  }
}
function requireCondition(condition: unknown, stage: string, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(stage, "assertion", message);
}
async function pythonPath(env: NodeJS.ProcessEnv): Promise<string> {
  const supplied = env.HEADROOM_PYTHON;
  const candidates = supplied ? [supplied] : (env.PATH ?? "").split(delimiter).map(p => join(p, "python3.11"));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* next PATH entry */ }
  }
  throw new SmokeFailure("python", "environment", "Python 3.11 executable required; set HEADROOM_PYTHON to an absolute path");
}

/** Fixed diagnostic vocabulary only: no exception bodies, URLs, paths, or module names escape. */
export function diagnoseSetupFailure(text: string): SmokeFailure {
  if (/CERTIFICATE_VERIFY_FAILED|certificate verify failed/i.test(text)) return new SmokeFailure("managed-setup", "environment", "Managed setup TLS certificate verification failed; trust configuration was not bypassed");
  if (/connection|connecterror|proxyerror|403 forbidden|tunnel|network is unreachable|name resolution/i.test(text)) {
    const domain = ["pypi.org", "files.pythonhosted.org", "huggingface.co", "cas-server.xethub.hf.co", "github.com", "openaipublic.blob.core.windows.net", "download.pytorch.org"].find(d => text.includes(d));
    return new SmokeFailure("managed-setup", "environment", domain
      ? `Managed setup network failure involving ${domain}; sandbox boundary preserved`
      : "Managed setup network connection failed; sandbox boundary preserved");
  }
  if (/ModuleNotFoundError|ImportError/.test(text)) return new SmokeFailure("managed-setup", "provisioning", "Managed setup failed while importing a Python module");
  if (/No matching distribution|Could not find a version that satisfies/.test(text)) return new SmokeFailure("managed-setup", "provisioning", "Requested Python distribution or dependency is unavailable");
  return new SmokeFailure("managed-setup", "provisioning", "Managed setup ended offline; raw diagnostics withheld");
}
async function diagnosticTail(path: string): Promise<string> {
  try {
    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 65_536));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return buffer.toString("utf8", 0, bytesRead);
    } finally { await handle.close(); }
  } catch { return ""; }
}

/** Read only fixed numeric/status fields; notifications themselves stay in memory. */
export function parseSavedTokens(notification: string): number {
  const match = /^\s*Saved:\s*([\d,]+) tokens\b/m.exec(notification);
  const value = match ? Number(match[1].replaceAll(",", "")) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("assertion: missing saved-token counter");
  return value;
}

async function notification(rpc: RpcSession, owner: OwnedResources, command: "status" | "health"): Promise<string> {
  const pending = rpc.waitFor(record => record.type === "extension_ui_request" && record.method === "notify" &&
    typeof record.message === "string" && (command === "status"
      ? record.message.includes("Headroom context compression") : record.message.includes("Headroom proxy:")), owner.timeout("rpc"));
  // Observe both promises even if command acceptance fails.
  const [event] = await Promise.all([pending, rpc.command({ type: "prompt", message: `/headroom ${command}` }, owner.timeout("rpc"))]);
  return event.message as string;
}

async function turn(rpc: RpcSession, owner: OwnedResources, prompt: string, expected: string): Promise<void> {
  // Subscribe before sending. get_state + authoritative message_end works even without agent_settled.
  const end = rpc.waitFor(event => event.type === "message_end" &&
    (event.message as Record<string, unknown>)?.role === "assistant", owner.timeout("prompt"));
  const [completed] = await Promise.all([end, rpc.command({ type: "prompt", message: prompt }, owner.timeout("prompt"))]);
  const stopAt = Date.now() + owner.timeout("prompt");
  while (true) {
    const response = await rpc.command({ type: "get_state" }, Math.min(owner.timeout("rpc"), Math.max(1, stopAt - Date.now())));
    const state = response.data as Record<string, unknown>;
    if (state?.isStreaming === false && state.isCompacting === false && state.pendingMessageCount === 0) {
      assertCompletedTurn(completed.message as Record<string, unknown>, state, expected);
      return;
    }
    if (Date.now() >= stopAt) throw new SmokeFailure("turn", "timeout", "Model turn did not become idle");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Register cleanup synchronously after mkdtemp, before any further filesystem operation. */
export async function createSmokeWorkspace(requested: { piVersion: string; headroomVersion: string }, source: NodeJS.ProcessEnv, deadline = Date.now() + 30 * 60_000) {
  validateVersions(requested.piVersion, requested.headroomVersion);
  const workspace = await mkdtemp(join(tmpdir(), "headroom-smoke-"));
  const isolated = {
    HOME: join(workspace, "home"), PI_CODING_AGENT_DIR: join(workspace, "agent"),
    HEADROOM_HOME: join(workspace, "managed"), HEADROOM_VERSION: requested.headroomVersion,
    HEADROOM_PYTHON: source.HEADROOM_PYTHON,
  };
  const { owner } = createHarness(requested.piVersion, requested.headroomVersion, { deadline, isolated });
  owner.registerResource(() => {}, () => rm(workspace, { recursive: true, force: true }));
  const env = buildChildEnv(source, isolated, owner.runId);
  Object.assign(env, {
    XDG_CACHE_HOME: join(workspace, "cache"), npm_config_cache: join(workspace, "cache", "npm"),
    PIP_CACHE_DIR: join(workspace, "cache", "pip"), HF_HOME: join(workspace, "cache", "huggingface"),
  });
  try {
    for (const directory of ["home", "agent", "managed", "work", "prefix", "archive", "unpacked", "cache"])
      await mkdir(join(workspace, directory));
    return { owner, workspace, env };
  } catch (error) { await owner.cleanup(); throw error; }
}

export async function runSmoke(env: NodeJS.ProcessEnv = process.env) {
  // Invalid inputs are deliberately not copied to the report (could contain secrets/command text).
  const result = createSmokeResult("", { piVersion: "", headroomVersion: "" });
  const destination = resolve(env.E2E_RESULT_PATH ?? join(checkout, ".agents/compatibility-smoke/result.json"));
  let owner: OwnedResources | undefined;
  try {
    await mkdir(dirname(destination), { recursive: true });
    try { result.requested = validateVersions(env.PI_VERSION, env.HEADROOM_VERSION); }
    catch { throw new SmokeFailure("versions", "input", "Exact Pi and canonical Headroom versions are required"); }
    const deadline = Date.now() + 30 * 60_000;
    const python = await stage("python", "environment", () => pythonPath(env));
    const allocated = await stage("workspace", "environment", () => createSmokeWorkspace(result.requested, { ...env, HEADROOM_PYTHON: python }, deadline));
    owner = allocated.owner;
    const resources = owner;
    const { workspace, env: childEnv } = allocated;
    let rpc: RpcSession;
    let mock: Awaited<ReturnType<typeof startMockLlm>>;
    let endpoint = "";
    let runtime: Record<string, unknown>;
    const run = (cmd: string, args: string[], cwd: string, cap: "inspect" | "provision" = "inspect") =>
      resources.runOwned(cmd, args, { cwd, env: childEnv, timeoutMs: resources.timeout(cap) });
    await runSmokeChecks(result, resources, {
      installation: async () => {
        await stage("commit", "environment", async () => {
          const commit = (await run("git", ["rev-parse", "HEAD"], checkout)).stdout.trim();
          requireCondition(/^[a-f0-9]{40}$/.test(commit), "commit", "Unable to resolve checkout commit");
          result.extensionCommit = commit;
        });
        await stage("runtimes", "environment", async () => {
          const [major, minor] = process.versions.node.split(".").map(Number);
          if (major !== 22 || minor < 19) throw new SmokeFailure("node", "environment", "Node 22.19 or newer Node 22 is required");
          const version = (await run(python, ["-c", "import platform; print(platform.python_version())"], workspace)).stdout.trim();
          if (!/^3\.11\.\d+$/.test(version)) throw new SmokeFailure("python", "environment", "Selected interpreter must be Python 3.11");
          result.actual.pythonVersion = version;
        });
        const cli = join(workspace, "prefix/node_modules/.bin/pi");
        await stage("pi-install", "provisioning", async () => {
          await run("npm", ["install", "--prefix", join(workspace, "prefix"), "--ignore-scripts", "--no-audit", "--no-fund",
            `@earendil-works/pi-coding-agent@${result.requested.piVersion}`], workspace, "provision");
          const metadata = JSON.parse(await readFile(join(workspace, "prefix/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
          requireCondition(metadata.version === result.requested.piVersion, "pi-version", "Installed Pi metadata differs from requested version");
          result.actual.piVersion = metadata.version;
          const version = (await run(cli, ["--version"], join(workspace, "work"))).stdout.trim();
          requireCondition(version === result.actual.piVersion, "pi-version", "Pi CLI version differs from installed metadata");
        });
        await stage("extension-install", "provisioning", async () => {
          const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", join(workspace, "archive")], checkout)).stdout);
          const filename = packed?.[0]?.filename;
          requireCondition(typeof filename === "string" && /^[a-zA-Z0-9._-]+\.tgz$/.test(filename), "pack", "npm pack did not return a safe archive filename");
          await run("tar", ["-xzf", join(workspace, "archive", filename), "-C", join(workspace, "unpacked")], workspace);
          await run(cli, ["install", join(workspace, "unpacked/package")], join(workspace, "work"));
        });
        await stage("rpc-start", "protocol", async () => {
          mock = await startMockLlm();
          resources.registerResource(() => mock.close());
          await writeFile(join(workspace, "agent/models.json"), JSON.stringify({ providers: {
            "headroom-e2e": { baseUrl: mock.baseUrl, api: "openai-completions", apiKey: "headroom-e2e-dummy", models: [{
              id: "gpt-4o", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 32_768,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }] },
          } }));
          const child = resources.spawnOwned(cli, ["--mode", "rpc", "--no-session", "--provider", "headroom-e2e", "--model", "gpt-4o",
            "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--no-tools", "--no-approve", "--offline"],
          { cwd: join(workspace, "work"), env: childEnv, timeoutMs: resources.timeout("rpc") });
          // Drain diagnostics without retaining/printing raw bodies.
          child.stderr.on("data", () => {});
          rpc = new RpcSession(child);
          const commands = (await rpc.command({ type: "get_commands" }, resources.timeout("rpc"))).data as { commands?: Array<{ name: string }> };
          requireCondition(commands.commands?.some(c => c.name === "headroom"), "extension-load", "Installed package did not register the Headroom command");
        });
        await stage("managed-setup", "provisioning", async () => {
          const setupDeadline = Math.min(resources.deadline - 15_000, Date.now() + 20 * 60_000);
          while (true) {
            resources.timeout("inspect");
            try { runtime = JSON.parse(await readFile(join(workspace, "managed/runtime.json"), "utf8")); break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            if (Date.now() >= setupDeadline) throw new SmokeFailure("managed-setup", "timeout", "Managed setup did not publish runtime state within twenty minutes");
            // Observe lazy setup without invoking on/restart or replacing session_start.
            const status = await notification(rpc, resources, "status");
            if (/Status:\s*offline/.test(status) && !status.includes("setup is running")) {
              const diagnostics = await Promise.all(["install.log", "proxy.log"].map(name => diagnosticTail(join(workspace, "managed", name))));
              throw diagnoseSetupFailure([status, ...diagnostics].join("\n"));
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          const managed = join(workspace, "managed");
          requireCondition(runtime.host === "127.0.0.1" && Number.isInteger(runtime.port) && Number(runtime.port) > 0 && Number(runtime.port) <= 65535 &&
            runtime.venv === join(managed, "venv") && runtime.version === result.requested.headroomVersion &&
            Number.isSafeInteger(runtime.pid) && Number(runtime.pid) > 0, "managed-paths", "Runtime does not belong to this managed home");
          const marker = await readFile(`/proc/${runtime.pid}/environ`, "utf8");
          requireCondition(marker.split("\0").includes(`HEADROOM_E2E_RUN_ID=${resources.runId}`), "managed-ownership", "Proxy is not tagged as owned by this run");
          endpoint = `http://127.0.0.1:${runtime.port}`;
          const version = (await run(join(managed, "venv/bin/python"), ["-c", "from importlib.metadata import version; print(version('headroom-ai'))"], workspace)).stdout.trim();
          requireCondition(version === result.requested.headroomVersion, "headroom-version", "Installed Headroom metadata differs from canonical requested version");
          result.actual.headroomVersion = version;
          const status = await notification(rpc, resources, "status");
          requireCondition(/Status:\s*online/.test(status) && /Mode:\s*managed by this extension/.test(status) &&
            status.includes(endpoint) && status.includes(join(managed, "venv")), "managed-online", "Extension did not report this managed instance online");
        });
      },
      healthStatus: async () => stage("health-status", "protocol", async () => {
        const status = await notification(rpc, resources, "status");
        const health = await notification(rpc, resources, "health");
        for (const text of [status, health]) requireCondition(/(?:Status:\s*|proxy:\s*)online/.test(text) &&
          new RegExp(`Version:\\s*${result.requested.headroomVersion.replaceAll(".", "\\.")}\\s`).test(text) && text.includes(endpoint),
        "health-status", "Extension status/health did not report the expected online version and endpoint");
        const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(resources.timeout("inspect")), redirect: "error" });
        requireCondition(response.ok, "direct-health", "Managed health endpoint returned a failure");
        const body = await response.json() as Record<string, unknown>;
        requireCondition(body && typeof body === "object" && (body.ready === true || body.status === "healthy") &&
          body.version === result.actual.headroomVersion, "direct-health", "Managed health JSON was not healthy with the installed version");
      }),
      compression: async () => stage("compression", "protocol", async () => {
        for (let i = 0; i < FIXTURE_PROMPTS.length; i++) {
          const reply = fixtureReply(i);
          mock.enqueueAssistant(reply);
          await turn(rpc, resources, FIXTURE_PROMPTS[i], reply);
        }
        const original = (await rpc.command({ type: "get_messages" }, resources.timeout("rpc"))).data as { messages: Array<{ role: string; content: unknown }> };
        const history = original.messages.filter(m => !["system", "developer"].includes(m.role));
        requireCondition(history.length === 12, "fixture-history", "Unexpected fixture history length");
        for (let i = 0; i < 6; i++) requireCondition(history[i * 2].role === "user" && fixtureText(history[i * 2].content) === FIXTURE_PROMPTS[i] &&
          history[i * 2 + 1].role === "assistant" && fixtureText(history[i * 2 + 1].content) === fixtureReply(i), "fixture-history", "Original fixture transcript did not match the fixed sequence");
        const before = parseSavedTokens(await notification(rpc, resources, "status"));
        const requestIndex = mock.requests.length;
        mock.enqueueAssistant(FINAL_REPLY);
        await turn(rpc, resources, TARGET_PROMPT, FINAL_REPLY);
        const after = parseSavedTokens(await notification(rpc, resources, "status"));
        requireCondition(mock.requests.length === requestIndex + 1, "target-request", "Expected exactly one target model request");
        const target = mock.requests[requestIndex];
        requireCondition(target?.model === "gpt-4o", "target-request", "Unexpected target model");
        result.compression = assertTargetCompression(original.messages, target.messages, TARGET_PROMPT, before, after);
      }),
    });
  } catch (error) {
    recordSmokeFailure(result, error, "setup");
    if (owner) {
      try { await owner.cleanup(); result.cleanup.status = "passed"; }
      catch { result.cleanup.status = "failed"; }
    }
  }
  // A failure writing the sanitized report is itself a failed invocation, never print raw errors.
  await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSmoke();
    console.log(JSON.stringify(result));
    if (result.outcome !== "passed") process.exitCode = 1;
  } catch {
    console.error("Smoke result could not be written; raw diagnostics withheld");
    process.exitCode = 1;
  }
}
