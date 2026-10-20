import fsp from 'node:fs/promises';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { atomicWriteFile, FileService } from '../files/fileService.js';
import { AppError } from '../errors.js';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_META = 2;

const INIT_ORIGIN = Symbol('codepair-init');
const EXTERNAL_ORIGIN = Symbol('codepair-external');
const IDLE_CLOSE_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const DISK_POLL_MS = 1_000;
const WS_OPEN = 1;

/** Identity of the file on disk, used to notice writes we did not make. */
interface DiskSignature {
  ino: number;
  mtimeMs: number;
  size: number;
}

type MetaMessage =
  | { type: 'ready'; mode: 'read-only' | 'read-write'; savedAt: number }
  | { type: 'saved'; savedAt: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'denied'; reason: string }
  | { type: 'external'; conflict: boolean; message: string }
  | { type: 'closed'; reason: string };

class DocConnection {
  alive = true;
  readonly awarenessIds = new Set<number>();

  constructor(
    readonly socket: WebSocket,
    readonly readOnly: boolean,
  ) {}
}

interface HubOptions {
  saveDebounceMs: number;
  idleCloseMs?: number;
  logger?: Pick<Console, 'error' | 'warn'>;
}

export class DocumentHub {
  private readonly sessions = new Map<string, DocSession>();
  private readonly pending = new Map<string, Promise<DocSession>>();
  private readonly saveDebounceMs: number;
  private readonly idleCloseMs: number;
  private readonly logger: Pick<Console, 'error' | 'warn'>;
  private disposed = false;

  constructor(
    private readonly files: FileService,
    options: HubOptions,
  ) {
    this.saveDebounceMs = options.saveDebounceMs;
    this.idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS;
    this.logger = options.logger ?? console;
  }

  /**
   * Load the document before the HTTP upgrade completes. Without this the
   * browser's first sync packet can arrive while the file is being read and be
   * dropped, leaving the client stuck without a state-vector exchange.
   */
  async prepare(relativePath: string): Promise<void> {
    if (this.disposed) throw new AppError(503, 'SHUTTING_DOWN', 'The server is shutting down.');
    await this.getSession(relativePath);
  }

  /** Attach an upgraded socket to an already prepared document. */
  connect(relativePath: string, socket: WebSocket, readOnly: boolean): void {
    if (this.disposed) {
      socket.close(1001, 'Server is shutting down.');
      return;
    }
    const session = this.sessions.get(relativePath);
    if (!session) {
      socket.close(4404, 'Could not open file.');
      return;
    }
    session.attach(socket, readOnly);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.pending.clear();
    await Promise.all(
      sessions.map(async (session) => {
        session.closeSockets(1001, 'Server is shutting down.');
        await session.dispose({ persist: true });
      }),
    );
  }

  async flushSubtree(relativePath: string): Promise<void> {
    const sessions = this.matchingSessions(relativePath);
    await Promise.all(sessions.map((session) => session.flush()));
  }

  discardSubtree(relativePath: string, reason: string): void {
    for (const session of this.matchingSessions(relativePath)) {
      this.sessions.delete(session.relativePath);
      session.closeSockets(4410, reason);
      void session.dispose({ persist: false });
    }
  }

  private matchingSessions(relativePath: string): DocSession[] {
    const normalized = relativePath.replaceAll('\\', '/').replace(/\/+$/, '');
    return [...this.sessions.values()].filter((session) => {
      if (!normalized) return true;
      return session.relativePath === normalized || session.relativePath.startsWith(`${normalized}/`);
    });
  }

