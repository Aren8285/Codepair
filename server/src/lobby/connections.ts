import type { WebSocket } from 'ws';
import { AppError } from '../errors.js';

export const KICK_CLOSE_CODE = 4429;
export const KICK_CLOSE_REASON = 'The host removed you from this session.';

/**
 * Daemon-level map of (room, connectionId) → its live sockets, plus the room a
 * connection id has claimed.
 *
 * A connection id may exist in only one room. It is a tab/session handle, not a
 * credential: a token must still authenticate in the selected room before this
 * map is consulted. Sockets are scoped separately by room, so one kick cannot
 * reach a same-named connection in another room.
 */
export class ConnectionRegistry {
  private readonly byRoom = new Map<string, Map<string, Set<WebSocket>>>();
  private readonly claims = new Map<string, string>();

  /**
   * Bind a connection id to a room. Returns false when it already belongs to a
   * different room, which the caller must turn into a 403.
   */
  claim(connectionId: string, roomId: string): boolean {
    const existing = this.claims.get(connectionId);
    if (existing !== undefined && existing !== roomId) return false;
    this.claims.set(connectionId, roomId);
    return true;
  }

  assertRoom(connectionId: string, roomId: string): void {
    if (!this.claim(connectionId, roomId)) {
      throw new AppError(403, 'ROOM_MISMATCH', 'That connection id belongs to a different room.');
    }
  }

  /** Track a socket; the returned function unregisters it. */
  track(roomId: string, connectionId: string, socket: WebSocket): () => void {
    if (!this.claim(connectionId, roomId)) {
      throw new AppError(403, 'ROOM_MISMATCH', 'That connection id belongs to a different room.');
    }
    let room = this.byRoom.get(roomId);
    if (!room) {
      room = new Map();
      this.byRoom.set(roomId, room);
    }
    let set = room.get(connectionId);
    if (!set) {
      set = new Set();
      room.set(connectionId, set);
    }
    set.add(socket);
    return () => {
      const currentRoom = this.byRoom.get(roomId);
      const current = currentRoom?.get(connectionId);
      if (!current) return;
      current.delete(socket);
      if (current.size === 0) currentRoom?.delete(connectionId);
      if (currentRoom?.size === 0) this.byRoom.delete(roomId);
    };
  }

  count(roomId: string, connectionId: string): number {
    return this.byRoom.get(roomId)?.get(connectionId)?.size ?? 0;
  }

  /** Close every socket for one connection in one room; returns how many. */
  close(
    roomId: string,
    connectionId: string,
    code = KICK_CLOSE_CODE,
    reason = KICK_CLOSE_REASON,
  ): number {
    const room = this.byRoom.get(roomId);
    const sockets = room?.get(connectionId);
    if (!room || !sockets) return 0;
    room.delete(connectionId);
    if (room.size === 0) this.byRoom.delete(roomId);
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

  /** Close every socket in a deleted room and release its connection claims. */
  closeRoom(roomId: string, code: number, reason: string): number {
    const room = this.byRoom.get(roomId);
    let closed = 0;
    if (room) {
      for (const sockets of room.values()) {
        for (const socket of sockets) {
          try {
            socket.close(code, reason);
          } catch {
            socket.terminate();
          }
          closed += 1;
        }
      }
      this.byRoom.delete(roomId);
    }
    for (const [connectionId, claimedRoom] of this.claims) {
      if (claimedRoom === roomId) this.claims.delete(connectionId);
    }
    return closed;
  }

  clear(): void {
    this.byRoom.clear();
    this.claims.clear();
  }
}
