import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_SECONDS = 60;
const RATE_LIMIT_SEARCH_FILE_LIMIT = 30;
const RATE_LIMIT_TAIL_BYTES = 128 * 1024;
const CLAUDE_HISTORY_MAX_AGE_MS = 30 * 60 * 1000;

export function parseArgs(args) {
  const options = {
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    once: false,
    noClear: false,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--once") {
      options.once = true;
      continue;
    }

    if (arg === "--no-clear") {
      options.noClear = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      options.once = true;
      options.noClear = true;
      continue;
    }

    if (arg === "--interval") {
      const rawValue = args[index + 1];
      const parsedValue = Number(rawValue);

      if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        throw new Error(`Invalid value for --interval: ${rawValue}`);
      }

      options.intervalSeconds = parsedValue;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearTerminal() {
  process.stdout.write("\x1Bc");
}

function color(text, code) {
  if (!process.stdout.isTTY) {
    return text;
  }

  return `\u001b[${code}m${text}\u001b[0m`;
}

function severityColor(usedPercent) {
  if (usedPercent >= 90) {
    return 31;
  }

  if (usedPercent >= 70) {
    return 33;
  }

  return 32;
}

function formatPercent(value) {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `${Math.round(value)}%`;
}

const ERROR_MESSAGE_MAX_LENGTH = 160;

function formatErrorMessage(error) {
  if (!error) {
    return "unknown error";
  }

  const collapsed = error
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

  if (collapsed.length <= ERROR_MESSAGE_MAX_LENGTH) {
    return collapsed;
  }

  return `${collapsed.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`;
}

const BAR_WIDTH = 12;

function formatBar(usedPercent) {
  if (usedPercent == null || Number.isNaN(usedPercent)) {
    return `[${" ".repeat(BAR_WIDTH)}]`;
  }

  const clamped = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;

  return `[${color(bar, severityColor(usedPercent))}]`;
}

function formatWindow(window) {
  if (!window) {
    return "n/a";
  }

  const bar = formatBar(window.usedPercent);
  const used = formatPercent(window.usedPercent);
  const remaining =
    window.usedPercent == null ? "n/a" : `${Math.max(0, 100 - Math.round(window.usedPercent))}%`;
  const reset = window.resetsAtText ?? "unknown";
  const duration = window.windowMinutes == null ? "unknown" : `${window.windowMinutes}m`;
  return `${bar} ${used} used | ${remaining} left | resets ${reset} | window ${duration}`;
}

function formatAbsoluteDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatRelative(targetDate) {
  const diffMs = targetDate.getTime() - Date.now();

  if (!Number.isFinite(diffMs)) {
    return "";
  }

  const totalMinutes = Math.round(diffMs / 60000);
  const absMinutes = Math.abs(totalMinutes);
  const days = Math.floor(absMinutes / 1440);
  const hours = Math.floor((absMinutes % 1440) / 60);
  const minutes = absMinutes % 60;

  const parts = [];

  if (days) {
    parts.push(`${days}d`);
  }

  if (hours) {
    parts.push(`${hours}h`);
  }

  if (minutes || parts.length === 0) {
    parts.push(`${minutes}m`);
  }

  return totalMinutes >= 0 ? `in ${parts.join(" ")}` : `${parts.join(" ")} ago`;
}

function withResetText(window) {
  if (!window?.resetsAtEpochSeconds) {
    return window;
  }

  const resetDate = new Date(window.resetsAtEpochSeconds * 1000);
  const isStale = resetDate.getTime() < Date.now();

  return {
    ...window,
    isStale,
    resetsAtText: isStale
      ? `${formatAbsoluteDate(resetDate)} (passed, window has likely reset)`
      : `${formatAbsoluteDate(resetDate)} (${formatRelative(resetDate)})`,
  };
}

function formatSnapshotAge(observedAtIso) {
  if (!observedAtIso) {
    return null;
  }

  const observedAt = new Date(observedAtIso);

  if (!Number.isFinite(observedAt.getTime())) {
    return null;
  }

  return formatRelative(observedAt).replace(/ ago$/, "");
}

async function runCommand(command, commandArgs) {
  try {
    const { stdout } = await execFileAsync(command, commandArgs, {
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    return stdout.trim();
  } catch (error) {
    return {
      error: error.message,
    };
  }
}

function normalizeClaudeLine(line, prefixPattern) {
  const match = line.match(prefixPattern);

  if (!match) {
    return null;
  }

  const usedMatch = line.match(/(\d+(?:\.\d+)?)%\s*used/i);
  const resetMatch = line.match(/resets?\s+(.+)$/i);

  if (!usedMatch) {
    return {
      ok: false,
      raw: line,
      error: `Could not parse usage line: ${line}`,
    };
  }

  return {
    ok: true,
    usedPercent: Number(usedMatch[1]),
    resetsAtText: resetMatch?.[1] ?? null,
  };
}

export function parseClaudeUsage(output) {
  if (!output || typeof output !== "string") {
    return {
      ok: false,
      provider: "Claude",
      error: "No output from Claude.",
    };
  }

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sessionLine = lines.find((line) => /^current session:/i.test(line));
  const weekLine = lines.find((line) => /^current week\b/i.test(line));

  if (!sessionLine && !weekLine) {
    return {
      ok: false,
      provider: "Claude",
      error: `Unexpected Claude output: ${output}`,
    };
  }

  const primary = sessionLine
    ? normalizeClaudeLine(sessionLine, /^current session:/i)
    : null;
  const secondary = weekLine
    ? normalizeClaudeLine(weekLine, /^current week\b/i)
    : null;

  if ((primary && !primary.ok) || (secondary && !secondary.ok)) {
    return {
      ok: false,
      provider: "Claude",
      error: primary?.error || secondary?.error || "Could not parse Claude usage output.",
      raw: output,
    };
  }

  return {
    ok: true,
    provider: "Claude",
    primary: primary
      ? { usedPercent: primary.usedPercent, resetsAtText: primary.resetsAtText }
      : null,
    secondary: secondary
      ? { usedPercent: secondary.usedPercent, resetsAtText: secondary.resetsAtText }
      : null,
    raw: output,
  };
}

function withClaudeSource(result, observedAt) {
  return {
    ...result,
    observedAt: observedAt?.toISOString?.() ?? null,
    sourceDescription: observedAt
      ? `recent Claude transcript from ${formatAbsoluteDate(observedAt)}`
      : "recent Claude transcript",
  };
}

async function findRecentFilesByMtime(rootDir, limit = RATE_LIMIT_SEARCH_FILE_LIMIT) {
  const results = [];
  let projectDirs;

  try {
    projectDirs = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) {
      continue;
    }

    const projectPath = path.join(rootDir, projectDir.name);
    let entries;

    try {
      entries = await fs.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(projectPath, entry.name);

      try {
        const stats = await fs.stat(filePath);
        results.push({
          filePath,
          mtimeMs: stats.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }

  results.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return results.slice(0, limit).map((entry) => entry.filePath);
}

function extractLocalCommandStdout(content) {
  const match = content?.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i);
  return match?.[1]?.trim() ?? null;
}

async function getClaudeUsageFromHistory() {
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
  const files = await findRecentFilesByMtime(claudeProjectsDir);

  for (const filePath of files) {
    let lines;

    try {
      lines = await readTailLines(filePath);
    } catch {
      continue;
    }

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let parsedLine;

      try {
        parsedLine = JSON.parse(lines[index]);
      } catch {
        continue;
      }

      if (parsedLine?.type !== "system" || parsedLine?.subtype !== "local_command") {
        continue;
      }

      const stdout = extractLocalCommandStdout(parsedLine.content);

      if (!stdout || !/^You are currently using your subscription/i.test(stdout)) {
        continue;
      }

      const parsedUsage = parseClaudeUsage(stdout);

      if (!parsedUsage.ok) {
        continue;
      }

      const observedAt = parsedLine.timestamp ? new Date(parsedLine.timestamp) : null;

      if (
        observedAt &&
        Number.isFinite(observedAt.getTime()) &&
        Date.now() - observedAt.getTime() > CLAUDE_HISTORY_MAX_AGE_MS
      ) {
        continue;
      }

      return withClaudeSource(parsedUsage, observedAt);
    }
  }

  return null;
}

export async function getClaudeUsage() {
  const claudeCommand = process.env.CLAUDE_CMD || "claude";
  const output = await runCommand(claudeCommand, ["-p", "/usage"]);

  if (typeof output !== "string") {
    const fallback = await getClaudeUsageFromHistory();

    if (fallback) {
      return fallback;
    }

    return {
      ok: false,
      provider: "Claude",
      error: output.error,
    };
  }

  const parsed = parseClaudeUsage(output);

  if (parsed.ok) {
    return parsed;
  }

  const fallback = await getClaudeUsageFromHistory();

  if (fallback) {
    return fallback;
  }

  return parsed;
}

function normalizeCodexWindow(window) {
  if (!window) {
    return null;
  }

  return withResetText({
    usedPercent: window.used_percent,
    windowMinutes: window.window_minutes,
    resetsAtEpochSeconds: window.resets_at,
  });
}

async function listDirNames(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function findRecentJsonlFiles(rootDir, limit = RATE_LIMIT_SEARCH_FILE_LIMIT) {
  const years = (await listDirNames(rootDir)).sort().reverse();
  const results = [];

  for (const year of years) {
    const yearDir = path.join(rootDir, year);
    const months = (await listDirNames(yearDir)).sort().reverse();

    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      const days = (await listDirNames(monthDir)).sort().reverse();

      for (const day of days) {
        const dayDir = path.join(monthDir, day);
        let entries;

        try {
          entries = await fs.readdir(dayDir, { withFileTypes: true });
        } catch {
          continue;
        }

        const files = entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => path.join(dayDir, entry.name))
          .sort()
          .reverse();

        results.push(...files);

        if (results.length >= limit) {
          return results.slice(0, limit);
        }
      }
    }
  }

  return results.slice(0, limit);
}

async function readTailLines(filePath, maxBytes = RATE_LIMIT_TAIL_BYTES) {
  const handle = await fs.open(filePath, "r");

  try {
    const stats = await handle.stat();
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);

    await handle.read(buffer, 0, length, start);

    return buffer
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } finally {
    await handle.close();
  }
}

export function extractCodexRateLimitsFromLines(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed;

    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      continue;
    }

    const rateLimits = parsed?.payload?.rate_limits;

    if (!rateLimits?.primary) {
      continue;
    }

    const observedAt = new Date(parsed?.timestamp);

    return {
      ok: true,
      provider: "Codex",
      primary: normalizeCodexWindow(rateLimits.primary),
      secondary: normalizeCodexWindow(rateLimits.secondary),
      planType: rateLimits.plan_type ?? null,
      observedAt: Number.isFinite(observedAt.getTime()) ? observedAt.toISOString() : null,
    };
  }

  return null;
}

