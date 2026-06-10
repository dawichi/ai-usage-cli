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

test("renderScreen and serializeSnapshot include recommendation", () => {
  const data = {
    claude: {
      ok: true,
      provider: "Claude",
      primary: { usedPercent: 80, resetsAtText: "later" },
      secondary: { usedPercent: 10, resetsAtText: "later" },
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

  const json = JSON.parse(serializeSnapshot(data));
  assert.equal(json.recommendation, "Prefer Codex right now based on the active window.");
});
