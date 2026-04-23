// Bootstrap: path-based client-side routing, sidebar rendering, session swap.

import { api, connectGlobalWs } from '/api.js';
import { SessionView } from '/session-view.js';

const state = {
  projects: [],
  expanded: new Set(), // project IDs
  currentSessionId: null,
  view: null,
};

// ---- Modal ----

function showConfirmModal(message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    const msgEl = document.getElementById('modal-message');
    const cancelBtn = document.getElementById('modal-cancel');
    const confirmBtn = document.getElementById('modal-confirm');

    msgEl.textContent = message;
    overlay.hidden = false;
    confirmBtn.focus();

    function cleanup(result) {
      overlay.hidden = true;
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }

    function onCancel() { cleanup(false); }
    function onConfirm() { cleanup(true); }
    function onOverlay(e) { if (e.target === overlay) cleanup(false); }
    function onKey(e) { if (e.key === 'Escape') cleanup(false); }

    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);
  });
}

// ---- Utilities ----

const RELATIVE = [
  [60, 's'],
  [60, 'm'],
  [24, 'h'],
  [7, 'd'],
  [4.345, 'w'],
  [12, 'mo'],
  [Number.POSITIVE_INFINITY, 'y'],
];

function relativeTime(ts) {
  if (!ts) return '';
  let delta = (Date.now() - ts) / 1000;
  if (delta < 5) return 'now';
  for (const [step, unit] of RELATIVE) {
    if (delta < step) return `${Math.floor(delta)}${unit} ago`;
    delta /= step;
  }
  return '';
}

function truncatePath(p, max = 48) {
  if (!p) return '';
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

// ---- Routing ----

function getSessionIdFromPath() {
  const m = location.pathname.match(/^\/session\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function navigateToSession(sessionId, push = true) {
  const target = `/session/${encodeURIComponent(sessionId)}`;
  if (push && location.pathname !== target) {
    history.pushState({ sessionId }, '', target);
  }
  loadSession(sessionId);
}

window.addEventListener('popstate', () => {
  const id = getSessionIdFromPath();
  if (id) loadSession(id);
});

// ---- Sidebar ----

async function loadProjects() {
  try {
    state.projects = await api.listProjects();
  } catch (err) {
    console.error('failed to load projects', err);
    state.projects = [];
  }
  renderSidebar();
}

function renderSidebar() {
  const root = document.getElementById('project-list');
  root.replaceChildren();

  if (state.projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'loading-marker';
    empty.style.padding = '12px 14px';
    empty.textContent = 'no projects yet';
    root.appendChild(empty);
    return;
  }

  for (const p of state.projects) {
    const el = document.createElement('div');
    el.className = 'project';
    if (state.expanded.has(p.id)) el.classList.add('expanded');

    const header = document.createElement('div');
    header.className = 'project-header';
    header.title = p.directory;

    const left = document.createElement('span');
    const chevron = document.createElement('span');
    chevron.className = 'project-chevron';
    chevron.textContent = '▸';
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = p.name;
    left.appendChild(chevron);
    left.appendChild(name);

    const right = document.createElement('span');
    right.className = 'project-right';

    const count = document.createElement('span');
    count.className = 'project-count';
    count.textContent = String(p.session_count ?? 0);

    const deleteProjectBtn = document.createElement('button');
    deleteProjectBtn.className = 'delete-btn delete-project-btn';
    deleteProjectBtn.title = 'Delete project';
    deleteProjectBtn.textContent = '×';
    deleteProjectBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await showConfirmModal(`Delete project "${p.name}" and all its sessions?`)) return;
      try {
        await api.deleteProject(p.id);
        if (state.currentSessionId) {
          const sessions = state.projects.find(pr => pr.id === p.id);
          if (sessions) {
            state.currentSessionId = null;
            history.pushState(null, '', '/');
            setTopbar({ path: '', title: '', sessionId: null });
            const container = document.getElementById('event-container');
            const eventList = document.getElementById('event-list');
            eventList.replaceChildren();
            document.getElementById('empty-state').hidden = false;
            if (state.view) { state.view.destroy(); state.view = null; }
          }
        }
        state.expanded.delete(p.id);
        await loadProjects();
      } catch (err) {
        console.error('failed to delete project', err);
      }
    });

    right.appendChild(count);
    right.appendChild(deleteProjectBtn);

    header.appendChild(left);
    header.appendChild(right);

    const list = document.createElement('div');
    list.className = 'project-sessions';

    header.addEventListener('click', async () => {
      if (state.expanded.has(p.id)) {
        state.expanded.delete(p.id);
        el.classList.remove('expanded');
        return;
      }
      state.expanded.add(p.id);
      el.classList.add('expanded');
      await renderProjectSessions(p.id, list);
    });

    if (state.expanded.has(p.id)) {
      // Lazily render if already expanded.
      renderProjectSessions(p.id, list);
    }

    el.appendChild(header);
    el.appendChild(list);
    root.appendChild(el);
  }
}

