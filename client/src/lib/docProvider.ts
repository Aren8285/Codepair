import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { currentConnectionId } from './connection';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_META = 2;

export type ConnectionState = 'connecting' | 'connected' | 'synced' | 'reconnecting' | 'offline';

export interface PresenceUser {
  name: string;
  color: string;
}

export type DocMeta =
  | { type: 'saved'; savedAt: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'denied'; reason: string }
  | { type: 'ready'; mode: 'read-only' | 'read-write'; savedAt: number }
  | { type: 'external'; conflict: boolean; message: string }
  | { type: 'pong' };

interface ProviderOptions {
  token: string;
  roomId: string;
  path: string;
  user: PresenceUser;
  onStatus: (state: ConnectionState) => void;
  onMeta: (meta: DocMeta) => void;
  onFatal: (reason: string, code: number) => void;
  /** Local edits were applied and are waiting for the debounced save. */
  onDirty?: () => void;
}

/**
 * 4410 is the Host moving this session to a different project: permanent, never
 * retried, because the old root is gone. 4425/4429 mean this tab has no seat
 * any more (waiting room, declined, removed): retrying only spins. Other codes
 * cover malformed frames, denied access, a missing file, a replaced session and
 * an oversized document.
 */
const PERMANENT_CLOSE_CODES = new Set([4400, 4403, 4404, 4409, 4410, 4413, 4425, 4429]);
const MAX_BACKOFF_MS = 8_000;

/**
 * WebSocket transport for one Yjs document. The server relays binary frames
 * using the y-protocols sync and awareness messages. Local edits are applied
 * immediately and remain in memory while offline; reconnection performs a
 * full state-vector exchange, so CRDT updates merge rather than overwrite.
 */
export class DocProvider {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: awarenessProtocol.Awareness;
  readonly localOrigin = this;

  private socket: WebSocket | undefined;
  private destroyed = false;
  private attempts = 0;
  private reconnectTimer: number | undefined;
  private state: ConnectionState = 'connecting';
  private readonly options: ProviderOptions;
  private readonly onlineHandler = () => {
    if (this.destroyed || this.state === 'synced') return;
    this.clearReconnect();
    this.connect();
  };

  constructor(options: ProviderOptions) {
    this.options = options;
    this.text = this.doc.getText('content');
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalStateField('user', options.user);
    this.awareness.setLocalStateField('file', options.path);

    this.doc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
    window.addEventListener('online', this.onlineHandler);
    this.connect();
  }

  requestSave(): void {
    this.sendMeta({ type: 'flush' });
  }

  destroy(): void {
    this.destroyed = true;
    this.clearReconnect();
    window.removeEventListener('online', this.onlineHandler);
    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    if (this.socket) {
      const socket = this.socket;
      this.socket = undefined;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, 'Closing tab.');
      } catch {
        // ignore
      }
    }
    this.awareness.destroy();
    this.doc.destroy();
  }

  private connect(): void {
    if (this.destroyed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/doc?path=${encodeURIComponent(this.options.path)}&cid=${encodeURIComponent(currentConnectionId())}&room=${encodeURIComponent(this.options.roomId)}`;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(url, ['codepair', this.options.token]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || this.destroyed) return;
      this.setState('connected');
      this.sendSyncStep1();
      this.sendAwareness();
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket || this.destroyed) return;
      const data = event.data;
      if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) return;
      this.handleMessage(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    };

    socket.onerror = () => {
      // A close event follows and drives the reconnect policy.
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.destroyed) return;
      this.clearRemoteAwareness();
      if (PERMANENT_CLOSE_CODES.has(event.code)) {
        this.setState('offline');
        this.options.onFatal(event.reason || 'The document connection was closed.', event.code);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handleMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
      if (syncType === syncProtocol.messageYjsSyncStep2) {
        this.attempts = 0;
        this.setState('synced');
      }
      return;
    }

    if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this);
      return;
    }

    if (messageType === MESSAGE_META) {
      try {
        const payload = JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder))) as DocMeta;
        if (payload && typeof payload.type === 'string') this.options.onMeta(payload);
      } catch {
        // Ignore malformed control frames; the document data is unaffected.
      }
    }
  }

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Remote updates are applied with `this` as the origin and must not echo.
    if (origin === this || this.destroyed) return;
    this.options.onDirty?.();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  };

  private readonly handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this || this.destroyed) return;
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    if (changed.length === 0) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
    );
    this.send(encoding.toUint8Array(encoder));
  };

  private sendSyncStep1(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(encoding.toUint8Array(encoder));
  }

  private sendAwareness(): void {
    if (!this.awareness.getLocalState()) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.send(encoding.toUint8Array(encoder));
  }

  private sendMeta(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_META);
    encoding.writeVarUint8Array(encoder, new TextEncoder().encode(JSON.stringify(payload)));
    this.send(encoding.toUint8Array(encoder));
  }

  private clearRemoteAwareness(): void {
    const remote = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (remote.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, remote, this);
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.attempts += 1;
    this.setState('reconnecting');
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempts - 1, 5));
    const delay = base + Math.floor(Math.random() * 250);
    this.clearReconnect();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state || this.destroyed) return;
    this.state = state;
    this.options.onStatus(state);
  }

  private send(data: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(data);
  }
}
