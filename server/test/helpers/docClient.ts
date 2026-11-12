import WebSocket from 'ws';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_META = 2;

export interface DocClientOptions {
  wsUrl: string;
  token: string;
  path: string;
  /** Optional per-tab id; interview replay requires the same id as consent. */
  connectionId?: string;
}

export class TestDocClient {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: awarenessProtocol.Awareness;
  readonly metas: Array<Record<string, unknown>> = [];
  synced = false;

  private socket: WebSocket | undefined;
  private readonly syncWaiters: Array<() => void> = [];
  private readonly options: DocClientOptions;

  constructor(options: DocClientOptions) {
    this.options = options;
    this.text = this.doc.getText('content');
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      this.sendSync(update);
    });
    this.awareness.on(
      'update',
      (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === 'remote') return;
        const changed = [...changes.added, ...changes.updated, ...changes.removed];
        if (changed.length === 0) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.send(encoding.toUint8Array(encoder));
      },
    );
  }

  static async connect(options: DocClientOptions): Promise<TestDocClient> {
    const client = new TestDocClient(options);
    await client.open();
    await client.waitForSync();
    return client;
  }

  async open(): Promise<void> {
    const query = `?path=${encodeURIComponent(this.options.path)}` +
      (this.options.connectionId ? `&cid=${encodeURIComponent(this.options.connectionId)}` : '');
    const socket = new WebSocket(
      `${this.options.wsUrl}${query}`,
      ['codepair', this.options.token],
    );
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('close', (code) => reject(new Error(`doc socket closed: ${code}`)));
    });

    socket.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data))
            : new Uint8Array(data as Buffer);
      this.handleMessage(bytes);
    });

    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(step1, this.doc);
    this.send(encoding.toUint8Array(step1));

    this.awareness.setLocalStateField('user', { name: 'Tester', color: '#3366ff' });
    const awareness = encoding.createEncoder();
    encoding.writeVarUint(awareness, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awareness,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.send(encoding.toUint8Array(awareness));
  }

  async waitForSync(timeoutMs = 5000): Promise<void> {
    if (this.synced) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for document sync.')), timeoutMs);
      this.syncWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Simulate a dropped connection while keeping the local CRDT state. */
  closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.synced = false;
    socket?.removeAllListeners();
    socket?.terminate();
  }

  async reconnect(): Promise<void> {
    this.closeSocket();
    await this.open();
    await this.waitForSync();
  }

  setUser(name: string, color: string): void {
    this.awareness.setLocalStateField('user', { name, color });
  }

  destroy(): void {
    this.closeSocket();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private handleMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'remote');
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
      if (syncType === syncProtocol.messageYjsSyncStep2) {
        this.synced = true;
        for (const resolve of this.syncWaiters.splice(0)) resolve();
      }
      return;
    }
    if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), 'remote');
      return;
    }
    if (messageType === MESSAGE_META) {
      try {
        this.metas.push(JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder))));
      } catch {
        // ignore malformed meta
      }
    }
  }

  private sendSync(update: Uint8Array): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  }

  private send(data: Uint8Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data);
  }
}
