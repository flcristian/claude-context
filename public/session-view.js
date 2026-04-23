// Session view: paginated event display with WebSocket live updates.

import { api, connectSessionWs } from '/api.js';

const EVENT_LIST = () => document.getElementById('event-list');
const CONTAINER = () => document.getElementById('event-container');
const EMPTY = () => document.getElementById('empty-state');
const PAGER = () => document.getElementById('pager');

const TYPE_LABELS = {
  decision: 'DECISION',
  action: 'ACTION',
  note: 'NOTE',
  question: 'QUESTION',
};

function fmtTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return `${hh}:${mm}:${ss}`;
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${mo}-${day} ${hh}:${mm}`;
}

function renderEventNode(event) {
  const el = document.createElement('article');
  el.className = 'event';
  el.dataset.type = event.type;
  el.dataset.id = String(event.id);

  const typeEl = document.createElement('div');
  typeEl.className = 'event-type';
  typeEl.textContent = TYPE_LABELS[event.type] ?? event.type.toUpperCase();

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = fmtTime(event.created_at);
  timeEl.title = new Date(event.created_at).toLocaleString();

  const msgEl = document.createElement('div');
  msgEl.className = 'event-message';
  msgEl.textContent = event.message;

  el.appendChild(typeEl);
  el.appendChild(timeEl);
  el.appendChild(msgEl);

  if (event.context != null) {
    const details = document.createElement('details');
    details.className = 'event-context';
    const summary = document.createElement('summary');
    summary.textContent = 'context';
    const pre = document.createElement('pre');
    try {
      pre.textContent = JSON.stringify(event.context, null, 2);
    } catch {
      pre.textContent = String(event.context);
    }
    details.appendChild(summary);
    details.appendChild(pre);
    el.appendChild(details);
  }

  return el;
}

export class SessionView {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.currentPage = 1;
    this.totalPages = 1;
    this.total = 0;
    this.ws = null;
    this.destroyed = false;

    this.container = CONTAINER();
    this.list = EVENT_LIST();
    this.empty = EMPTY();
    this.pager = PAGER();
  }

  async init() {
    this.list.replaceChildren();
    this.empty.hidden = true;
    this.pager.hidden = true;

    const data = await this.loadPage(1);
    if (!data) return null;

    this.ws = connectSessionWs(this.sessionId, (event) => {
      this.onLiveEvent(event);
    });

    return data;
  }

  async loadPage(page) {
    this.list.replaceChildren();
    this.container.scrollTop = 0;

    let data;
    try {
      data = await api.getSession(this.sessionId, page);
    } catch (err) {
      const note = document.createElement('div');
      note.className = 'loading-marker';
      note.textContent = `failed to load session: ${err.message}`;
      this.list.appendChild(note);
      return null;
    }

    if (this.destroyed) return data;

    this.currentPage = data.page;
    this.totalPages = data.totalPages;
    this.total = data.total;

    const frag = document.createDocumentFragment();
    for (const e of data.events) {
      frag.appendChild(renderEventNode(e));
    }
    this.list.appendChild(frag);

    this.empty.hidden = data.events.length > 0;
    this.renderPager();

    return data;
  }

  renderPager() {
    if (this.totalPages <= 1) {
      this.pager.hidden = true;
      return;
    }

    this.pager.hidden = false;
    this.pager.replaceChildren();

    const prev = document.createElement('button');
    prev.className = 'pager-btn';
    prev.textContent = '← Newer';
    prev.disabled = this.currentPage <= 1;
    prev.addEventListener('click', () => this.loadPage(this.currentPage - 1));

    const info = document.createElement('span');
    info.className = 'pager-info';
    info.textContent = `Page ${this.currentPage} of ${this.totalPages}`;

    const next = document.createElement('button');
    next.className = 'pager-btn';
    next.textContent = 'Older →';
    next.disabled = this.currentPage >= this.totalPages;
    next.addEventListener('click', () => this.loadPage(this.currentPage + 1));

    this.pager.appendChild(prev);
    this.pager.appendChild(info);
    this.pager.appendChild(next);
  }

  onLiveEvent(event) {
    if (this.currentPage === 1) {
      this.total++;
      const maxPerPage = 10;
      if (this.list.children.length >= maxPerPage) {
        this.list.lastElementChild.remove();
      }
      this.list.prepend(renderEventNode(event));
      this.totalPages = Math.max(1, Math.ceil(this.total / maxPerPage));
      if (!this.empty.hidden) this.empty.hidden = true;
      this.renderPager();
    } else {
      this.total++;
      this.totalPages = Math.max(1, Math.ceil(this.total / 10));
      this.renderPager();
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.ws) this.ws.close();
    this.list.replaceChildren();
    this.pager.hidden = true;
    this.pager.replaceChildren();
  }
}
