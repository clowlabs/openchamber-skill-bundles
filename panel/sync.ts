// Cross-frame sync ping over window.postMessage (sandboxed iframes have opaque null origins).
import { randomToken } from '../shared/panel/panel-lock';

const CHANNEL = 'skill-bundles.sync';
const VERSION = 1;

const sender = randomToken();

export type SyncMessage = {
  channel: typeof CHANNEL;
  v: typeof VERSION;
  sender: string;
  full?: true;
};

/** Notify sibling frames in the same parent window that skill-bundles files changed on disk. */
export function broadcastChange(opts?: { full?: boolean }, win?: Window) {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!w) return;
  const msg: SyncMessage = {
    channel: CHANNEL,
    v: VERSION,
    sender,
    ...(opts?.full ? { full: true } : {}),
  };
  try {
    const parent = w.parent;
    if (!parent || parent === w) return;
    const frames = parent.frames;
    const len = frames.length;
    for (let i = 0; i < len; i++) {
      try {
        const f = frames[i];
        if (f && f !== w) f.postMessage(msg, '*');
      } catch {
        // Cross-origin or unloaded sibling frame; ignore.
      }
    }
  } catch {
    // Parent frame access blocked; polling will still catch changes.
  }
}

/** Listen for cross-frame sync pings from other frames, coalescing bursts within a microtask. */
export function listenChanges(onChange: (opts: { full: boolean }) => void, win?: Window): () => void {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!w) return () => {};
  let active = true;
  let scheduled = false;
  let pendingFull = false;
  const onMessage = (e: MessageEvent) => {
    const d = e.data as unknown;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return;
    const m = d as Record<string, unknown>;
    if (m.channel !== CHANNEL || m.v !== VERSION) return;
    if (typeof m.sender !== 'string' || m.sender === sender) return;
    if (m.full === true) pendingFull = true;
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const full = pendingFull;
        pendingFull = false;
        if (active) onChange({ full });
      });
    }
  };
  w.addEventListener('message', onMessage);
  return () => {
    active = false;
    w.removeEventListener('message', onMessage);
  };
}
