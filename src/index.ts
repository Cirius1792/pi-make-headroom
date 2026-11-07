/**
 * pi-make-headroom
 *
 * Transparent context compression for Pi using Headroom, with a managed and
 * pinned Python virtual environment. The extension itself has no npm runtime
 * dependencies: it talks to Headroom's local proxy over HTTP using `fetch`.
 *
 * Flow:
 *   1. session_start: find/create ~/.pi/agent/make-headroom/venv, install
 *      headroom-ai[proxy]==<pin>, start the proxy, wait for /health.
 *   2. context: convert Pi messages to OpenAI format, call /v1/compress,
 *      align the result back onto the original messages, and return them.
 *   3. footer status: show "Headroom up" plus tokens saved and the share of
 *      baseline context tokens that were avoided.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";

import { HeadroomClient, HeadroomRequestError } from "./headroom-client.ts";
import { openAIToPi, piToOpenAI } from "./format-bridge.ts";
import { ProxyManager } from "./proxy-manager.ts";
import {
  buildStatusText,
  emptyTotals,
  formatDetailedStatus,
  type ProxyUiState,
} from "./ui.ts";
import type { CompressResult, LastCompression, SessionTotals } from "./types.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_VERSION = "0.42.0";
const DEFAULT_EXTRAS = "proxy";
const DEFAULT_PORT = 8788;
const DEFAULT_HOST = "127.0.0.1";

interface Config {
  home: string;
  version: string;
  extras: string;
  port: number;
  host: string;
  python?: string;
  compressTimeoutMs: number;
  installTimeoutMs: number;
  startTimeoutMs: number;
  url?: string;
}

interface SetupResult {
  ok: boolean;
  installed?: boolean;
  manual: boolean;
  detail?: string;
}

interface FileConfig {
  version?: unknown;
  extras?: unknown;
  port?: unknown;
  host?: unknown;
  python?: unknown;
  compressTimeoutMs?: unknown;
  installTimeoutMs?: unknown;
  startTimeoutMs?: unknown;
  url?: unknown;
}

function defaultHome(): string {
  return join(getAgentDir(), "make-headroom");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function resolveHome(value: string): string {
  const expanded = expandHome(value || defaultHome());
  // Reinstall deletes <home>/venv. Never allow a filesystem root there.
  if (expanded === "/" || /^[A-Za-z]:[\\/]?$/.test(expanded)) {
    return defaultHome();
  }
  return expanded;
}

function loadConfig(): Config {
  const home = resolveHome(cleanString(process.env.HEADROOM_HOME) || defaultHome());

  let file: FileConfig = {};
  try {
    file = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as FileConfig;
  } catch {
    // No config file yet.
  }

  const preferredPython = cleanString(process.env.HEADROOM_PYTHON) ?? cleanString(file.python);

  const config: Config = {
    home,
    version: validVersion(cleanString(process.env.HEADROOM_VERSION) ?? cleanString(file.version)) ?? DEFAULT_VERSION,
    extras: validExtras(cleanString(process.env.HEADROOM_EXTRAS) ?? cleanString(file.extras)) ?? DEFAULT_EXTRAS,
    port: validPort(process.env.HEADROOM_PORT ?? file.port) ?? DEFAULT_PORT,
    host: cleanString(process.env.HEADROOM_HOST) ?? cleanString(file.host) ?? DEFAULT_HOST,
    python: preferredPython ? expandHome(preferredPython) : undefined,
    compressTimeoutMs:
      validTimeout(process.env.HEADROOM_COMPRESS_TIMEOUT_MS ?? file.compressTimeoutMs) ?? 30_000,
    installTimeoutMs:
      validTimeout(process.env.HEADROOM_INSTALL_TIMEOUT_MS ?? file.installTimeoutMs) ?? 15 * 60_000,
    startTimeoutMs:
      validTimeout(process.env.HEADROOM_START_TIMEOUT_MS ?? file.startTimeoutMs) ?? 90_000,
    url: validUrl(cleanString(process.env.HEADROOM_URL) ?? cleanString(file.url)),
  };

  return config;
}

function ensureConfigFile(config: Config): void {
  try {
    const path = join(config.home, "config.json");
    if (existsSync(path)) return;
    mkdirSync(config.home, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          _comment:
            "pi-make-headroom configuration. Environment variables override these values.",
          version: DEFAULT_VERSION,
          extras: DEFAULT_EXTRAS,
          port: DEFAULT_PORT,
          host: DEFAULT_HOST,
        },
        null,
        2,
      ) + "\n",
    );
  } catch {
    // Configuration is optional; the defaults still work.
  }
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[0-9][0-9A-Za-z.+~-]*$/.test(value) ? value : undefined;
}

function validExtras(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "") return "";
  return /^[a-z0-9_,.-]+$/.test(value) ? value : undefined;
}

function validPort(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) return undefined;
  return n;
}

function validTimeout(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1_000 || n > 3_600_000) return undefined;
  return Math.floor(n);
}

function validUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? value.replace(/\/+$/, "") : undefined;
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function headroomExtension(pi: ExtensionAPI): void {
  let config = loadConfig();
  let manager: ProxyManager | null = null;
  let client: HeadroomClient | null = null;
  let proxyState: ProxyUiState = "offline";
  let enabled = !envFlag("HEADROOM_DISABLED");
  let totals: SessionTotals = emptyTotals();
  let lastStats: LastCompression | undefined;
  let proxyWarningShown = false;
  let restartAttempted = false;
  let mappingWarningShown = false;
  let oldExtensionWarned = false;
  let sessionGeneration = 0;
  let setupAttempt = 0;
  let setupPromise: Promise<SetupResult> | null = null;

  const authKey = (): string | undefined =>
    cleanString(process.env.HEADROOM_PROXY_TOKEN) ?? cleanString(process.env.HEADROOM_API_KEY);

  function setStatus(ctx: ExtensionContext | ExtensionCommandContext, message?: string): void {
    if (!ctx.hasUI) return;
    const text = message
      ? ctx.ui.theme.fg("dim", `⏳ ${message}`)
      : buildStatusText(ctx.ui.theme, proxyState, totals);
    ctx.ui.setStatus("headroom", text);
  }

  function notify(
    ctx: ExtensionContext | ExtensionCommandContext,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ): void {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }

  function makeClient(mgr: ProxyManager | null = manager): HeadroomClient | null {
    if (config.url) {
      return new HeadroomClient({
        baseUrl: config.url,
        apiKey: authKey(),
        timeoutMs: config.compressTimeoutMs,
      });
    }
    if (mgr) {
      return new HeadroomClient({
        baseUrl: mgr.baseUrl,
        apiKey: authKey(),
        timeoutMs: config.compressTimeoutMs,
      });
    }
    return null;
  }

  /**
   * Start (or join) the setup task.
   *
   * `generation` and `attempt` are checked by callers so a result from an old
   * session or an old manual action cannot overwrite newer state.
   */
  async function startProxy(
    ctx: ExtensionContext | ExtensionCommandContext,
    onProgress?: (message: string) => void,
    generation?: number,
  ): Promise<SetupResult> {
    if (setupPromise) return setupPromise;

    let promise: Promise<SetupResult>;
    promise = doStartProxy(ctx, onProgress, generation).finally(() => {
      if (setupPromise === promise) setupPromise = null;
    });
    setupPromise = promise;
    return promise;
  }

  async function doStartProxy(
    ctx: ExtensionContext | ExtensionCommandContext,
    onProgress?: (message: string) => void,
    generation?: number,
  ): Promise<SetupResult> {
    if (generation !== undefined && generation !== sessionGeneration) {
      return { ok: false, manual: false, detail: "Headroom setup cancelled" };
    }

    if (config.url) {
      client = makeClient();
      const info = await client?.health(5_000);
      if (generation !== undefined && generation !== sessionGeneration) {
        client = null;
        return { ok: false, manual: true, detail: "Headroom setup cancelled" };
      }
      return { ok: info !== null, manual: true };
    }

    if (!manager) {
      manager = new ProxyManager({
        version: config.version,
        extras: config.extras,
        home: config.home,
        host: config.host,
        port: config.port,
        python: config.python,
        installTimeoutMs: config.installTimeoutMs,
        startTimeoutMs: config.startTimeoutMs,
      });
    }

    const mgr = manager;
    const progress = onProgress ?? ((message: string) => setStatus(ctx, message));
    const result = await mgr.ensureRunning(progress);

    if (generation !== undefined && generation !== sessionGeneration) {
      // The session changed while setup was running. Do not publish this
      // result and do not leave a proxy behind. If a new session already
      // replaced the manager/client, leave them alone.
      await mgr.stop().catch(() => undefined);
      if (manager === mgr) {
        manager = null;
        client = null;
      }
      return { ok: false, manual: false, detail: "Headroom setup cancelled" };
    }

    client = result.ok ? makeClient(mgr) : null;
    return {
      ok: result.ok,
      installed: result.installed,
      manual: false,
      detail: result.detail,
    };
  }

  /**
   * Background setup used by session_start and /headroom on. The agent is
   * usable immediately; context compression turns on when this completes.
   */
  async function beginSetup(
    ctx: ExtensionContext | ExtensionCommandContext,
    generation: number,
    attempt: number,
  ): Promise<void> {
    const isCurrent = () => generation === sessionGeneration && attempt === setupAttempt;

    try {
      const result = await startProxy(
        ctx,
        (message) => {
          if (isCurrent()) setStatus(ctx, message);
        },
        generation,
      );

      if (!isCurrent()) return;

      if (!result.ok && result.detail === "Headroom setup cancelled") {
        proxyState = enabled ? "offline" : "disabled";
        setStatus(ctx);
        return;
      }

      if (result.ok) {
        proxyState = "online";
        setStatus(ctx);
        if (result.installed) {
          notify(
            ctx,
            `Headroom ${config.version} was installed in ${config.home}/venv and is now running.`,
            "info",
          );
        }
      } else {
        proxyState = "offline";
        setStatus(ctx);
        const detail = manager?.lastErrorText ?? result.detail;
        notify(
          ctx,
          `Headroom could not start.${detail ? `\n${detail}` : ""}\nSee ${config.home}/proxy.log for details.\nRun /headroom reinstall to retry the installation.`,
          "warning",
        );
      }
    } catch (error) {
      if (!isCurrent()) return;
      if ((error as { name?: string } | null)?.name === "SetupCancelledError") {
        proxyState = enabled ? "offline" : "disabled";
        setStatus(ctx);
        return;
      }
      proxyState = "offline";
      client = null;
      setStatus(ctx);
      const message = error instanceof Error ? error.message : String(error);
      notify(ctx, `Headroom setup failed: ${message}`, "error");
    }
  }

  function maybeWarnOldExtension(
    ctx: ExtensionContext | ExtensionCommandContext,
  ): void {
    if (oldExtensionWarned) return;
    try {
      const settings = typeof pi.getSettings === "function" ? pi.getSettings() : undefined;
      const packages = (settings as { packages?: unknown })?.packages;
      if (!Array.isArray(packages)) return;

      for (const entry of packages) {
        const source =
          typeof entry === "string"
            ? entry
            : typeof entry === "object" && entry !== null && "source" in entry
              ? String((entry as { source?: unknown }).source ?? "")
              : "";
        if (
          source.includes("pi-headroom") &&
          !source.includes("pi-make-headroom") &&
          !source.includes("pi-headroom-mk2")
        ) {
          oldExtensionWarned = true;
          notify(
            ctx,
            `${source} is also installed. Remove it with \`pi remove ${source}\` to avoid compressing twice.`,
            "warning",
          );
          return;
        }
      }
    } catch {
      // Settings introspection is best effort.
    }
  }

  // ─── Session start ────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    const generation = ++sessionGeneration;
    const attempt = ++setupAttempt;

    // If a previous session's background setup is still running (for example a
    // session replacement that did not wait for shutdown), invalidate and stop
    // it before starting the new one.
    if (setupPromise) {
      const previousManager = manager;
      manager = null;
      client = null;
      setupPromise = null;
      void previousManager?.stop().catch(() => undefined);
    }

    config = loadConfig();
    enabled = !envFlag("HEADROOM_DISABLED");
    totals = emptyTotals();
    lastStats = undefined;
    proxyWarningShown = false;
    restartAttempted = false;
    mappingWarningShown = false;
    oldExtensionWarned = false;

    ensureConfigFile(config);

    if (!enabled) {
      proxyState = "disabled";
      setStatus(ctx);
      return;
    }

    maybeWarnOldExtension(ctx);

    // Do not await setup. The agent is usable immediately; compression turns
    // on when the background install/start finishes.
    proxyState = "starting";
    setStatus(
      ctx,
      config.url
        ? "Checking Headroom proxy in the background…"
        : "Preparing Headroom in the background…",
    );
    void beginSetup(ctx, generation, attempt);
  });

  // ─── Session shutdown ─────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    sessionGeneration++;
    setupAttempt++;

    const mgr = manager;
    manager = null;
    client = null;
    setupPromise = null;
    proxyState = "offline";

    try {
      await mgr?.stop();
    } catch {
      // Best effort.
    }
  });

  // ─── Core: compress before each model call ────────────────────────────

  pi.on("context", async (event, ctx) => {
    if (!enabled || proxyState !== "online" || !client) return;

    const llmMessages = convertToLlm(event.messages);
    if (llmMessages.length === 0) return;

    const pairs = piToOpenAI(llmMessages);
    if (pairs.length === 0) return;

    const model = ctx.model?.id ?? "gpt-4o";

    let result: CompressResult;
    try {
      result = await client.compress(
        pairs.map((pair) => pair.openai),
        model,
      );
    } catch (error) {
      await handleCompressionError(error, ctx);
      return;
    }

    if (result.tokensSaved <= 0) {
      totals.calls++;
      totals.baselineTokens += Math.max(0, result.tokensBefore);
      totals.compressedTokens += Math.max(0, result.tokensAfter);
      lastStats = toLastStats(result);
      setStatus(ctx);
      return;
    }

    const compressed = openAIToPi(result.messages, pairs);
    if (!compressed) {
      if (!mappingWarningShown) {
        mappingWarningShown = true;
        notify(
          ctx,
          "Headroom returned a message layout that could not be aligned with the transcript. Keeping the original messages for this request.",
          "warning",
        );
      }
      setStatus(ctx);
      return;
    }

    totals.calls++;
    totals.baselineTokens += Math.max(0, result.tokensBefore);
    totals.compressedTokens += Math.max(0, result.tokensAfter);
    totals.savedTokens += Math.max(0, result.tokensSaved);
    lastStats = toLastStats(result);
    setStatus(ctx);

    return { messages: compressed as never };
  });

  async function handleCompressionError(
    error: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof HeadroomRequestError ? error.kind : "unknown";
    const connectionProblem = kind === "connection" || kind === "timeout";

    if (connectionProblem) {
      proxyState = "offline";
      setStatus(ctx);
      if (!proxyWarningShown) {
        proxyWarningShown = true;
        notify(
          ctx,
          `Headroom is unavailable: ${message}\nContext compression is paused for this request.`,
          "warning",
        );
      }

      if (manager && !restartAttempted) {
        restartAttempted = true;
        setStatus(ctx, "Restarting Headroom…");
        const recovered = await manager.tryRestart((status) => setStatus(ctx, status));
        if (recovered) {
          client = makeClient();
          proxyState = "online";
          proxyWarningShown = false;
          setStatus(ctx);
        } else {
          proxyState = "offline";
          setStatus(ctx);
        }
      }
      return;
    }

    // The proxy answered, but the request failed (HTTP error, bad JSON, ...).
    // Keep the proxy marked online: the next request may succeed.
    if (!proxyWarningShown) {
      proxyWarningShown = true;
      notify(ctx, `Headroom compression skipped this request: ${message}`, "warning");
    }
    setStatus(ctx);
  }

  // ─── /headroom ────────────────────────────────────────────────────────

  pi.registerCommand("headroom", {
    description:
      "Headroom compression. Usage: /headroom [status|on|off|restart|stop|reinstall|health]",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "" || arg === "status") {
        await showStatus(ctx);
        return;
      }

      if (arg === "on") {
        enabled = true;
        proxyWarningShown = false;
        restartAttempted = false;

        if (proxyState === "online" && client) {
          setStatus(ctx);
          notify(ctx, "Headroom compression is already enabled and online.", "info");
          return;
        }

        if (setupPromise) {
          notify(
            ctx,
            "Headroom setup is already running in the background. If you just turned it off, wait a moment and run /headroom on again.",
            "info",
          );
          return;
        }

        const attempt = ++setupAttempt;
        proxyState = "starting";
        setStatus(ctx, "Preparing Headroom in the background…");
        notify(ctx, "Headroom compression enabled; setup is running in the background.", "info");
        void beginSetup(ctx, sessionGeneration, attempt);
        return;
      }

      if (arg === "off") {
        enabled = false;
        // Invalidate a background setup. If it is still installing/starting,
        // stop it so a proxy cannot come online after the user turned it off.
        setupAttempt++;
        proxyState = "disabled";
        setStatus(ctx);
        const wasSettingUp = setupPromise !== null;
        if (setupPromise) {
          void manager?.stop().catch(() => undefined);
        }
        notify(
          ctx,
          wasSettingUp
            ? "Headroom compression disabled and the in-flight setup was cancelled."
            : "Headroom compression disabled. The proxy stays warm; /headroom stop also stops it.",
          "info",
        );
        return;
      }

      if (arg === "restart") {
        if (!manager && !config.url) {
          notify(ctx, "Headroom is not managed by this extension; nothing to restart.", "warning");
          return;
        }
        setupAttempt++;
        proxyState = "starting";
        setStatus(ctx, "Restarting Headroom…");
        try {
          if (manager) {
            const mgr = manager;
            const result = await mgr.restart((status) => setStatus(ctx, status));
            proxyState = result.ok ? "online" : "offline";
            client = result.ok ? makeClient(mgr) : null;
          } else {
            const result = await startProxy(ctx);
            proxyState = result.ok ? "online" : "offline";
          }
          setStatus(ctx);
          if (proxyState === "online") {
            proxyWarningShown = false;
            restartAttempted = false;
          }
          notify(
            ctx,
            proxyState === "online" ? "Headroom restarted and is online." : "Headroom restart failed.",
            proxyState === "online" ? "info" : "warning",
          );
        } catch (error) {
          proxyState = "offline";
          setStatus(ctx);
          notify(ctx, `Restart failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (arg === "stop") {
        setupAttempt++;
        try {
          await manager?.stop(true);
        } catch {
          // Best effort.
        }
        client = null;
        proxyState = enabled ? "offline" : "disabled";
        setStatus(ctx);
        notify(ctx, "Headroom proxy stopped.", "info");
        return;
      }

      if (arg === "reinstall") {
        if (!manager) {
          notify(ctx, "Reinstall is only available when this extension manages the proxy.", "warning");
          return;
        }
        setupAttempt++;
        proxyState = "starting";
        setStatus(ctx, "Reinstalling Headroom…");
        try {
          const mgr = manager;
          const result = await mgr.reinstall((status) => setStatus(ctx, status));
          proxyState = result.ok ? "online" : "offline";
          client = result.ok ? makeClient(mgr) : null;
          setStatus(ctx);
          notify(
            ctx,
            result.ok
              ? `Headroom ${config.version} reinstalled and running.`
              : `Reinstall failed.${manager.lastErrorText ? `\n${manager.lastErrorText}` : ""}`,
            result.ok ? "info" : "error",
          );
        } catch (error) {
          proxyState = "offline";
          client = null;
          setStatus(ctx);
          notify(ctx, `Reinstall failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (arg === "health") {
        await showHealth(ctx);
        return;
      }

      notify(
        ctx,
        "Usage: /headroom [status|on|off|restart|stop|reinstall|health]",
        "info",
      );
    },
  });

  pi.registerCommand("headroom-health", {
    description: "Check the Headroom proxy and show diagnostics",
    handler: async (_args, ctx) => {
      await showHealth(ctx);
    },
  });

  async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
    const status = manager ? await manager.status() : null;
    const health = client ? await client.health(3_000) : manager ? await manager.health() : null;
    const online = health !== null;
    const url = config.url ?? manager?.baseUrl ?? `http://${config.host}:${config.port}`;

    const text = formatDetailedStatus({
      online,
      url,
      pinnedVersion: config.version,
      version: status?.version ?? health?.version,
      managed: status?.managed ?? false,
      adopted: status?.adopted ?? false,
      venv: status?.venv ?? join(config.home, "venv"),
      logPath: status?.proxyLog ?? join(config.home, "proxy.log"),
      totals,
      last: lastStats,
      lastError: status?.lastError ?? manager?.lastErrorText,
    });

    const prefix = setupPromise ? "Headroom setup is running in the background.\n\n" : "";
    notify(ctx, prefix + text, online ? "info" : "warning");
  }

  async function showHealth(ctx: ExtensionCommandContext): Promise<void> {
    if (!client) {
      client = makeClient();
    }

    const health = client ? await client.health(5_000) : null;
    const status = manager ? await manager.status() : null;
    const url = config.url ?? manager?.baseUrl ?? `http://${config.host}:${config.port}`;

    if (health) {
      proxyState = enabled ? "online" : proxyState;
      setStatus(ctx);
      notify(
        ctx,
        [
          ...(setupPromise ? ["Headroom setup is still running in the background.", ""] : []),
          "Headroom proxy: online",
          `  URL:     ${url}`,
          `  Version: ${health.version ?? status?.version ?? "unknown"} (pinned ${config.version})`,
          `  Ready:   ${health.ready ? "yes" : "no"}`,
          `  Venv:    ${status?.venv ?? join(config.home, "venv")}`,
          `  Log:     ${status?.proxyLog ?? join(config.home, "proxy.log")}`,
        ].join("\n"),
        "info",
      );
      return;
    }

    if (enabled) proxyState = "offline";
    setStatus(ctx);
    notify(
      ctx,
      [
        ...(setupPromise ? ["Headroom setup is still running in the background.", ""] : []),
        "Headroom proxy: offline",
        `  URL:     ${url}`,
        `  Venv:    ${status?.venv ?? join(config.home, "venv")}`,
        `  Log:     ${status?.proxyLog ?? join(config.home, "proxy.log")}`,
        status?.lastError ? `  Error:   ${status.lastError}` : "",
        "",
        "Try /headroom on, or /headroom reinstall to rebuild the venv.",
      ]
        .filter(Boolean)
        .join("\n"),
      "error",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLastStats(result: {
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  compressionRatio: number;
  transformsApplied: string[];
}): LastCompression {
  return {
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    tokensSaved: result.tokensSaved,
    compressionRatio: result.compressionRatio,
    transforms: result.transformsApplied,
    at: Date.now(),
  };
}
