// Fetch + WebSocket client with reconnect.

async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${msg}`);
  }
  return res.json();
}

export const api = {
  listProjects() {
    return jsonFetch('/api/projects');
  },
  listProjectSessions(projectId) {
    return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
  },
  getSession(sessionId, page = 1) {
    const params = page > 1 ? `?page=${page}` : '';
    return jsonFetch(`/api/sessions/${encodeURIComponent(sessionId)}${params}`);
  },
  getEventsBefore(sessionId, beforeId, limit = 10) {
    const params = new URLSearchParams({
      before: String(beforeId),
      limit: String(limit),
    });
    return jsonFetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?${params}`,
    );
  },
  setSessionTitle(sessionId, title) {
    return jsonFetch('/internal/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'set_session_title',
        args: { session_id: sessionId, title },
      }),
    });
  },
  deleteSession(sessionId) {
    return jsonFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  },
  deleteProject(projectId) {
    return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    });
  },
};

// ---- Global WebSocket (sidebar updates) ----

export function connectGlobalWs(onEvent) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;

  function scheduleReconnect() {
    if (closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** attempt);
    attempt++;
    reconnectTimer = setTimeout(open, delay);
  }

  function open() {
    reconnectTimer = null;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      attempt = 0;
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.type === 'global' && msg.event) {
          onEvent(msg.event);
        }
      } catch {
        /* ignore malformed */
      }
    });
    ws.addEventListener('close', () => {
      if (!closed) scheduleReconnect();
    });
    ws.addEventListener('error', () => {});
  }

  open();

  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// ---- Session WebSocket with reconnect ----

export function connectSessionWs(sessionId, onEvent) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;

  function scheduleReconnect() {
    if (closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** attempt);
    attempt++;
    reconnectTimer = setTimeout(open, delay);
  }

  function open() {
    reconnectTimer = null;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?session_id=${encodeURIComponent(sessionId)}`;
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      attempt = 0;
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.type === 'event' && msg.event) {
          onEvent(msg.event);
        }
      } catch {
        /* ignore malformed */
      }
    });
    ws.addEventListener('close', () => {
      if (!closed) scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // 'close' will fire next; rely on that path.
    });
  }

  open();

  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