export async function getCodexUsage() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sessionsDir = path.join(codexHome, "sessions");
  const files = await findRecentJsonlFiles(sessionsDir);

  for (const filePath of files) {
    let lines;

    try {
      lines = await readTailLines(filePath);
    } catch {
      continue;
    }

    const result = extractCodexRateLimitsFromLines(lines);

    if (result) {
      return {
        ...result,
        sourceFile: filePath,
      };
    }
  }

  return {
    ok: false,
    provider: "Codex",
    error: `No Codex rate limit snapshots found in recent files under ${sessionsDir}`,
  };
}

function chooseRecommendation(claude, codex) {
  const candidates = [];

  if (claude?.ok && typeof claude.primary?.usedPercent === "number") {
    candidates.push({
      provider: "Claude",
      remaining: 100 - claude.primary.usedPercent,
      secondaryRemaining:
        typeof claude.secondary?.usedPercent === "number" ? 100 - claude.secondary.usedPercent : null,
    });
  }

  if (codex?.ok && typeof codex.primary?.usedPercent === "number") {
    candidates.push({
      provider: "Codex",
      remaining: 100 - codex.primary.usedPercent,
      secondaryRemaining:
        typeof codex.secondary?.usedPercent === "number" ? 100 - codex.secondary.usedPercent : null,
    });
  }

  if (candidates.length === 0) {
    return "No recommendation available.";
  }

  candidates.sort((left, right) => {
    if (right.remaining !== left.remaining) {
      return right.remaining - left.remaining;
    }

    return (right.secondaryRemaining ?? -Infinity) - (left.secondaryRemaining ?? -Infinity);
  });

  return `Prefer ${candidates[0].provider} right now based on the active window.`;
}

