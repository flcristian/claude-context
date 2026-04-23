# claude-context

Local MCP server + web client that gives Claude Code persistent, per-project session memory.

Each Claude Code session logs its decisions and actions to SQLite. A web UI at `http://127.0.0.1:4100` auto-opens on session start so you can watch the session fill up in real time, scroll through history, and swap between sessions without losing context.

macOS only. Single user. Bound to `127.0.0.1` — never exposed on the LAN.

## Architecture

Two processes:

1. **`claude-context-server`** (Docker) — Express + WebSocket server on port `4100`. Owns SQLite, serves the web UI, exposes REST + WS APIs + an internal RPC endpoint.
2. **`claude-context-mcp`** (on host, spawned by Claude Code via stdio) — thin MCP shim installed globally. Forwards each tool call to `POST http://127.0.0.1:4100/internal/rpc`.

Sessions are registered through two paths for reliability:
- A `SessionStart` hook in `~/.claude/settings.json` that `curl`s `/api/register` and opens the UI.
- The `register_session` MCP tool, which Claude is instructed to call at session start via `~/.claude/CLAUDE.md`.

Both are idempotent.

## Install

```bash
./scripts/install.sh
```

The installer:
1. Runs `npm install` + `npm run build`.
2. Runs `docker compose up -d`.
3. Runs `npm install -g .` to install the MCP shim (`claude-context-mcp`) globally.
4. Patches `~/.claude/mcp.json` to register the MCP server.
5. Patches `~/.claude/settings.json` to add the `SessionStart` hook.
6. Prints a snippet for you to append to `~/.claude/CLAUDE.md`.

Safe to re-run: every patch checks first and skips if present.

Requirements: `node` (>= 20), `npm`, `docker` with the `compose` plugin.

## Day-to-day

- Start a new Claude Code session anywhere. The hook registers the session and opens `http://127.0.0.1:4100/session/<id>` in your browser.
- As Claude works, it calls `log_decision`, `log_action`, `log_note`, `log_question`. Events appear in the UI in real time over WebSocket.
- Scroll up to load older events (keyset pagination, 10 at a time).
- Click any project in the sidebar to expand its sessions. Click a session to swap without a page reload.
- Rename a session by editing the title in the top bar — saves on blur.
- Click **copy resume** in the top bar to put `claude --resume <session_id>` on your clipboard.

## Resuming a session

```bash
claude --resume <session_id>
```

Claude will (per the CLAUDE.md snippet) call `get_session_history` to reload the last 10 events so it can pick up where it left off.

## MCP tools

| Tool | When to use |
|---|---|
| `register_session` | On session start, idempotent. |
| `log_decision` | Non-trivial technical or design choice. |
| `log_action` | Meaningful completed work. |
| `log_note` | Important context that isn't a decision or action. |
| `log_question` | Open questions blocked on user input. |
| `get_session_history` | Paginate through prior events (keyset). |
| `get_project_sessions` | List sessions in a working directory. |
| `set_session_title` | Rename a session. |

## Storage

- **DB:** `~/.claude-context/db.sqlite` (mounted into the container at `/data/db.sqlite`).
- **WAL mode**, `synchronous=NORMAL`, foreign keys on.
- Events are **immutable** — there is no `UPDATE` or `DELETE` against the events table anywhere in the code.

## Uninstall

```bash
docker compose down
npm uninstall -g claude-context
```

Then remove:
- The `claude-context` entry from `~/.claude/mcp.json`.
- The `SessionStart` hook from `~/.claude/settings.json` (the entry whose command references `127.0.0.1:4100/api/register`).
- Optionally, `~/.claude-context/` to wipe the DB.

## Dev

```bash
npm install
npm run build        # one-shot
npm run dev          # tsc --watch
npm run start        # runs dist/server.js against ./data/db.sqlite (override with DB_PATH)
```

The frontend has no build step — edit files in `public/` and reload.