  private async getSession(relativePath: string): Promise<DocSession> {
    const existing = this.sessions.get(relativePath);
    if (existing) {
      existing.cancelIdleClose();
      return existing;
    }
    const pending = this.pending.get(relativePath);
    if (pending) return pending;

    const promise = DocSession.open(this.files, relativePath, {
      saveDebounceMs: this.saveDebounceMs,
      idleCloseMs: this.idleCloseMs,
      maxFileBytes: this.files.maxFileBytes,
      logger: this.logger,
      onIdle: (session) => {
        if (this.sessions.get(session.relativePath) === session) {
          this.sessions.delete(session.relativePath);
        }
      },
    })
      .then((session) => {
        this.sessions.set(session.relativePath, session);
        this.pending.delete(relativePath);
        return session;
      })
      .catch((error: unknown) => {
        this.pending.delete(relativePath);
        throw error;
      });

    this.pending.set(relativePath, promise);
    return promise;
  }
}

interface SessionOptions {
  saveDebounceMs: number;
  idleCloseMs: number;
  maxFileBytes: number;
  logger: Pick<Console, 'error' | 'warn'>;
  onIdle: (session: DocSession) => void;
}

export class DocSession {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: awarenessProtocol.Awareness;
  private readonly connections = new Set<DocConnection>();
  private readonly options: SessionOptions;
  private lastPersisted: string;
  private diskSignature: DiskSignature | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private saveTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;
  lastSavedAt = Date.now();
  lastError: string | undefined;

