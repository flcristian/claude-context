export type EventType = 'decision' | 'action' | 'note' | 'question';

export interface Project {
  id: string;
  directory: string;
  name: string;
  created_at: number;
}

export interface ProjectSummary extends Project {
  session_count: number;
  last_active_at: number | null;
}

export interface Session {
  id: string;
  project_id: string;
  title: string | null;
  claude_session_id: string | null;
  created_at: number;
  last_active_at: number;
}

export interface SessionSummary extends Session {
  event_count: number;
}

export interface EventRecord {
  id: number;
  session_id: string;
  type: EventType;
  message: string;
  context: unknown | null;
  created_at: number;
}

export interface RegisterSessionArgs {
  session_id?: string;
  directory: string;
  title?: string;
  claude_session_id?: string;
}

export interface RegisterSessionResult {
  project_id: string;
  session_id: string;
  is_new: boolean;
}

export interface LogEventArgs {
  session_id: string;
  message: string;
  context?: unknown;
}

export interface LogEventResult {
  event_id: number;
}

export interface GetSessionHistoryArgs {
  session_id: string;
  before_event_id?: number;
  limit?: number;
}

export interface GetSessionHistoryResult {
  events: EventRecord[];
  has_more: boolean;
  oldest_event_id: number | null;
}

export interface GetProjectSessionsArgs {
  directory: string;
}

export interface GetProjectSessionsResult {
  project: Project | null;
  sessions: SessionSummary[];
}

export interface SetSessionTitleArgs {
  session_id: string;
  title: string;
}

export interface SetSessionTitleResult {
  ok: boolean;
}

export type ToolName =
  | 'register_session'
  | 'log_decision'
  | 'log_action'
  | 'log_note'
  | 'log_question'
  | 'get_session_history'
  | 'get_project_sessions'
  | 'set_session_title';
