import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStatusText,
  emptyTotals,
  formatDetailedStatus,
  formatPercent,
  percentSaved,
} from "../src/ui.ts";

const theme = {
  fg(color: string, text: string): string {
    return `[${color}]${text}`;
  },
};

test("percent saved uses baseline context tokens", () => {
  assert.equal(percentSaved({ ...emptyTotals(), baselineTokens: 100, savedTokens: 25 }), 25);
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(0.04), "<0.1%");
  assert.equal(formatPercent(9.94), "9.9%");
  assert.equal(formatPercent(18.6), "19%");
});

test("online status includes absolute and percentage savings", () => {
  const text = buildStatusText(theme, "online", {
    calls: 3,
    baselineTokens: 100_000,
    compressedTokens: 87_655,
    savedTokens: 12_345,
  });
  assert.match(text, /Headroom up/);
  assert.match(text, /saved 12,345 tok/);
  assert.match(text, /12%/);
});

test("ready status is shown before the first request", () => {
  const text = buildStatusText(theme, "online", emptyTotals());
  assert.match(text, /Headroom up · ready/);
});

test("offline and disabled states are explicit", () => {
  assert.match(buildStatusText(theme, "offline", emptyTotals()), /Headroom offline/);
  assert.match(buildStatusText(theme, "disabled", emptyTotals()), /Headroom off/);
});

test("detailed status explains the baseline denominator", () => {
  const text = formatDetailedStatus({
    online: true,
    url: "http://127.0.0.1:8788",
    pinnedVersion: "0.42.0",
    version: "0.42.0",
    managed: true,
    adopted: false,
    venv: "/tmp/venv",
    logPath: "/tmp/proxy.log",
    totals: {
      calls: 2,
      baselineTokens: 10_000,
      compressedTokens: 8_000,
      savedTokens: 2_000,
    },
    last: {
      tokensBefore: 5_000,
      tokensAfter: 4_000,
      tokensSaved: 1_000,
      compressionRatio: 0.8,
      transforms: ["router:text:0.8"],
    },
  });

  assert.match(text, /Saved:\s+2,000 tokens \(20% of baseline, 25% of sent\)/);
  assert.match(text, /Transforms: router:text:0.8/);
});
