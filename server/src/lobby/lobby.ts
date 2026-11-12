import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';

/** A seat is what the Host grants; it can never exceed the token's own role. */
export type SeatRole = 'editor' | 'viewer' | 'candidate';
export type LobbyRole = SeatRole | 'owner';
export type PendingState = 'waiting' | 'admitted' | 'denied' | 'expired' | 'withdrawn';
/** A connection that left the queue keeps a terminal state it can be refused with. */
export type SettledState = 'denied' | 'expired' | 'withdrawn' | 'removed';
export type LobbyState = PendingState | 'removed' | 'none';

export interface PendingJoin {
  id: string;
  connectionId: string;
  displayName: string;
  requestedAt: number;
  state: PendingState;
  /** Role of the token that asked; the seat can never exceed it. */
  tokenRole: LobbyRole;
  grantedRole?: SeatRole;
}

export interface AdmittedConnection {
  connectionId: string;
  displayName: string;
  role: LobbyRole;
  connectedSince: number;
}

export interface LobbySnapshot {
  enabled: boolean;
  locked: boolean;
  pending: PendingJoin[];
  admitted: AdmittedConnection[];
}

export interface LobbyStatus {
  enabled: boolean;
  locked: boolean;
  state: LobbyState;
  displayName?: string;
  seat?: SeatRole;
  expiresAt?: number;
}

export interface LobbyOptions {
  enabled: boolean;
  timeoutMs: number;
  maxPending?: number;
  /** Notifies the Host console (SSE) that something changed. */
  onChange?: () => void;
  /** Injectable clock for timeout tests. */
  now?: () => number;
}

/** Waiting room cap: the 51st request is refused, never silently dropped. */
export const MAX_PENDING = 50;

/** Completed upgrade, then closed: a waiting room is not a transport error. */
export const LOBBY_CLOSE_CODE = 4425;
export const LOBBY_WAITING_REASON = 'Waiting for the host to let you in.';
export const LOBBY_LOCKED_REASON = 'The room is locked.';
export const LOBBY_DENIED_REASON = 'The host declined your request to join.';
export const LOBBY_REMOVED_REASON = 'The host removed you from this session.';
export const LOBBY_EXPIRED_REASON = 'No response from the host.';
export const LOBBY_FULL_REASON = 'The lobby is full.';
export const LOBBY_DISABLED_REASON = 'The lobby is disabled on this server.';

/** Client-generated per-tab id; the only thing that ties one tab's sockets together. */
export const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isConnectionId(value: unknown): value is string {
  return typeof value === 'string' && CONNECTION_ID_PATTERN.test(value);
}

/** Printable ASCII, no control characters, at most 40 characters. */
export function sanitizeDisplayName(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  const printable = value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40);
  return printable.length > 0 ? printable : 'Guest';
}

/**
 * One waiting room per session, reset by `switchRoot` (a new Session builds a
 * new Lobby).
 *
 * Policy: owner tokens never wait (they bypass the lobby and the lock), every
 * other connection asks once per `connectionId`, and a seat can only narrow the
 * token's capabilities. Terminal states (denied, removed, expired) are kept per
 * connection id so a reconnect cannot quietly slip back into the queue.
 */
export class Lobby {
  private isLocked = false;
  private readonly pending = new Map<string, PendingJoin>();
  private readonly admitted = new Map<string, AdmittedConnection>();
  private readonly settled = new Map<string, SettledState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly now: () => number;

