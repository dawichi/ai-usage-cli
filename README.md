# Agent Usage Dashboard

Small dependency-free terminal dashboard for comparing remaining usage between Claude Code and Codex.

It is designed for a simple decision: which agent has more room left in the current window right now?

## Features

- Reads Claude usage from `claude -p /usage`
- Reads Codex usage from recent session snapshots under `~/.codex/sessions`
- Shows active and longer-window usage side by side
- Recommends which provider currently has more active-window headroom
- Supports terminal mode and one-shot JSON output
- Works with plain Node.js and no external packages

## What This Project Reads

The dashboard reads local machine state only:

- Claude CLI output from `claude -p /usage`
- Codex local session files under `~/.codex/sessions`

It does not make network requests, send telemetry, or require API keys of its own.

The default terminal view does not print local filesystem paths, which makes it safer to screenshot or share.

## Requirements

- Node.js 18 or newer
- Claude Code installed and available in `PATH`
- Codex already used at least once on the machine so `~/.codex/sessions` exists

## Quick Start

```bash
git clone <your-repo-url>
cd agent-usage-dashboard
npm start
```

One-shot terminal output:

```bash
npm run once
```

One-shot JSON output:

```bash
npm run json
```

Custom refresh interval:

```bash
node usage-dashboard.mjs --interval 30
```

Disable terminal clearing:

```bash
node usage-dashboard.mjs --interval 60 --no-clear
```

## CLI Options

- `--once`: render once and exit
- `--interval <seconds>`: polling interval for watch mode
- `--no-clear`: do not clear the terminal before each refresh
- `--json`: print a single JSON snapshot and exit-friendly output for scripts

`--json` also implies `--no-clear`.

## Example Output

```text
Agent Usage Dashboard
Updated: Jun 10, 2026, 02:14 PM
Refresh: every 60s
Prefer Codex right now based on the active window.

Claude: 99% active window used
  active: 99% used | 1% left | resets Jun 10 at 2:30pm (Europe/Madrid) | window unknown
  long:   15% used | 85% left | resets Jun 14 at 10pm (Europe/Madrid) | window unknown

Codex: 32% active window used
  active: 32% used | 68% left | resets Jun 10, 2026, 05:51 PM (in 3h 37m) | window 300m
  long:   5% used | 95% left | resets Jun 17, 2026, 12:51 PM (in 6d 22h 37m) | window 10080m
  plan:   plus
```

## Environment Variables

- `CLAUDE_CMD`: override the Claude executable name or path
- `CODEX_HOME`: override the Codex home directory

Examples:

```bash
CLAUDE_CMD=/custom/path/claude node usage-dashboard.mjs --once
```

```bash
CODEX_HOME=/custom/path/.codex node usage-dashboard.mjs --once
```

## Development

Run tests:

```bash
npm test
```

Project structure:

- `usage-dashboard.mjs`: CLI entrypoint
- `src/dashboard.mjs`: core logic, parsing, rendering, data collection
- `tests/dashboard.test.mjs`: parser and rendering tests
- `LICENSE`: MIT license

## Design Notes

- Claude parsing is intentionally strict: if the CLI format changes in a way the parser cannot understand, the dashboard reports Claude as unavailable instead of showing misleading `n/a` values.
- Codex lookup is optimized for recent history. It scans recent dated session folders and reads only the tail of candidate `.jsonl` files instead of loading the full history on every refresh.
- JSON mode still includes the Codex `sourceFile` for debugging and scripting if you need to inspect where the snapshot came from.

## Privacy And Publishing

This repository can be public.

The code does not include:

- API keys
- tokens
- personal usage logs
- copied Codex session files
- copied Claude output snapshots

The terminal UI avoids showing local path details. JSON mode still exposes the source path intentionally for debugging, but that data is generated at runtime and is not stored in the repository.

## Possible Next Steps

- Optional web UI
- Status bar or tray wrapper
- Threshold alerts
- Additional providers
