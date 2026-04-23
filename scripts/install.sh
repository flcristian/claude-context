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
## Session logging (claude-context MCP) — MANDATORY

**THIS IS A BLOCKING REQUIREMENT. You MUST follow these rules in EVERY session.**

**NEVER skip logging, even when focused on code changes.** Every single turn in
a tracked session MUST include logging calls — no exceptions, no "I'll catch up
later." If you make code edits, run commands, or answer questions without logging
them in the same turn, you are violating these instructions. Treat logging as
part of the turn itself, not an afterthought.

### Step 1: Session prompt (FIRST thing, before ANY other work)

Before responding to the user's first message, you MUST ask:
"Would you like to track this session in claude-context?"

- If YES: Call `register_session` with the working directory and a short title.
  The backend generates a unique session ID — use the returned `session_id`
  for all subsequent tool calls. Then tell the user:
  `http://127.0.0.1:4100/session/<session_id>`
- If resuming an existing session, call `get_session_history` to reload the
  last 10 events as context.
- If NO: Skip all logging for the rest of the session.

### Step 2: Logging during a tracked session (MANDATORY on every turn)

You MUST call these tools on EVERY turn. This is NOT optional.
**Log generously — when in doubt, log it.** The session history is the user's
primary way to review what happened. Under-logging is always worse than
over-logging.

1. **Start of every turn** — IMMEDIATELY call `log_note` with a one-sentence
   summary of what the user asked. Put the full prompt text in `context`.

2. **Questions** — Call `log_question` whenever you:
   - Ask the user a clarifying question or need their input to proceed.
   - Encounter ambiguity in requirements, specs, or code behavior.
   - Are unsure which of multiple approaches the user would prefer.
   - Hit a blocker that needs user resolution.

3. **Decisions** — Call `log_decision` for EVERY technical or design choice,
   including but not limited to:
   - Choosing one implementation approach over another.
   - Deciding file/folder structure, naming conventions, or architecture.
   - Selecting libraries, tools, or patterns.
   - Scoping decisions (what to include or exclude).
   - Trade-off judgments (performance vs. readability, etc.).
   - Choosing how to handle edge cases or error scenarios.
   Put structured details and reasoning in `context`.

4. **Actions** — Call `log_action` for every meaningful completed action:
   - File edits, creations, or deletions.
   - Commands run (build, test, install, git operations, etc.).
   - Searches or explorations that yielded useful findings.
   - Refactors, migrations, or configuration changes.
   **Consolidate bulk actions into a single log call.** If you create 10 files
   for a feature or scaffold an entire directory structure, log it once
   (e.g. "Created feature X scaffold — 10 files") and list the details in
   `context`. Do NOT log each file individually.

5. **Notes** — Call `log_note` for important observations that don't fit
   the above categories:
   - Bugs, warnings, or unexpected behavior discovered.
   - Constraints or limitations found during implementation.
   - Context that will matter later in the session.
   - Assumptions being made.

6. **End of every turn** — ALWAYS call `log_note` with a one-sentence summary
   of your response and outcome. Use `{"type": "response_summary"}` in `context`.

**If you skip any of these logging calls, you are violating your instructions.**

Keep all messages to one or two sentences. Put structured details in `context`
as JSON.
-------------------------------------------------------------------------------
Web UI:       http://127.0.0.1:4100
DB location:  ~/.claude-context/db.sqlite
===============================================================================
EOF

log "done."