function renderProviderBlock(result) {
  if (!result.ok) {
    return [color(`${result.provider}: unavailable`, 31), `  error: ${formatErrorMessage(result.error)}`];
  }

  const primaryColor = severityColor(result.primary?.usedPercent ?? 100);
  const lines = [
    color(`${result.provider}: ${formatPercent(result.primary?.usedPercent)} active window used`, primaryColor),
    `  active: ${formatWindow(result.primary)}`,
  ];

  if (result.secondary) {
    lines.push(`  long:   ${formatWindow(result.secondary)}`);
  }

  if (result.planType) {
    lines.push(`  plan:   ${result.planType}`);
  }

  if (result.sourceDescription) {
    lines.push(`  source: ${result.sourceDescription}`);
  }

  const staleWindows = [];

  if (result.primary?.isStale) {
    staleWindows.push("active");
  }

  if (result.secondary?.isStale) {
    staleWindows.push("long");
  }

  if (staleWindows.length > 0) {
    const age = formatSnapshotAge(result.observedAt);
    const ageText = age ? `, data is ${age} old` : "";
    lines.push(
      color(
        `  note:   ${staleWindows.join(" and ")} window reset time has passed${ageText} — run codex to refresh`,
        33,
      ),
    );
  }

  return lines;
}

export function renderScreen({ claude, codex, options, now = new Date() }) {
  const header = [
    "AI Usage CLI",
    `Updated: ${formatAbsoluteDate(now)}`,
    `Refresh: every ${options.intervalSeconds}s`,
    chooseRecommendation(claude, codex),
    "",
  ];

  const body = [
    ...renderProviderBlock(claude),
    "",
    ...renderProviderBlock(codex),
    "",
    "Notes:",
    "  Claude comes from `claude -p \"/usage\"`.",
    "  Codex comes from the most recent `rate_limits` snapshot found in ~/.codex/sessions.",
  ];

  return [...header, ...body].join("\n");
}

export function serializeSnapshot({ claude, codex, options, now = new Date() }) {
  return JSON.stringify(
    {
      updatedAt: now.toISOString(),
      intervalSeconds: options.intervalSeconds,
      recommendation: chooseRecommendation(claude, codex),
      providers: {
        claude,
        codex,
      },
    },
    null,
    2,
  );
}

export async function collectSnapshot() {
  const [claude, codex] = await Promise.all([getClaudeUsage(), getCodexUsage()]);
  return { claude, codex };
}

export async function collectAndRender(options) {
  const snapshot = await collectSnapshot();

  if (options.json) {
    process.stdout.write(`${serializeSnapshot({ ...snapshot, options })}\n`);
    return;
  }

  if (!options.noClear) {
    clearTerminal();
  }

  process.stdout.write(`${renderScreen({ ...snapshot, options })}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.once) {
    await collectAndRender(options);
    return;
  }

  while (true) {
    await collectAndRender(options);
    await sleep(options.intervalSeconds * 1000);
  }
}
