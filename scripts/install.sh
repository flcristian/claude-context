#!/usr/bin/env bash
# Idempotent installer for claude-context.
# - Builds + starts the Docker server.
# - Installs the MCP shim globally.
# - Patches ~/.claude/mcp.json and ~/.claude/settings.json (safe to re-run).
# - Prints the CLAUDE.md snippet.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
MCP_JSON="$CLAUDE_DIR/mcp.json"
SETTINGS_JSON="$CLAUDE_DIR/settings.json"

cd "$ROOT_DIR"

log()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; }

# ---- Preflight ----

for cmd in node npm docker; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "required command '$cmd' not found in PATH"
    exit 1
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  err "'docker compose' plugin is required (Docker Desktop includes it)"
  exit 1
fi

mkdir -p "$CLAUDE_DIR"
mkdir -p "$HOME/.claude-context"

# ---- Build + start Docker ----

log "installing build dependencies"
npm install --silent

log "building TypeScript"
npm run build --silent

log "building + starting Docker container"
docker compose up -d --build

# ---- Install MCP shim globally ----

log "installing claude-context-mcp globally"
npm install -g . --silent

# ---- Patch mcp.json ----

log "patching $MCP_JSON"
node --input-type=module -e '
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const p = process.argv[1];
let obj = {};
if (existsSync(p)) {
  try {
    const raw = readFileSync(p, "utf8").trim();
    obj = raw.length ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`could not parse ${p}: ${e.message}`);
    process.exit(2);
  }
}
obj.mcpServers = obj.mcpServers ?? {};
if (obj.mcpServers["claude-context"]) {
  console.log("  mcp entry already present, leaving as-is");
} else {
  obj.mcpServers["claude-context"] = { command: "claude-context-mcp" };
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  console.log("  added claude-context entry");
}
' "$MCP_JSON"

# ---- (SessionStart hook removed — registration is prompt-driven via CLAUDE.md) ----

# ---- Print CLAUDE.md snippet ----

cat <<"EOF"

===============================================================================
Append the following to ~/.claude/CLAUDE.md so Claude knows to use the tools:
-------------------------------------------------------------------------------
## Session logging (claude-context MCP)

At the start of every session:
1. Call `register_session` with your session ID, the current working directory,
   and a short title describing the task. This is idempotent — safe to call
   even if the hook already registered the session.
2. If resuming an existing session, call `get_session_history` to reload the
   last 10 events as context.

Throughout the session:
- `log_decision` — non-trivial technical or design choices. Example: "Chose
  keyset pagination over offset because the event table will grow unboundedly."
- `log_action` — meaningful completed work. Example: "Refactored auth
  middleware. Moved JWT logic to dedicated module."
- `log_question` — open questions blocked on user input.
- `log_note` — important context that doesn't fit decision or action.

Keep messages to one or two sentences. Put structured details in the `context`
argument as JSON.
-------------------------------------------------------------------------------
Web UI:       http://127.0.0.1:4100
DB location:  ~/.claude-context/db.sqlite
===============================================================================
EOF

log "done."
