# claude-context — Build Spec

Build a local MCP server + web client that gives Claude Code persistent, per-project session memory. Every Claude Code session logs its decisions and actions to a structured store; a web client auto-opens per session so the user can see what happened, scroll through history, and swap between sessions without losing context.

---

## Target environment

- **OS:** macOS only.
- **Runtime:** Docker container. Single `docker compose up -d` should bring everything up and keep it running in the background.
- **Binding:** `127.0.0.1` only. Single user. No auth, no LAN exposure.
- **Port:** `4100` (configurable via env var `PORT`).

---

## Stack

- **Backend:** Node.js. Use TypeScript if it doesn't meaningfully slow the build; otherwise plain JS with JSDoc types. Pick whichever is cleaner for the MCP SDK.
- **DB:** SQLite via `better-sqlite3`. File lives in a Docker volume mounted at `/data/db.sqlite` on the container (host path: `~/.claude-context/db.sqlite`).
- **HTTP/WS:** Express + `ws`.
- **MCP SDK:** `@modelcontextprotocol/sdk`.
- **Frontend:** Plain HTML + ES modules. No build step. No framework. Served by the same Express app.

---

## Core concepts

- **Project** = a working directory (absolute path). Many-to-one: many sessions belong to one project. Auto-created on first session in a directory.
- **Session** = a Claude Code conversation, identified by its native session ID. Permanent. Never closed or archived.
- **Event** = an immutable, timestamped log entry Claude writes during a session. Types: `decision`, `action`, `note`, `question`.

---

## Database schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,            -- first 16 chars of sha256 of directory path
  directory TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,             -- basename of directory
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,            -- Claude Code session ID
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  type TEXT NOT NULL CHECK(type IN ('decision','action','note','question')),
  message TEXT NOT NULL,
  context TEXT,                   -- JSON string, nullable
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session_desc ON events(session_id, id DESC);
```

Events are **immutable**. No `UPDATE` or `DELETE` statements on the `events` table anywhere in the codebase.

---

## MCP tools

All tools write to DB synchronously via the HTTP server's internal API, then the event bus broadcasts to relevant WS clients.

| Tool | Args | Returns |
|---|---|---|
| `register_session` | `session_id?`, `directory`, `title?` | `{ project_id, session_id, is_new }` |
| `log_decision` | `session_id`, `message`, `context?` | `{ event_id }` |
| `log_action` | `session_id`, `message`, `context?` | `{ event_id }` |
| `log_note` | `session_id`, `message` | `{ event_id }` |
| `log_question` | `session_id`, `message` | `{ event_id }` |
| `get_session_history` | `session_id`, `before_event_id?`, `limit?` (default 10, max 50) | `{ events[], has_more, oldest_event_id }` |
| `get_project_sessions` | `directory` | `{ project, sessions[] }` ordered by `last_active_at DESC` |
| `set_session_title` | `session_id`, `title` | `{ ok }` |

`register_session` must upsert: create project if directory is new, create session if session_id is new, otherwise just bump `last_active_at`. If `session_id` is omitted, the backend generates a unique ID (UUID v4). The returned `session_id` must be used for all subsequent tool calls. Safe to call multiple times.

---

## HTTP + WS API

All endpoints bind to `127.0.0.1`. All responses are JSON. The `context` field is always returned as a parsed object (never a raw string).

### Public endpoints (used by frontend)

- `GET /` → serves `index.html`
- `GET /session/:id` → serves `index.html` (client-side routing handles it)
- `GET /api/projects` → `[{ id, directory, name, session_count, last_active_at }]`
- `GET /api/projects/:id/sessions` → `[{ id, title, created_at, last_active_at, event_count }]`
- `GET /api/sessions/:id` → `{ session, project, events: [latest 10], has_more, oldest_event_id }`
- `GET /api/sessions/:id/events?before=<event_id>&limit=<n>` → `{ events, has_more, oldest_event_id }` — keyset pagination only, no OFFSET
- `WS /ws?session_id=<id>` → subscribes to live events for that session. Server pushes `{ type: 'event', event: {...} }`.

### Internal endpoint (used by MCP shim)

- `POST /internal/rpc` → body `{ tool: string, args: object }` — executes any MCP tool server-side, returns tool result. Used by the MCP shim to forward Claude Code tool calls to the Docker container.

### Registration endpoint (used by session hook)

- `POST /api/register` → body `{ session_id?, directory, title? }` — same behavior as `register_session` MCP tool. If `session_id` is omitted, the backend generates one. Allows the `SessionStart` hook to register sessions via curl without going through MCP.

---

## Optimization requirements

- **SQLite pragmas** applied at boot: `WAL`, `synchronous=NORMAL`, `foreign_keys=ON`.
- **Prepared statements** for every query, constructed once at DB init and reused.
- **WS scoping:** each WS connection is bound to exactly one `session_id` (from query param on connect). Server maintains `Map<session_id, Set<WebSocket>>` and only pushes to the relevant set.
- **Debounced `last_active_at` writes:** update at most once per 30 seconds per session. Keep a `Map<session_id, timestamp>` in memory.
- **Keyset pagination everywhere.** No `OFFSET` queries.
- **context parsing:** parse `context` JSON once at DB read time, not in the frontend.

---

## Frontend

Served from `public/`. Plain ES modules. No build step.

### Layout

- **Left sidebar:** list of projects, each expandable to show its sessions. Sessions show title + relative last-active time. Click any session to navigate to it without a page reload.
- **Main pane:** chronological event feed for the selected session. Oldest events at top, newest at bottom.
- **Top bar:** current project path, editable session title (calls `set_session_title` on blur), and a "copy resume command" button that copies `claude --resume <session_id>` to clipboard.

### Event rendering

- Color-coded left border by type: `decision` = blue, `action` = green, `note` = gray, `question` = amber.
- Monospace font throughout. Dense layout. Timestamp shown on the right of each event.
- If `context` is present, render it as a collapsible block showing formatted JSON.

### Pagination behavior

- **Initial load:** fetch from `GET /api/sessions/:id` → render 10 events → scroll to bottom.
- Place a sentinel `<div>` at the very top of the event list.
- Attach an `IntersectionObserver` to the sentinel.
- When sentinel becomes visible AND `has_more` is true:
  1. Record scroll anchor: get the topmost visible event node and its current `offsetTop`.
  2. Fetch `GET /api/sessions/:id/events?before=<oldest_event_id>&limit=10`.
  3. Prepend new events to the DOM.
  4. Restore scroll: `container.scrollTop += (anchor.offsetTop - previousAnchorOffsetTop)`.
- When `has_more` is false: remove sentinel, insert a `— beginning of session —` marker.
- Maintain a `Set<number>` of rendered event IDs. Skip any event (from fetch or WS) already in the set.

### WS behavior

- Connect on session view load: `ws://127.0.0.1:4100/ws?session_id=<id>`.
- On new event from server:
  - If `scrollTop + clientHeight >= scrollHeight - 50` → append event + scroll to bottom.
  - Otherwise → append event to DOM (hidden below scroll) + show a floating pill `↓ N new events`. Clicking the pill scrolls to bottom and hides it.