  constructor(private readonly options: LobbyOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  get locked(): boolean {
    return this.isLocked;
  }

  /** Create (or retry) this tab's request. Throws a 4xx AppError on refusal. */
  request(connectionId: string, displayName: string, tokenRole: LobbyRole): LobbyStatus {
    const name = sanitizeDisplayName(displayName);
    if (!this.options.enabled) {
      this.connectDirect(connectionId, name, tokenRole);
      return this.directStatus(name, tokenRole);
    }

    if (tokenRole === 'owner') {
      this.connectDirect(connectionId, name, 'owner');
      return { enabled: true, locked: this.isLocked, state: 'admitted', displayName: name };
    }

    const admitted = this.admitted.get(connectionId);
    if (admitted) return this.statusOfAdmitted(admitted);

    const settled = this.settled.get(connectionId);
    if (settled === 'denied') throw new AppError(403, 'LOBBY_DENIED', LOBBY_DENIED_REASON);
    if (settled === 'removed') throw new AppError(403, 'LOBBY_REMOVED', LOBBY_REMOVED_REASON);
    // Expired (or withdrawn) is retryable: the request starts over, queued.
    if (settled) this.settled.delete(connectionId);

    if (this.isLocked) throw new AppError(403, 'LOBBY_LOCKED', LOBBY_LOCKED_REASON);

    const existing = this.findPending(connectionId);
    if (existing) {
      existing.displayName = name;
      return this.statusOfEntry(existing);
    }

    if (this.pending.size >= (this.options.maxPending ?? MAX_PENDING)) {
      throw new AppError(429, 'LOBBY_FULL', LOBBY_FULL_REASON);
    }

    const entry: PendingJoin = {
      id: randomUUID(),
      connectionId,
      displayName: name,
      requestedAt: this.now(),
      state: 'waiting',
      tokenRole,
    };
    this.pending.set(entry.id, entry);
    this.armTimer(entry);
    this.options.onChange?.();
    return this.statusOfEntry(entry);
  }

  /** Read-only view for the waiting screen; never creates a request. */
  status(connectionId: string, tokenRole: LobbyRole): LobbyStatus {
    if (!this.options.enabled) return this.directStatus('Guest', tokenRole);
    if (tokenRole === 'owner') {
      return { enabled: true, locked: this.isLocked, state: 'admitted', displayName: 'Owner' };
    }
    const admitted = this.admitted.get(connectionId);
    if (admitted) return this.statusOfAdmitted(admitted);
    const entry = this.findPending(connectionId);
    if (entry) return this.statusOfEntry(entry);
    const settled = this.settled.get(connectionId);
    if (settled) return { enabled: true, locked: this.isLocked, state: settled };
    return { enabled: true, locked: this.isLocked, state: 'none' };
  }

  /** Host action: grant a seat to one waiting request. */
  admit(id: string, role: SeatRole): PendingJoin {
    this.requireEnabled();
    const entry = this.pending.get(id);
    if (!entry || entry.state !== 'waiting') {
      throw new AppError(409, 'LOBBY_CLOSED', 'That request is no longer waiting.');
    }
    // The seat is a ceiling, never an upgrade. Candidate tokens are strictly
    // candidate-only; viewer tokens cannot become editors, and editor tokens
    // cannot become candidates.
    const allowed = allowedSeats(entry.tokenRole);
    if (!allowed.includes(role)) {
      throw new AppError(403, 'ROLE_CEILING', `That connection cannot be admitted as a ${role}.`);
    }

    entry.state = 'admitted';
    entry.grantedRole = role;
    this.pending.delete(id);
    this.clearTimer(id);
    this.admitted.set(entry.connectionId, {
      connectionId: entry.connectionId,
      displayName: entry.displayName,
      role: role,
      connectedSince: this.now(),
    });
    this.options.onChange?.();
    return { ...entry };
  }

  deny(id: string): PendingJoin {
    this.requireEnabled();
    const entry = this.pending.get(id);
    if (!entry || entry.state !== 'waiting') {
      throw new AppError(409, 'LOBBY_CLOSED', 'That request is no longer waiting.');
    }
    entry.state = 'denied';
    this.pending.delete(id);
    this.clearTimer(id);
    this.settled.set(entry.connectionId, 'denied');
    this.options.onChange?.();
    return { ...entry };
  }

  setLocked(locked: boolean): void {
    this.requireEnabled();
    this.isLocked = locked;
    this.options.onChange?.();
  }

  /**
   * Remove one connection: it loses its seat, every surface is closed by the
   * caller (the daemon-level registry owns the sockets), and reconnecting with
   * the same connection id is refused instead of re-queued.
   */
  kick(connectionId: string): void {
    this.requireEnabled();
    this.settled.set(connectionId, 'removed');
    this.admitted.delete(connectionId);
    const pending = this.findPending(connectionId);
    if (pending) {
      pending.state = 'denied';
      this.pending.delete(pending.id);
      this.clearTimer(pending.id);
    }
    this.options.onChange?.();
  }

  /** Owner bypass and `--no-lobby` admissions. */
  connectDirect(connectionId: string, displayName: string, role: LobbyRole): void {
    this.admitted.set(connectionId, {
      connectionId,
      displayName: sanitizeDisplayName(displayName),
      role,
      connectedSince: this.now(),
    });
    this.options.onChange?.();
  }

  /** The seat for a connection, if it may use realtime surfaces. */
  seatFor(connectionId: string): AdmittedConnection | undefined {
    return this.admitted.get(connectionId);
  }

  snapshot(): LobbySnapshot {
    return {
      enabled: this.options.enabled,
      locked: this.isLocked,
      pending: [...this.pending.values()].sort((a, b) => a.requestedAt - b.requestedAt).map((entry) => ({ ...entry })),
      admitted: [...this.admitted.values()]
        .sort((a, b) => a.connectedSince - b.connectedSince)
        .map((entry) => ({ ...entry })),
    };
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private requireEnabled(): void {
    if (!this.options.enabled) throw lobbyDisabled();
  }

  private findPending(connectionId: string): PendingJoin | undefined {
    for (const entry of this.pending.values()) {
      if (entry.connectionId === connectionId) return entry;
    }
    return undefined;
  }

  private armTimer(entry: PendingJoin): void {
    const timer = setTimeout(() => {
      this.timers.delete(entry.id);
      if (entry.state !== 'waiting') return;
      entry.state = 'expired';
      this.pending.delete(entry.id);
      this.settled.set(entry.connectionId, 'expired');
      this.options.onChange?.();
    }, Math.max(1, this.options.timeoutMs));
    timer.unref?.();
    this.timers.set(entry.id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private statusOfEntry(entry: PendingJoin): LobbyStatus {
    return {
      enabled: true,
      locked: this.isLocked,
      state: entry.state,
      displayName: entry.displayName,
      expiresAt: entry.requestedAt + Math.max(1, this.options.timeoutMs),
    };
  }

  private statusOfAdmitted(entry: AdmittedConnection): LobbyStatus {
    return {
      enabled: true,
      locked: this.isLocked,
      state: 'admitted',
      displayName: entry.displayName,
      ...(entry.role === 'owner' ? {} : { seat: entry.role }),
    };
  }

  private directStatus(displayName: string, tokenRole: LobbyRole): LobbyStatus {
    return {
      enabled: false,
      locked: false,
      state: 'admitted',
      displayName: sanitizeDisplayName(displayName),
      seat: tokenRole === 'candidate' ? 'candidate' : tokenRole === 'viewer' ? 'viewer' : 'editor',
    };
  }
}

function allowedSeats(role: LobbyRole): SeatRole[] {
  switch (role) {
    case 'owner':
      return ['editor', 'viewer', 'candidate'];
    case 'editor':
      return ['editor', 'viewer'];
    case 'viewer':
      return ['viewer'];
    case 'candidate':
      return ['candidate'];
  }
}

/** Used by the host console routes; kept here so tests can assert refusal codes. */
export function lobbyDisabled(): AppError {
  return new AppError(409, 'LOBBY_DISABLED', LOBBY_DISABLED_REASON);
}
