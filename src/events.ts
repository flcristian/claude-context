import type { EventRecord } from './types.js';

export type EventBusListener = (event: EventRecord) => void;

export interface GlobalEvent {
  kind: string;
  [key: string]: unknown;
}
export type GlobalBusListener = (event: GlobalEvent) => void;

export interface EventBus {
  emit(sessionId: string, event: EventRecord): void;
  subscribe(sessionId: string, cb: EventBusListener): () => void;
  emitGlobal(event: GlobalEvent): void;
  subscribeGlobal(cb: GlobalBusListener): () => void;
}

export function createEventBus(): EventBus {
  const subs = new Map<string, Set<EventBusListener>>();
  const globalSubs = new Set<GlobalBusListener>();

  return {
    emit(sessionId, event) {
      const set = subs.get(sessionId);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(event);
        } catch (err) {
          console.error('[events] listener threw:', err);
        }
      }
    },

    subscribe(sessionId, cb) {
      let set = subs.get(sessionId);
      if (!set) {
        set = new Set();
        subs.set(sessionId, set);
      }
      set.add(cb);
      return () => {
        const s = subs.get(sessionId);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) subs.delete(sessionId);
      };
    },

    emitGlobal(event) {
      for (const cb of globalSubs) {
        try {
          cb(event);
        } catch (err) {
          console.error('[events] global listener threw:', err);
        }
      }
    },

    subscribeGlobal(cb) {
      globalSubs.add(cb);
      return () => {
        globalSubs.delete(cb);
      };
    },
  };
}
