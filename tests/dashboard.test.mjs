import test from "node:test";
import assert from "node:assert/strict";

import {
  extractCodexRateLimitsFromLines,
  parseArgs,
  parseClaudeUsage,
  renderScreen,
  serializeSnapshot,
} from "../src/dashboard.mjs";

test("parseArgs supports json mode", () => {
  assert.deepEqual(parseArgs(["--once", "--json", "--interval", "30"]), {
    intervalSeconds: 30,
    once: true,
    noClear: true,
    json: true,
  });
});

test("parseArgs makes json mode one-shot even without --once", () => {
  assert.deepEqual(parseArgs(["--json"]), {
    intervalSeconds: 60,
    once: true,
    noClear: true,
    json: true,
  });
});

test("parseClaudeUsage parses current session and week output", () => {
  const output = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 99% used · resets Jun 10 at 2:30pm (Europe/Madrid)",
    "Current week (all models): 15% used · resets Jun 14 at 10pm (Europe/Madrid)",
  ].join("\n");

  assert.deepEqual(parseClaudeUsage(output), {
    ok: true,
    provider: "Claude",
    primary: {
      usedPercent: 99,
      resetsAtText: "Jun 10 at 2:30pm (Europe/Madrid)",
    },
    secondary: {
      usedPercent: 15,
      resetsAtText: "Jun 14 at 10pm (Europe/Madrid)",
    },
    raw: output,
  });
});

test("parseClaudeUsage fails cleanly on changed output", () => {
  const output = "Current session: almost full, check later";
  const result = parseClaudeUsage(output);

  assert.equal(result.ok, false);
  assert.equal(result.provider, "Claude");
  assert.match(result.error, /Could not parse usage line/);
});

test("parseClaudeUsage accepts valid lines without reset text", () => {
  const output = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 0% used",
    "Current week (all models): 15% used · resets Jun 14 at 10pm (Europe/Madrid)",
  ].join("\n");

  assert.deepEqual(parseClaudeUsage(output), {
    ok: true,
    provider: "Claude",
    primary: {
      usedPercent: 0,
      resetsAtText: null,
    },
    secondary: {
      usedPercent: 15,
      resetsAtText: "Jun 14 at 10pm (Europe/Madrid)",
    },
    raw: output,
  });
});

test("extractCodexRateLimitsFromLines reads the newest rate_limits event", () => {
  const lines = [
    "{\"timestamp\":\"2026-06-10T12:00:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}",
    "{\"timestamp\":\"2026-06-10T12:13:37.478Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"rate_limits\":{\"primary\":{\"used_percent\":32,\"window_minutes\":300,\"resets_at\":1781106674},\"secondary\":{\"used_percent\":5,\"window_minutes\":10080,\"resets_at\":1781693474},\"plan_type\":\"plus\"}}}",
  ];

  const result = extractCodexRateLimitsFromLines(lines);

  assert.equal(result?.ok, true);
  assert.equal(result?.provider, "Codex");
  assert.equal(result?.primary?.usedPercent, 32);
  assert.equal(result?.secondary?.usedPercent, 5);
  assert.equal(result?.planType, "plus");
});

test("extractCodexRateLimitsFromLines marks a window as stale once its reset time has passed", () => {
  const lines = [
    JSON.stringify({
      timestamp: "2020-01-01T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 3, window_minutes: 300, resets_at: 1000000000 },
          secondary: { used_percent: 23, window_minutes: 10080, resets_at: 9999999999 },
          plan_type: "plus",
        },
      },
    }),
  ];

  const result = extractCodexRateLimitsFromLines(lines);

  assert.equal(result?.observedAt, "2020-01-01T00:00:00.000Z");
  assert.equal(result?.primary?.isStale, true);
  assert.match(result?.primary?.resetsAtText, /passed, window has likely reset/);
  assert.equal(result?.secondary?.isStale, false);
});

test("renderScreen notes stale Codex data instead of a misleading past reset time", () => {
  const data = {
    claude: {
      ok: true,
      provider: "Claude",
      primary: { usedPercent: 50, resetsAtText: "later" },
      secondary: { usedPercent: 10, resetsAtText: "later" },
    },
    codex: {
      ok: true,
      provider: "Codex",
      primary: {
        usedPercent: 3,
        resetsAtText: "Jun 11, 2026, 02:13 PM (passed, window has likely reset)",
        windowMinutes: 300,
        isStale: true,
      },
      secondary: { usedPercent: 23, resetsAtText: "later", windowMinutes: 10080, isStale: false },
      planType: "plus",
      observedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    },
    options: {
      intervalSeconds: 60,
    },
  };

  const screen = renderScreen(data);

  assert.match(screen, /passed, window has likely reset/);
  assert.match(screen, /note: {3}active window reset time has passed, data is 5h old — run codex to refresh/);
});

test("renderScreen renders usage as progress bars", () => {
  const data = {
    claude: {
      ok: true,
      provider: "Claude",
      primary: { usedPercent: 0, resetsAtText: "later" },
      secondary: { usedPercent: 50, resetsAtText: "later" },
    },
    codex: {
      ok: true,
      provider: "Codex",
      primary: { usedPercent: 100, resetsAtText: "later", windowMinutes: 300 },
      secondary: null,
      planType: "plus",
    },
    options: {
      intervalSeconds: 60,
    },
  };

  const screen = renderScreen(data);

  assert.match(screen, /active: \[░{12}\] 0% used/);
  assert.match(screen, /long: {3}\[█{6}░{6}\] 50% used/);
  assert.match(screen, /active: \[█{12}\] 100% used/);
});

test("renderScreen collapses multi-line provider errors onto a single line", () => {
  const data = {
    claude: {
      ok: false,
      provider: "Claude",
      error:
        "Command failed: claude -p /usage\nWarning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n",
    },
    codex: {
      ok: true,
      provider: "Codex",
      primary: { usedPercent: 60, resetsAtText: "later", windowMinutes: 300 },
      secondary: { usedPercent: 40, resetsAtText: "later", windowMinutes: 10080 },
      planType: "plus",
    },
    options: {
      intervalSeconds: 60,
    },
  };

  const screen = renderScreen(data);

  assert.match(
    screen,
    /error: Command failed: claude -p \/usage Warning: no stdin data received in 3s, proceeding without it\./,
  );
  assert.equal(screen.includes("\n\nWarning"), false);
});

test("renderScreen and serializeSnapshot include recommendation", () => {
  const data = {
    claude: {
      ok: true,
      provider: "Claude",
      primary: { usedPercent: 80, resetsAtText: "later" },
      secondary: { usedPercent: 10, resetsAtText: "later" },
      sourceDescription: "recent Claude transcript from Jun 10, 2026, 10:06 PM",
    },
    codex: {
      ok: true,
      provider: "Codex",
      primary: { usedPercent: 30, resetsAtText: "later", windowMinutes: 300 },
      secondary: { usedPercent: 5, resetsAtText: "later", windowMinutes: 10080 },
      planType: "plus",
    },
    options: {
      intervalSeconds: 60,
    },
  };

  assert.match(renderScreen(data), /Prefer Codex right now/);
  assert.match(renderScreen(data), /source: recent Claude transcript/);

  const json = JSON.parse(serializeSnapshot(data));
  assert.equal(json.recommendation, "Prefer Codex right now based on the active window.");
});