- On disconnect: reconnect with exponential backoff — 1s, 2s, 4s, 8s, capped at 30s.

### Design direction

Utilitarian developer-tool aesthetic. Dark background. Monospace font throughout. High information density. No decorative elements. Think: log viewer, not dashboard.

---

## Architecture: two processes

Because Claude Code spawns MCP servers via stdio (not HTTP), and the persistent store runs in Docker, the system is split into two processes:

### 1. `claude-context-server` (runs in Docker)
- Express HTTP server on port 4100.
- Owns SQLite, all DB logic, the event bus, and the WS server.
- Exposes all public API endpoints + `/internal/rpc` + `/api/register`.
- Serves the frontend from `public/`.

### 2. `claude-context-mcp` (runs on host, spawned by Claude Code via stdio)
- Thin MCP shim. No DB access.
- Implements all 8 tools.
- Each tool handler calls `POST http://127.0.0.1:4100/internal/rpc` with `{ tool, args }` and returns the result to Claude Code.
- Must be installed globally on the host with `npm install -g`.

### bin entries in package.json

```json
"bin": {
  "claude-context-server": "dist/server.js",
  "claude-context-mcp":    "dist/mcp.js"
}
```

---

## Docker setup

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
COPY public/ ./public/
EXPOSE 4100
CMD ["node", "dist/server.js"]
```

### docker-compose.yml

```yaml
services:
  claude-context:
    build: .
    ports:
      - "127.0.0.1:4100:4100"
    volumes:
      - ~/.claude-context:/data
    restart: unless-stopped
    environment:
      - PORT=4100
      - DB_PATH=/data/db.sqlite
```

---

## Claude Code integration

### Session registration: use both hook + CLAUDE.md for reliability

**SessionStart hook** (registers session + opens browser automatically):

Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://127.0.0.1:4100/api/register -H 'Content-Type: application/json' -d \"{\\\"session_id\\\":\\\"$CLAUDE_SESSION_ID\\\",\\\"directory\\\":\\\"$PWD\\\"}\" && open \"http://127.0.0.1:4100/session/$CLAUDE_SESSION_ID\""
      }]
    }]
  }
}
```

