#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const RPC_URL =
  process.env.CLAUDE_CONTEXT_URL ?? 'http://127.0.0.1:4100/internal/rpc';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

const SESSION_ID: ToolDef['inputSchema']['properties'] = {
  session_id: { type: 'string', description: 'Claude Code session ID' },
};

const TOOLS: ToolDef[] = [
  {
    name: 'register_session',
    description:
      'Register a new Claude Code session or refresh an existing one. The backend generates a unique session_id if none is provided. Returns the session_id to use for all subsequent tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Optional. Pass an existing session_id to refresh it; omit to create a new session.',
        },
        directory: {
          type: 'string',
          description: 'Absolute path of the working directory for this session.',
        },
        title: {
          type: 'string',
          description: 'Optional short title describing the task for this session.',
        },
        claude_session_id: {
          type: 'string',
          description: 'The Claude Code session ID (used for --resume). Pass your actual Claude Code session ID here.',
        },
      },
      required: ['directory'],
      additionalProperties: false,
    },
  },
  {
    name: 'log_decision',
    description:
      'Log a non-trivial technical or design decision made during the session. Keep the message to one or two sentences; put structured details in context.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_ID,
        message: { type: 'string' },
        context: {
          description: 'Optional structured JSON with additional detail.',
        },
      },
      required: ['session_id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'log_action',
    description:
      'Log a meaningful completed action (code change, refactor, migration, etc). One or two sentences; put structured details in context.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_ID,
        message: { type: 'string' },
        context: { description: 'Optional structured JSON with additional detail.' },
      },
      required: ['session_id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'log_note',
    description:
      'Log important context that is not a decision or action — facts, constraints, or observations worth remembering across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_ID,
        message: { type: 'string' },
      },
      required: ['session_id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'log_question',
    description:
      'Log an open question that is blocked on user input or needs follow-up later.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_ID,
        message: { type: 'string' },
      },
      required: ['session_id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_session_history',
    description:
      'Load prior events for a session in reverse chronological pages (newest first). Use before_event_id to paginate older events. Default limit 10, max 50.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_ID,
        before_event_id: {
          type: 'number',
          description: 'Return events with id strictly less than this value.',
        },
        limit: { type: 'number', description: 'Default 10, max 50.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_project_sessions',
    description:
      'List all sessions for the project at the given directory, ordered by last_active_at DESC.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
      },
      required: ['directory'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_session_title',
    description: 'Update the title of an existing session.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_ID,
        title: { type: 'string' },
      },
      required: ['session_id', 'title'],
      additionalProperties: false,
    },
  },
];

async function callRpc(tool: string, args: unknown): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === 'string') message = parsed.error;
    } catch {
      /* keep raw text */
    }
    throw new Error(
      `claude-context RPC ${tool} failed (${res.status}): ${message}`,
    );
  }
  const parsed = JSON.parse(text) as { ok?: boolean; result?: unknown; error?: string };
  if (!parsed.ok) {
    throw new Error(
      `claude-context RPC ${tool} error: ${parsed.error ?? 'unknown'}`,
    );
  }
  return parsed.result;
}

async function main() {
  const server = new Server(
    { name: 'claude-context', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const allowed = TOOLS.some((t) => t.name === name);
    if (!allowed) {
      return {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = await callRpc(name, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[claude-context-mcp] fatal:', err);
  process.exit(1);
});
