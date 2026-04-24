import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { basename } from 'path';
import type {
  EventRecord,
  EventType,
  Project,
  ProjectSummary,
  Session,
  SessionSummary,
} from './types.js';

const DEBOUNCE_MS = 30_000;

export interface Db {
  close(): void;
  upsertSession(
    sessionId: string,
    directory: string,
    title: string | undefined,
    claudeSessionId: string | undefined,
    now: number,
  ): { project_id: string; session_id: string; is_new: boolean };
  insertEvent(
    sessionId: string,
    type: EventType,
    message: string,
    context: unknown,
    now: number,
  ): EventRecord;
  listProjects(): ProjectSummary[];
  listProjectSessions(projectId: string): SessionSummary[];
  getProjectByDirectory(directory: string): Project | null;
  getProjectById(id: string): Project | null;
  getSession(sessionId: string): Session | null;
  getLatestSessionEvents(
    sessionId: string,
    limit: number,
  ): { events: EventRecord[]; has_more: boolean; oldest_event_id: number | null };
  getSessionEventsBefore(
    sessionId: string,
    beforeId: number,
    limit: number,
  ): { events: EventRecord[]; has_more: boolean; oldest_event_id: number | null };
  getSessionEventsPage(
    sessionId: string,
    page: number,
    pageSize: number,
  ): { events: EventRecord[]; total: number; page: number; totalPages: number };
  setSessionTitle(sessionId: string, title: string): boolean;
  touchSessionActivity(sessionId: string, now: number): void;
  deleteSession(sessionId: string): boolean;
  deleteProject(projectId: string): boolean;
}

function hashDirectory(dir: string): string {
  return createHash('sha256').update(dir).digest('hex').slice(0, 16);
}

function parseContext(raw: string | null): unknown | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface EventRow {
  id: number;
  session_id: string;
  type: EventType;
  message: string;
  context: string | null;
  created_at: number;
}

function rowToEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    type: row.type,
    message: row.message,
    context: parseContext(row.context),
    created_at: row.created_at,
  };
}

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      directory TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT,
      claude_session_id TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, last_active_at DESC);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      type TEXT NOT NULL CHECK(type IN ('decision','action','note','question')),
      message TEXT NOT NULL,
      context TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session_desc ON events(session_id, id DESC);
  `);

  // Migration: add claude_session_id column if missing.
  const cols = db.pragma('table_info(sessions)') as { name: string }[];
  if (!cols.some((c) => c.name === 'claude_session_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN claude_session_id TEXT');
  }

  const stmts = {
    getProjectByDir: db.prepare<[string], Project>(
      'SELECT id, directory, name, created_at FROM projects WHERE directory = ?',
    ),
    getProjectById: db.prepare<[string], Project>(
      'SELECT id, directory, name, created_at FROM projects WHERE id = ?',
    ),
    insertProject: db.prepare<[string, string, string, number]>(
      'INSERT INTO projects (id, directory, name, created_at) VALUES (?, ?, ?, ?)',
    ),
    getSession: db.prepare<[string], Session>(
      'SELECT id, project_id, title, claude_session_id, created_at, last_active_at FROM sessions WHERE id = ?',
    ),
    insertSession: db.prepare<[string, string, string | null, string | null, number, number]>(
      'INSERT INTO sessions (id, project_id, title, claude_session_id, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    updateSessionLastActive: db.prepare<[number, string]>(
      'UPDATE sessions SET last_active_at = ? WHERE id = ?',
    ),
    updateSessionTitleAndActive: db.prepare<[string, number, string]>(
      'UPDATE sessions SET title = ?, last_active_at = ? WHERE id = ?',
    ),
    setSessionTitle: db.prepare<[string, string]>(
      'UPDATE sessions SET title = ? WHERE id = ?',
    ),
    insertEvent: db.prepare<[string, EventType, string, string | null, number]>(
      'INSERT INTO events (session_id, type, message, context, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    selectEvent: db.prepare<[number], EventRow>(
      'SELECT id, session_id, type, message, context, created_at FROM events WHERE id = ?',
    ),
    // Fetch limit+1 to determine has_more without a separate count.
    latestEvents: db.prepare<[string, number], EventRow>(
      'SELECT id, session_id, type, message, context, created_at FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    ),
    eventsBefore: db.prepare<[string, number, number], EventRow>(
      'SELECT id, session_id, type, message, context, created_at FROM events WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
    ),
    countEvents: db.prepare<[string], { cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM events WHERE session_id = ?',
    ),
    eventsPage: db.prepare<[string, number, number], EventRow>(
      'SELECT id, session_id, type, message, context, created_at FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    ),
    listProjects: db.prepare<[], ProjectSummary>(`
      SELECT p.id, p.directory, p.name, p.created_at,
             COUNT(s.id) AS session_count,
             MAX(s.last_active_at) AS last_active_at
      FROM projects p
      LEFT JOIN sessions s ON s.project_id = p.id
      GROUP BY p.id
      ORDER BY COALESCE(MAX(s.last_active_at), p.created_at) DESC
    `),
    listProjectSessions: db.prepare<[string], SessionSummary>(`
      SELECT s.id, s.project_id, s.title, s.created_at, s.last_active_at,
             (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count
      FROM sessions s
      WHERE s.project_id = ?
      ORDER BY s.last_active_at DESC
    `),
    deleteEventsBySession: db.prepare<[string]>(
      'DELETE FROM events WHERE session_id = ?',
    ),
    deleteSession: db.prepare<[string]>(
      'DELETE FROM sessions WHERE id = ?',
    ),
    deleteSessionsByProject: db.prepare<[string]>(
      'DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)',
    ),
    deleteAllProjectSessions: db.prepare<[string]>(
      'DELETE FROM sessions WHERE project_id = ?',
    ),
    deleteProject: db.prepare<[string]>(
      'DELETE FROM projects WHERE id = ?',
    ),
  };

  const lastActiveCache = new Map<string, number>();

  const upsertSessionTxn = db.transaction(
    (
      sessionId: string,
      directory: string,
      title: string | undefined,
      claudeSessionId: string | undefined,
      now: number,
    ): { project_id: string; session_id: string; is_new: boolean } => {
      let project = stmts.getProjectByDir.get(directory) as Project | undefined;
      if (!project) {
        const id = hashDirectory(directory);
        const name = basename(directory) || directory;
        stmts.insertProject.run(id, directory, name, now);
        project = { id, directory, name, created_at: now };
      }

      const existing = stmts.getSession.get(sessionId) as Session | undefined;
      if (!existing) {
        stmts.insertSession.run(sessionId, project.id, title ?? null, claudeSessionId ?? null, now, now);
        lastActiveCache.set(sessionId, now);
        return { project_id: project.id, session_id: sessionId, is_new: true };
      }

      if (title && title !== existing.title) {
        stmts.updateSessionTitleAndActive.run(title, now, sessionId);
      } else {
        stmts.updateSessionLastActive.run(now, sessionId);
      }
      lastActiveCache.set(sessionId, now);
      return { project_id: existing.project_id, session_id: sessionId, is_new: false };
    },
  );

  return {
    close() {
      db.close();
    },

    upsertSession(sessionId, directory, title, claudeSessionId, now) {
      return upsertSessionTxn(sessionId, directory, title, claudeSessionId, now);
    },

    insertEvent(sessionId, type, message, context, now) {
      const contextJson = context == null ? null : JSON.stringify(context);
      const info = stmts.insertEvent.run(sessionId, type, message, contextJson, now);
      const id = Number(info.lastInsertRowid);
      this.touchSessionActivity(sessionId, now);
      return {
        id,
        session_id: sessionId,
        type,
        message,
        context: context ?? null,
        created_at: now,
      };
    },

    listProjects() {
      return stmts.listProjects.all() as ProjectSummary[];
    },

    listProjectSessions(projectId) {
      return stmts.listProjectSessions.all(projectId) as SessionSummary[];
    },

    getProjectByDirectory(directory) {
      const row = stmts.getProjectByDir.get(directory) as Project | undefined;
      return row ?? null;
    },

    getProjectById(id) {
      const row = stmts.getProjectById.get(id) as Project | undefined;
      return row ?? null;
    },

    getSession(sessionId) {
      const row = stmts.getSession.get(sessionId) as Session | undefined;
      return row ?? null;
    },

    getLatestSessionEvents(sessionId, limit) {
      const rows = stmts.latestEvents.all(sessionId, limit + 1) as EventRow[];
      const has_more = rows.length > limit;
      const sliced = has_more ? rows.slice(0, limit) : rows;
      const events = sliced.map(rowToEvent);
      return {
        events,
        has_more,
        oldest_event_id: events.length > 0 ? events[events.length - 1].id : null,
      };
    },

    getSessionEventsBefore(sessionId, beforeId, limit) {
      const rows = stmts.eventsBefore.all(sessionId, beforeId, limit + 1) as EventRow[];
      const has_more = rows.length > limit;
      const sliced = has_more ? rows.slice(0, limit) : rows;
      const events = sliced.map(rowToEvent);
      return {
        events,
        has_more,
        oldest_event_id: events.length > 0 ? events[events.length - 1].id : null,
      };
    },

    getSessionEventsPage(sessionId, page, pageSize) {
      const { cnt: total } = stmts.countEvents.get(sessionId) as { cnt: number };
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.max(1, Math.min(page, totalPages));
      const offset = (safePage - 1) * pageSize;
      const rows = stmts.eventsPage.all(sessionId, pageSize, offset) as EventRow[];
      return {
        events: rows.map(rowToEvent),
        total,
        page: safePage,
        totalPages,
      };
    },

    setSessionTitle(sessionId, title) {
      const info = stmts.setSessionTitle.run(title, sessionId);
      return info.changes > 0;
    },

    touchSessionActivity(sessionId, now) {
      const last = lastActiveCache.get(sessionId) ?? 0;
      if (now - last < DEBOUNCE_MS) return;
      stmts.updateSessionLastActive.run(now, sessionId);
      lastActiveCache.set(sessionId, now);
    },

    deleteSession(sessionId) {
      const txn = db.transaction(() => {
        stmts.deleteEventsBySession.run(sessionId);
        const info = stmts.deleteSession.run(sessionId);
        lastActiveCache.delete(sessionId);
        return info.changes > 0;
      });
      return txn();
    },

    deleteProject(projectId) {
      const txn = db.transaction(() => {
        stmts.deleteSessionsByProject.run(projectId);
        stmts.deleteAllProjectSessions.run(projectId);
        const info = stmts.deleteProject.run(projectId);
        return info.changes > 0;
      });
      return txn();
    },
  };
}
