import type { WebSocket } from 'ws';

export const KICK_CLOSE_CODE = 4429;
export const KICK_CLOSE_REASON = 'The host removed you from this session.';

/**
 * Daemon-level map of connectionId → its live sockets.
 *
 * Kick closes every surface a tab has open at once (doc, terminal, signal) and
 * must keep working after a root switch, so this registry lives outside the
 * per-session lobby.
 */
export class ConnectionRegistry {
  private readonly byConnection = new Map<string, Set<WebSocket>>();

  /** Track a socket; the returned function unregisters it. */
  track(connectionId: string, socket: WebSocket): () => void {
    let set = this.byConnection.get(connectionId);
    if (!set) {
      set = new Set();
      this.byConnection.set(connectionId, set);
    }
    set.add(socket);
    return () => {
      const current = this.byConnection.get(connectionId);
      if (!current) return;
      current.delete(socket);
      if (current.size === 0) this.byConnection.delete(connectionId);
    };
  }

  count(connectionId: string): number {
    return this.byConnection.get(connectionId)?.size ?? 0;
  }

  /** Close every socket for one connection; returns how many were closed. */
  close(connectionId: string, code = KICK_CLOSE_CODE, reason = KICK_CLOSE_REASON): number {
    const sockets = this.byConnection.get(connectionId);
    if (!sockets) return 0;
    this.byConnection.delete(connectionId);
    let closed = 0;
    for (const socket of sockets) {
      try {
        socket.close(code, reason);
      } catch {
        socket.terminate();
      }
      closed += 1;
    }
    return closed;
  }

  clear(): void {
    this.byConnection.clear();
  }
}
