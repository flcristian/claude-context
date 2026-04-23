import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Db } from './db.js';
import type { EventBus } from './events.js';
import type {
  EventType,
  GetProjectSessionsArgs,
  GetProjectSessionsResult,
  GetSessionHistoryArgs,
  GetSessionHistoryResult,
  LogEventArgs,
  LogEventResult,
  RegisterSessionArgs,
  RegisterSessionResult,
  SetSessionTitleArgs,
  SetSessionTitleResult,
  ToolName,
} from './types.js';

const MAX_HISTORY_LIMIT = 50;
const DEFAULT_HISTORY_LIMIT = 10;

export interface Deps {
  db: Db;
  bus: EventBus;
  publicDir: string;
  indexFile: string;
}

type ToolHandler = (args: any) => unknown;

function createToolHandlers(db: Db, bus: EventBus): Record<ToolName, ToolHandler> {
  function requireString(v: unknown, name: string): string {
    if (typeof v !== 'string' || v.length === 0) {
      throw new HttpError(400, `${name} is required`);
    }
    return v;
  }

  function logEvent(type: EventType, args: LogEventArgs): LogEventResult {
    const session_id = requireString(args?.session_id, 'session_id');
    const message = requireString(args?.message, 'message');
    const session = db.getSession(session_id);
    if (!session) {
      throw new HttpError(404, `session ${session_id} not registered`);
    }
    const now = Date.now();
    const event = db.insertEvent(session_id, type, message, args?.context ?? null, now);
    bus.emit(session_id, event);
    return { event_id: event.id };
  }

  return {
    register_session(args: RegisterSessionArgs): RegisterSessionResult {
      const directory = requireString(args?.directory, 'directory');
      const session_id =
        typeof args?.session_id === 'string' && args.session_id.length > 0
          ? args.session_id
          : crypto.randomUUID();
      const title = typeof args?.title === 'string' && args.title.length > 0 ? args.title : undefined;
      const now = Date.now();
      const result = db.upsertSession(session_id, directory, title, now);
      if (result.is_new) {
        bus.emitGlobal({ kind: 'session_created', session_id, project_id: result.project_id });
      }
      return result;
    },

    log_decision(args: LogEventArgs) {
      return logEvent('decision', args);
    },

    log_action(args: LogEventArgs) {
      return logEvent('action', args);
    },

    log_note(args: LogEventArgs) {
      return logEvent('note', args);
    },

    log_question(args: LogEventArgs) {
      return logEvent('question', args);
    },

    get_session_history(args: GetSessionHistoryArgs): GetSessionHistoryResult {
      const session_id = requireString(args?.session_id, 'session_id');
      let limit = args?.limit ?? DEFAULT_HISTORY_LIMIT;
      if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_HISTORY_LIMIT;
      limit = Math.min(Math.floor(limit), MAX_HISTORY_LIMIT);

      if (args?.before_event_id != null) {
        const before = Number(args.before_event_id);
        if (!Number.isFinite(before)) {
          throw new HttpError(400, 'before_event_id must be a number');
        }
        return db.getSessionEventsBefore(session_id, before, limit);
      }
      return db.getLatestSessionEvents(session_id, limit);
    },

    get_project_sessions(args: GetProjectSessionsArgs): GetProjectSessionsResult {
      const directory = requireString(args?.directory, 'directory');
      const project = db.getProjectByDirectory(directory);
      if (!project) return { project: null, sessions: [] };
      const sessions = db.listProjectSessions(project.id);
      return { project, sessions };
    },

    set_session_title(args: SetSessionTitleArgs): SetSessionTitleResult {
      const session_id = requireString(args?.session_id, 'session_id');
      const title = requireString(args?.title, 'title');
      const ok = db.setSessionTitle(session_id, title);
      return { ok };
    },
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function createServer({ db, bus, publicDir, indexFile }: Deps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const tools = createToolHandlers(db, bus);

  // ---- Public API ----

  app.get('/api/projects', (_req, res) => {
    res.json(db.listProjects());
  });

  app.get('/api/projects/:id/sessions', (req, res) => {
    const project = db.getProjectById(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.json(db.listProjectSessions(project.id));
  });

  app.get('/api/sessions/:id', (req, res) => {
    const session = db.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const project = db.getProjectById(session.project_id);
    const pageRaw = req.query.page;
    let page = 1;
    if (typeof pageRaw === 'string' && pageRaw.length > 0) {
      const parsed = Number(pageRaw);
      if (Number.isFinite(parsed) && parsed > 0) page = Math.floor(parsed);
    }
    const result = db.getSessionEventsPage(session.id, page, DEFAULT_HISTORY_LIMIT);
    res.json({ session, project, ...result });
  });

  app.get('/api/sessions/:id/events', (req, res) => {
    const session = db.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const beforeRaw = req.query.before;
    const limitRaw = req.query.limit;
    let limit = DEFAULT_HISTORY_LIMIT;
    if (typeof limitRaw === 'string' && limitRaw.length > 0) {
      const parsed = Number(limitRaw);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(Math.floor(parsed), MAX_HISTORY_LIMIT);
      }
    }
    if (typeof beforeRaw === 'string' && beforeRaw.length > 0) {
      const before = Number(beforeRaw);
      if (!Number.isFinite(before)) {
        res.status(400).json({ error: 'before must be a number' });
        return;
      }
      res.json(db.getSessionEventsBefore(session.id, before, limit));
      return;
    }
    res.json(db.getLatestSessionEvents(session.id, limit));
  });

  // ---- Delete endpoints ----

  app.delete('/api/sessions/:id', (req, res) => {
    const ok = db.deleteSession(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    bus.emitGlobal({ kind: 'session_deleted', session_id: req.params.id });
    res.json({ ok: true });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const ok = db.deleteProject(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    bus.emitGlobal({ kind: 'project_deleted', project_id: req.params.id });
    res.json({ ok: true });
  });

  // ---- Registration endpoint (used by SessionStart hook) ----

  app.post('/api/register', (req, res, next) => {
    try {
      const result = tools.register_session(req.body ?? {});
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ---- Internal RPC (used by MCP shim) ----

  app.post('/internal/rpc', (req, res, next) => {
    try {
      const tool = req.body?.tool;
      const args = req.body?.args ?? {};
      if (typeof tool !== 'string' || !(tool in tools)) {
        throw new HttpError(400, `unknown tool: ${String(tool)}`);
      }
      const result = tools[tool as ToolName](args);
      res.json({ ok: true, result });
    } catch (err) {
      next(err);
    }
  });

  // ---- Static frontend ----

  app.use(express.static(publicDir, { index: false, fallthrough: true }));

  app.get('/', (_req, res) => {
    res.sendFile(indexFile);
  });
  app.get('/session/', (_req, res) => {
    res.redirect('/');
  });
  app.get('/session/:id', (_req, res) => {
    res.sendFile(indexFile);
  });

  // ---- Error handler ----

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[http] unhandled error:', err);
    res.status(500).json({ error: 'internal error' });
  });

  // ---- HTTP + WS ----

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get('session_id');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, sessionId ?? null);
    });
  });

  wss.on('connection', (ws: WebSocket, sessionId: string | null) => {
    let unsubscribe: () => void;
    if (sessionId) {
      unsubscribe = bus.subscribe(sessionId, (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'event', event }));
      });
    } else {
      unsubscribe = bus.subscribeGlobal((event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'global', event }));
      });
    }
    ws.on('close', unsubscribe);
    ws.on('error', () => {
      try {
        unsubscribe();
      } catch {
        /* noop */
      }
    });
  });

  return server;
}