async function renderProjectSessions(projectId, container) {
  container.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'loading-marker';
  loading.textContent = 'loading…';
  container.appendChild(loading);

  let sessions = [];
  try {
    sessions = await api.listProjectSessions(projectId);
  } catch (err) {
    loading.textContent = 'failed to load';
    return;
  }
  container.replaceChildren();

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'loading-marker';
    empty.textContent = 'no sessions';
    container.appendChild(empty);
    return;
  }

  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'session-item';
    row.dataset.sessionId = s.id;
    if (s.id === state.currentSessionId) row.classList.add('active');

    const title = document.createElement('div');
    title.className = 'session-title';
    if (s.title && s.title.length > 0) {
      title.textContent = s.title;
    } else {
      title.textContent = s.id.slice(0, 8);
      title.classList.add('untitled');
    }

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = `${s.event_count} events · ${relativeTime(s.last_active_at)}`;

    const deleteSessionBtn = document.createElement('button');
    deleteSessionBtn.className = 'delete-btn delete-session-btn';
    deleteSessionBtn.title = 'Delete session';
    deleteSessionBtn.textContent = '×';
    deleteSessionBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const label = s.title || s.id.slice(0, 8);
      if (!await showConfirmModal(`Delete session "${label}"?`)) return;
      try {
        await api.deleteSession(s.id);
        if (state.currentSessionId === s.id) {
          state.currentSessionId = null;
          if (state.view) { state.view.destroy(); state.view = null; }
          history.pushState(null, '', '/');
          setTopbar({ path: '', title: '', sessionId: null });
          const eventList = document.getElementById('event-list');
          eventList.replaceChildren();
          document.getElementById('empty-state').hidden = false;
        }
        await loadProjects();
        if (state.expanded.has(projectId)) {
          const list = document.querySelector(
            `.project.expanded .project-sessions`,
          );
          if (list) await renderProjectSessions(projectId, list);
        }
      } catch (err) {
        console.error('failed to delete session', err);
      }
    });

    row.appendChild(title);
    row.appendChild(meta);
    row.appendChild(deleteSessionBtn);
    row.addEventListener('click', (e) => {
      e.preventDefault();
      navigateToSession(s.id);
    });
    container.appendChild(row);
  }
}

function highlightActiveSession(sessionId) {
  document.querySelectorAll('.session-item.active').forEach((el) => {
    el.classList.remove('active');
  });
  if (!sessionId) return;
  const row = document.querySelector(
    `.session-item[data-session-id="${CSS.escape(sessionId)}"]`,
  );
  if (row) row.classList.add('active');
}

// ---- Session swap ----

async function loadSession(sessionId) {
  state.currentSessionId = sessionId;
  highlightActiveSession(sessionId);

  if (state.view) {
    state.view.destroy();
    state.view = null;
  }

  state.view = new SessionView(sessionId);
  const data = await state.view.init();

  if (!data) {
    setTopbar({ path: '', title: '', sessionId });
    return;
  }

  setTopbar({
    path: data.project?.directory ?? '',
    title: data.session?.title ?? '',
    sessionId,
  });

  // Expand this project in the sidebar if it isn't already.
  if (data.project) {
    if (!state.expanded.has(data.project.id)) {
      state.expanded.add(data.project.id);
      await loadProjects();
      highlightActiveSession(sessionId);
    } else {
      // Even if already expanded, we may need to highlight a newly-added session.
      highlightActiveSession(sessionId);
    }
  }
}

// ---- Top bar ----

function setTopbar({ path, title, sessionId }) {
  const pathEl = document.getElementById('topbar-path');
  const titleEl = document.getElementById('session-title');
  pathEl.textContent = truncatePath(path);
  pathEl.title = path;

  titleEl.value = title ?? '';
  titleEl.dataset.lastSaved = title ?? '';
  titleEl.disabled = !sessionId;
}

function wireTopbar() {
  const titleEl = document.getElementById('session-title');
  titleEl.addEventListener('blur', async () => {
    const sessionId = state.currentSessionId;
    if (!sessionId) return;
    const value = titleEl.value.trim();
    if (value === (titleEl.dataset.lastSaved ?? '')) return;
    try {
      await api.setSessionTitle(sessionId, value);
      titleEl.dataset.lastSaved = value;
      // Refresh sidebar title in-place.
      await loadProjects();
      highlightActiveSession(sessionId);
    } catch (err) {
      console.error('failed to save title', err);
    }
  });
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleEl.blur();
    }
  });

  const pathEl = document.getElementById('topbar-path');
  pathEl.addEventListener('click', async () => {
    const fullPath = pathEl.title;
    if (!fullPath) return;
    try {
      await navigator.clipboard.writeText(fullPath);
      pathEl.classList.add('copied');
      setTimeout(() => pathEl.classList.remove('copied'), 1200);
    } catch (err) {
      console.error('clipboard failed', err);
    }
  });

}

// ---- Boot ----

async function boot() {
  wireTopbar();
  await loadProjects();

  connectGlobalWs((event) => {
    if (event.kind === 'session_created' || event.kind === 'session_deleted' || event.kind === 'project_deleted') {
      loadProjects();
    }
  });

  const id = getSessionIdFromPath();
  if (id) {
    await loadSession(id);
  } else {
    setTopbar({ path: '', title: '', sessionId: null });
  }
}

boot();