  private constructor(
    readonly absolutePath: string,
    readonly relativePath: string,
    initialContent: string,
    options: SessionOptions,
  ) {
    this.options = options;
    this.text = this.doc.getText('content');
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.lastPersisted = initialContent;

    this.doc.transact(() => {
      if (initialContent.length > 0) this.text.insert(0, initialContent);
    }, INIT_ORIGIN);

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  static async open(files: FileService, relativePath: string, options: SessionOptions): Promise<DocSession> {
    const file = await files.readTextForDocument(relativePath);
    const session = new DocSession(file.absolute, file.relative, file.content, options);
    session.diskSignature = { ino: file.ino, mtimeMs: file.mtime, size: Buffer.byteLength(file.content) };
    return session;
  }

  /**
   * Watch the file for writes made outside CodePair (an editor, a script, a
   * git checkout). Without conflicts the new content is merged into the shared
   * document so every client sees it; if local edits have not reached disk yet
   * the Host's copy is left alone and clients are told, instead of one side
   * silently overwriting the other.
   */
  private startDiskPoll(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(() => void this.checkDisk(), DISK_POLL_MS);
    this.pollTimer.unref?.();
  }

  private stopDiskPoll(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async checkDisk(): Promise<void> {
    if (this.polling || this.disposed || this.connections.size === 0) return;
    this.polling = true;
    try {
      let stat;
      try {
        stat = await fsp.stat(this.absolutePath);
      } catch {
        this.stopDiskPoll();
        this.broadcastMeta({ type: 'closed', reason: 'This file was removed from the Host.' });
        this.closeSockets(4410, 'This file was removed from the Host.');
        await this.dispose({ persist: false });
        return;
      }
      if (!stat.isFile()) return;
      const signature = { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
      const previous = this.diskSignature;
      if (
        previous &&
        previous.ino === signature.ino &&
        previous.mtimeMs === signature.mtimeMs &&
        previous.size === signature.size
      ) {
        return;
      }
      if (stat.size > this.options.maxFileBytes) return;
      const content = await fsp.readFile(this.absolutePath, 'utf8');
      if (content === this.lastPersisted) {
        this.diskSignature = signature;
        return;
      }
      const editor = this.text.toString();
      if (editor !== this.lastPersisted) {
        // Local edits have not reached disk yet and the Host copy differs from
        // what this session last wrote. Keep both copies and tell the clients
        // instead of silently picking a winner.
        this.diskSignature = signature;
        this.lastPersisted = content;
        this.broadcastMeta({
          type: 'external',
          conflict: true,
          message: `${this.relativePath} changed on the Host while you had unsaved edits. Your version was kept in the editor.`,
        });
        return;
      }
      this.doc.transact(() => {
        if (this.text.length > 0) this.text.delete(0, this.text.length);
        if (content.length > 0) this.text.insert(0, content);
      }, EXTERNAL_ORIGIN);
      this.lastPersisted = content;
      this.diskSignature = signature;
      this.broadcastMeta({
        type: 'external',
        conflict: false,
        message: `${this.relativePath} was updated on the Host.`,
      });
    } catch (error) {
      this.options.logger.warn(
        `[codepair] could not check ${this.relativePath} for external changes: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.polling = false;
    }
  }

  private broadcastMeta(meta: MetaMessage): void {
    for (const connection of this.connections) this.sendMeta(connection.socket, meta);
  }

  attach(socket: WebSocket, readOnly: boolean): void {
    if (this.disposed) {
      socket.close(1001, 'Document closed.');
      return;
    }
    this.cancelIdleClose();
    const connection = new DocConnection(socket, readOnly);
    this.connections.add(connection);
    this.startDiskPoll();

    // Sync handshake: the server sends its state vector, the client answers
    // with the missing operations, and vice versa.
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, this.doc);
    this.send(socket, encoding.toUint8Array(syncEncoder));

    const stateIds = [...this.awareness.getStates().keys()];
    if (stateIds.length > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, stateIds),
      );
      this.send(socket, encoding.toUint8Array(awarenessEncoder));
    }

    this.sendMeta(socket, {
      type: 'ready',
      mode: readOnly ? 'read-only' : 'read-write',
      savedAt: this.lastSavedAt,
    });

    socket.on('message', (data, isBinary) => {
      if (!isBinary) return;
      try {
        this.handleMessage(connection, toUint8Array(data));
      } catch (error) {
        this.options.logger.warn(
          `[codepair] closing ${this.relativePath}: malformed document message (${error instanceof Error ? error.message : 'unknown error'})`,
        );
        connection.socket.close(4400, 'Malformed document message.');
      }
    });
    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('close', () => {
      this.connections.delete(connection);
      const ids = [...connection.awarenessIds];
      if (!this.disposed && ids.length > 0) {
        awarenessProtocol.removeAwarenessStates(this.awareness, ids, 'disconnect');
      }
      if (this.connections.size === 0) {
        this.stopDiskPoll();
        this.scheduleIdleClose();
      }
    });
    socket.on('error', () => {
      // The close handler performs cleanup; avoid unhandled socket errors.
    });

    const heartbeat = setInterval(() => {
      if (!connection.alive) {
        socket.terminate();
        return;
      }
      connection.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, HEARTBEAT_MS);
    socket.once('close', () => clearInterval(heartbeat));
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.persist();
    await this.writeChain;
  }

  async dispose({ persist }: { persist: boolean }): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.saveTimer);
    clearTimeout(this.idleTimer);
    this.stopDiskPoll();
    if (persist) await this.flush();
    await this.writeChain;
    this.awareness.off('update', this.onAwarenessUpdate);
    this.doc.off('update', this.onDocUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }

  closeSockets(code: number, reason: string): void {
    for (const connection of this.connections) {
      try {
        connection.socket.close(code, reason);
      } catch {
        connection.socket.terminate();
      }
    }
    this.connections.clear();
  }

  cancelIdleClose(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleClose(): void {
    if (this.disposed) return;
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      if (this.connections.size > 0 || this.disposed) return;
      this.options.onIdle(this);
      void this.dispose({ persist: true });
    }, this.options.idleCloseMs);
    this.idleTimer.unref?.();
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === INIT_ORIGIN || this.disposed) return;
    if (origin === EXTERNAL_ORIGIN) {
      // Content came *from* the disk; remember it as saved and never write it back.
      this.lastPersisted = this.text.toString();
    }
    // Broadcast immediately, debounce only the disk write.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarUint(encoder, syncProtocol.messageYjsUpdate);
    encoding.writeVarUint8Array(encoder, update);
    const message = encoding.toUint8Array(encoder);
    for (const connection of this.connections) {
      if (connection !== origin && connection.socket.readyState === WS_OPEN) {
        connection.socket.send(message);
      }
    }
    if (origin === EXTERNAL_ORIGIN) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.persist().catch((error: unknown) => {
        this.options.logger.error(`[codepair] failed to save ${this.relativePath}:`, error);
      });
    }, this.options.saveDebounceMs);
    this.saveTimer.unref?.();
  };

  private readonly onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    if (changed.length === 0 || this.disposed) return;
    let source: DocConnection | undefined;
    if (origin instanceof DocConnection) {
      source = origin;
      for (const id of changes.added) source.awarenessIds.add(id);
      for (const id of changes.removed) source.awarenessIds.delete(id);
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    const message = encoding.toUint8Array(encoder);
    for (const connection of this.connections) {
      if (connection !== source && connection.socket.readyState === WS_OPEN) {
        connection.socket.send(message);
      }
    }
  };

  private handleMessage(connection: DocConnection, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const syncType = decoding.readVarUint(decoder);
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncStep1(decoder, encoder, this.doc);
        this.send(connection.socket, encoding.toUint8Array(encoder));
        return;
      }
      if (syncType === syncProtocol.messageYjsSyncStep2) {
        if (connection.readOnly) return;
        syncProtocol.readSyncStep2(decoder, this.doc, connection);
        return;
      }
      if (syncType === syncProtocol.messageYjsUpdate) {
        if (connection.readOnly) {
          this.sendMeta(connection.socket, {
            type: 'denied',
            reason: 'This session is read-only; edits are not applied.',
          });
          return;
        }
        syncProtocol.readUpdate(decoder, this.doc, connection);
        return;
      }
      return;
    }
    if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), connection);
      return;
    }
    if (messageType === MESSAGE_META) {
      // Clients may only send small JSON control messages (ping / explicit save).
      try {
        const raw = decoding.readVarUint8Array(decoder);
        const text = new TextDecoder().decode(raw);
        if (text.length > 2048) return;
        const payload = JSON.parse(text) as { type?: unknown };
        if (payload?.type === 'flush' && !connection.readOnly) {
          void this.flush()
            .then(() => {
              this.lastSavedAt = Date.now();
              this.sendMeta(connection.socket, { type: 'saved', savedAt: this.lastSavedAt });
            })
            .catch((error: unknown) => {
              this.options.logger.error(`[codepair] explicit save failed for ${this.relativePath}:`, error);
            });
        }
      } catch {
        // Malformed control messages are ignored; document messages are validated elsewhere.
      }
    }
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const content = this.text.toString();
      if (content === this.lastPersisted) return;
      try {
        await atomicWriteFile(this.absolutePath, content);
        // Record the signature so our own write is not mistaken for an
        // external change, then let a following debounce catch any remainder.
        try {
          const stat = await fsp.stat(this.absolutePath);
          this.diskSignature = { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
          this.diskSignature = undefined;
        }
        this.lastPersisted = content;
        this.lastSavedAt = Date.now();
        this.lastError = undefined;
        for (const connection of this.connections) {
          this.sendMeta(connection.socket, { type: 'saved', savedAt: this.lastSavedAt });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown write error';
        this.lastError = message;
        this.options.logger.error(`[codepair] write failed for ${this.relativePath}:`, error);
        for (const connection of this.connections) {
          this.sendMeta(connection.socket, {
            type: 'error',
            code: 'SAVE_FAILED',
            message: 'Could not save the file to disk.',
          });
        }
      }
    });
    return this.writeChain;
  }

  private sendMeta(socket: WebSocket, payload: MetaMessage): void {
    try {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_META);
      encoding.writeVarUint8Array(encoder, new TextEncoder().encode(JSON.stringify(payload)));
      this.send(socket, encoding.toUint8Array(encoder));
    } catch {
      // Socket closed mid-send; close handler will clean up.
    }
  }

  private send(socket: WebSocket, message: Uint8Array): void {
    if (socket.readyState === WS_OPEN) socket.send(message);
  }
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return new Uint8Array();
}
