import type { SessionTotals } from "./types.ts";

export type ProxyUiState = "starting" | "online" | "offline" | "disabled";

export interface ThemeLike {
  fg(color: "success" | "warning" | "error" | "dim" | "muted" | "accent", text: string): string;
}

/** Tokens saved as a share of the baseline (uncompressed) context tokens. */
export function percentSaved(totals: SessionTotals): number {
  if (totals.baselineTokens <= 0) return 0;
  return (totals.savedTokens / totals.baselineTokens) * 100;
}

export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

export function emptyTotals(): SessionTotals {
  return { calls: 0, baselineTokens: 0, compressedTokens: 0, savedTokens: 0 };
}

/**
 * Footer text. Kept short because Pi renders extension statuses on one shared
 * line below the main footer row.
 */
export function buildStatusText(
  theme: ThemeLike,
  state: ProxyUiState,
  totals: SessionTotals,
): string {
  switch (state) {
    case "starting":
      return `${theme.fg("dim", "⏳ Headroom starting")}`;
    case "offline":
      return `${theme.fg("warning", "⚠")}${theme.fg("dim", " Headroom offline")}`;
    case "disabled":
      return `${theme.fg("dim", "○ Headroom off")}`;
    case "online": {
      if (totals.calls === 0) {
        return `${theme.fg("success", "✓")}${theme.fg("dim", " Headroom up · ready")}`;
      }
      // The footer shows the exact saved count. Compact notation hides the
      // absolute number the user asked for; the detailed status explains the
      // percentage denominator.
      const saved = totals.savedTokens.toLocaleString();
      const percent = formatPercent(percentSaved(totals));
      return `${theme.fg("success", "✓")}${theme.fg("dim", ` Headroom up · saved ${saved} tok (${percent})`)}`;
    }
  }
}

export function formatDetailedStatus(input: {
  online: boolean;
  url: string;
  pinnedVersion: string;
  version?: string;
  managed: boolean;
  adopted: boolean;
  venv: string;
  logPath: string;
  totals: SessionTotals;
  last?: {
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    compressionRatio: number;
    transforms: string[];
  };
  lastError?: string;
}): string {
  const t = input.totals;
  const pct = formatPercent(percentSaved(t));
  const sentPct =
    t.compressedTokens > 0 ? (t.savedTokens / t.compressedTokens) * 100 : 0;
  const lines = [
    "Headroom context compression",
    `  Status:   ${input.online ? "online" : "offline"}`,
    `  Proxy:    ${input.url}`,
    `  Version:  ${input.version ?? "unknown"} (pinned ${input.pinnedVersion})`,
    `  Mode:     ${input.adopted ? "adopted existing proxy" : input.managed ? "managed by this extension" : "external"}`,
    `  Venv:     ${input.venv}`,
    `  Log:      ${input.logPath}`,
    "",
    "This session:",
    `  Requests: ${t.calls}`,
    `  Baseline: ${t.baselineTokens.toLocaleString()} tokens`,
    `  Sent:     ${t.compressedTokens.toLocaleString()} tokens`,
    `  Saved:    ${t.savedTokens.toLocaleString()} tokens (${pct} of baseline, ${formatPercent(sentPct)} of sent)`,
  ];

  if (input.last && input.last.tokensBefore > 0) {
    lines.push(
      "",
      "Last request:",
      `  ${input.last.tokensBefore.toLocaleString()} -> ${input.last.tokensAfter.toLocaleString()} tokens`,
      `  Saved: ${input.last.tokensSaved.toLocaleString()} (${formatPercent((1 - input.last.compressionRatio) * 100)})`,
      `  Transforms: ${input.last.transforms.join(", ") || "none"}`,
    );
  }

  if (input.lastError) {
    lines.push("", `Last error: ${input.lastError}`);
  }

  return lines.join("\n");
}