**MCP registration** — add to `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "claude-context": {
      "command": "claude-context-mcp"
    }
  }
}
```

### Global CLAUDE.md snippet

Append this to `~/.claude/CLAUDE.md`:

```markdown
## Session logging (claude-context MCP)

At the start of every session:
1. Call `register_session` with the current working directory and a short title describing the task. The backend generates a unique session ID — use the returned `session_id` for all subsequent tool calls. This is idempotent — safe to call even if the hook already registered the session (pass the existing `session_id` to refresh it).
2. If resuming an existing session, call `get_session_history` to reload the last 10 events as context.

Throughout the session:
- `log_decision` — non-trivial technical or design choices. Example: "Chose keyset pagination over offset because the event table will grow unboundedly."
- `log_action` — meaningful completed work. Example: "Refactored auth middleware. Moved JWT logic to dedicated module."
- `log_question` — open questions blocked on user input.
- `log_note` — important context that doesn't fit decision or action.

Keep messages to one or two sentences. Put structured details in the `context` argument as JSON.
```

---

## File layout

```
claude-context/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── server.ts          # HTTP server entrypoint (runs in Docker)
│   ├── mcp.ts             # MCP shim entrypoint (runs on host via stdio)
│   ├── db.ts              # schema, migrations, prepared statements
│   ├── http.ts            # Express app, all routes, WS server
│   ├── events.ts          # internal EventEmitter bus
│   └── types.ts           # shared types
├── public/
│   ├── index.html
│   ├── style.css
│   ├── app.js             # bootstrap, hash-based client-side routing
│   ├── api.js             # fetch wrappers + WS client with reconnect
│   └── session-view.js    # pagination, scroll anchoring, dedup logic
└── scripts/
    └── install.sh         # idempotent install: docker compose up, npm install -g, patch settings + mcp.json, print CLAUDE.md snippet
```

---

## Install script (`scripts/install.sh`)

Must be **idempotent** — detect existing entries and skip, never duplicate.

Steps in order:
1. Run `docker compose up -d` from the project root.
2. Run `npm run build` then `npm install -g .` to install the MCP shim on the host.
3. Patch `~/.claude/mcp.json` to add the `claude-context` server entry (create file if it doesn't exist).
4. Patch `~/.claude/settings.json` to add the `SessionStart` hook (create file if it doesn't exist, merge carefully).
5. Print the CLAUDE.md snippet with instructions on where to paste it (`~/.claude/CLAUDE.md`).

---

## Build order

Build in this order to avoid circular dependencies:

1. `package.json`, `tsconfig.json`, `Dockerfile`, `docker-compose.yml` — scaffolding.
2. `src/types.ts` — shared type definitions.
3. `src/db.ts` — schema creation, pragma setup, all prepared statements, upsert helpers.
4. `src/events.ts` — internal EventEmitter: `emit(session_id, event)`, `subscribe(session_id, cb)`, `unsubscribe`.
5. `src/http.ts` — Express app with all routes and WS. Depends on db + events.
6. `src/server.ts` — boots http.ts, binds to port, logs startup.
7. `src/mcp.ts` — MCP stdio server, all 8 tools forwarding to `/internal/rpc` via fetch.
8. Frontend: `index.html`, `style.css`, `app.js`, `api.js`, `session-view.js`.
9. `scripts/install.sh`.
10. `README.md` — install steps, how to start, how to resume a session.

---

## Acceptance criteria

- [ ] `docker compose up -d` starts the server and it survives reboots (`restart: unless-stopped`).
- [ ] `claude-context-mcp` is registered in `~/.claude/mcp.json` and Claude Code can discover it.
- [ ] Starting a new Claude Code session triggers the hook: session is registered in DB and browser opens to `http://127.0.0.1:4100/session/<id>`.
- [ ] Claude can call all 8 MCP tools and they persist correctly to SQLite.
- [ ] Frontend shows latest 10 events on load, scrolled to bottom.
- [ ] Scrolling up loads the previous 10 events via keyset pagination without scroll position jumping.
- [ ] When `has_more` is false, a "— beginning of session —" marker appears and no further fetches are made.
- [ ] New events pushed over WS appear in real time; auto-scroll only when already at bottom; pill appears when scrolled up.
- [ ] Switching sessions in the sidebar works without a full page reload.
- [ ] Events cannot be edited or deleted through any interface.
- [ ] Server only binds to `127.0.0.1:4100`, never `0.0.0.0`.
- [ ] `install.sh` is idempotent: running it twice produces no duplicates in config files.
