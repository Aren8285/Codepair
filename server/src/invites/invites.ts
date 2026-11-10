import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';

/**
 * Invite roles are deliberately narrower than `Role`: an invite can never
 * grant owner access. The token itself is looked up at redeem time, so an
 * invite never stores a token value.
 */
export type InviteRole = 'editor' | 'viewer';

export interface Invite {
  /** Random, URL-safe; at least 128 bits of entropy. */
  id: string;
  role: InviteRole;
  createdAt: number;
  /** null means the invite does not expire. */
  expiresAt: number | null;
  /** null means unlimited uses. */
  maxUses: number | null;
  usedCount: number;
  revoked: boolean;
}

export interface InviteTokenSource {
  tokenFor(role: InviteRole): string | undefined;
}

export interface InviteStoreOptions {
  /** Injectable clock for expiry and rate-window tests. */
  now?: () => number;
  /** Live invites allowed at once (default 50). */
  maxInvites?: number;
  /** Failed redeems against one id before blocking. */
  failureLimit?: number;
  /** Rolling failure window. */
  failureWindowMs?: number;
  /** How long a blocked id stays blocked. */
  blockMs?: number;
  /** Upper bound on tracked ids, so unknown-id spam cannot grow memory. */
  failureTrackerCap?: number;
}

export const INVITE_MAX_LIVE = 50;
export const INVITE_FAILURE_LIMIT = 10;
export const INVITE_FAILURE_WINDOW_MS = 60_000;
export const INVITE_BLOCK_MS = 60_000;
export const INVITE_FAILURE_TRACKER_CAP = 256;
const MAX_TTL_MINUTES = 10_080;
const MAX_USES = 1_000;
const ID_BYTES = 18;

interface FailureRecord {
  /** Failure timestamps inside the rolling window. */
  times: number[];
  /** Epoch millis until which this id is blocked; 0 when not blocked. */
  blockedUntil: number;
}

/**
 * One failure response for every bad invitation: unknown, expired, exhausted
 * and revoked are indistinguishable, so a link cannot be used as an oracle.
 */
export function inviteNotFound(): AppError {
  return new AppError(404, 'INVITE_INVALID', 'This invite link is not valid or has expired.');
}

export interface RedeemedInvite {
  token: string;
  role: InviteRole;
}

/**
 * Per-session, in-memory invite set. A root switch builds a new store, so
 * invites never follow the Host to a different project.
 *
 * The failure tracker is capped at 256 ids, but the cap is deliberately soft:
 * blocked entries are never evicted to make room. If every tracked id is
 * blocked, a new id is still tracked (and can briefly push the map above the
 * nominal cap). Preserving active blocks is more important than hiding a
 * fresh guess: an id that is not tracked can be guessed without limit.
 */
export class InviteStore {
  private readonly tokens: InviteTokenSource;
  private readonly options: Required<InviteStoreOptions>;
  private readonly invites = new Map<string, Invite>();
  private readonly failures = new Map<string, FailureRecord>();

  constructor(tokens: InviteTokenSource, options: InviteStoreOptions = {}) {
    this.tokens = tokens;
    this.options = {
      now: options.now ?? (() => Date.now()),
      maxInvites: options.maxInvites ?? INVITE_MAX_LIVE,
      failureLimit: options.failureLimit ?? INVITE_FAILURE_LIMIT,
      failureWindowMs: options.failureWindowMs ?? INVITE_FAILURE_WINDOW_MS,
      blockMs: options.blockMs ?? INVITE_BLOCK_MS,
      failureTrackerCap: options.failureTrackerCap ?? INVITE_FAILURE_TRACKER_CAP,
    };
  }

  create(input: { role: InviteRole | string; ttlMinutes?: number | null; maxUses?: number | null }): Invite {
    const role = input.role;
    if (role !== 'editor' && role !== 'viewer') {
      throw new AppError(400, 'BAD_REQUEST', 'An invite can only grant editor or viewer access; owner is never allowed.');
    }

    const ttl = input.ttlMinutes;
    if (ttl !== undefined && ttl !== null) {
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MINUTES) {
        throw new AppError(400, 'BAD_REQUEST', `ttlMinutes must be an integer from 1 to ${MAX_TTL_MINUTES}.`);
      }
    }

    const maxUses = input.maxUses;
    if (maxUses !== undefined && maxUses !== null) {
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES) {
        throw new AppError(400, 'BAD_REQUEST', `maxUses must be an integer from 1 to ${MAX_USES}.`);
      }
    }

    if (!this.tokens.tokenFor(role)) {
      throw new AppError(409, 'ROLE_NOT_CONFIGURED', `No ${role} token is configured on this host.`);
    }

    const now = this.options.now();
    this.pruneInvites(now);
    const liveCount = [...this.invites.values()].filter((invite) => isLive(invite, now)).length;
    if (liveCount >= this.options.maxInvites) {
      throw new AppError(
        429,
        'INVITE_LIMIT',
        `At most ${this.options.maxInvites} live invites are allowed. Revoke or wait for one to expire.`,
      );
    }
    // An exhausted invite is not live and must not slowly consume the map.
    for (const [id, invite] of this.invites) {
      if (!isLive(invite, now)) this.invites.delete(id);
    }

    const invite: Invite = {
      id: this.newId(),
      role,
      createdAt: now,
      expiresAt: ttl === undefined || ttl === null ? null : now + ttl * 60_000,
      maxUses: maxUses === undefined || maxUses === null ? null : maxUses,
      usedCount: 0,
      revoked: false,
    };
    this.invites.set(invite.id, invite);
    return copyInvite(invite);
  }

  /** Only invites that can still be redeemed. */
  list(): Invite[] {
    const now = this.options.now();
    this.pruneInvites(now);
    // Exhausted invites stay visible until they expire or are revoked, so the
    // Host can see the final usedCount and choose to revoke/clean up.
    return [...this.invites.values()].map(copyInvite);
  }

  /** Read one invite even after it is exhausted, for tests and Host display. */
  get(id: string): Invite | undefined {
    const invite = this.invites.get(id);
    return invite ? copyInvite(invite) : undefined;
  }

  revoke(id: string): Invite {
    const invite = this.invites.get(id);
    if (!invite) throw inviteNotFound();
    invite.revoked = true;
    return copyInvite(invite);
  }

  redeem(id: string): RedeemedInvite {
    const now = this.options.now();
    const record = this.failures.get(id);
    if (record && record.blockedUntil > now) {
      throw new AppError(429, 'INVITE_RATE_LIMITED', 'Too many redeem attempts. Try again shortly.');
    }

    const invite = this.invites.get(id);
    if (!invite || !isLive(invite, now)) {
      this.recordFailure(id, now);
      throw inviteNotFound();
    }

    // Look the token up now, never at invite-creation time. Rotation revokes
    // role invites explicitly, so a rotated role can never resurrect one.
    const token = this.tokens.tokenFor(invite.role);
    if (!token) {
      this.recordFailure(id, now);
      throw inviteNotFound();
    }

    invite.usedCount += 1;
    this.failures.delete(id);
    return { token, role: invite.role };
  }

  /** Rotation calls this: live invites for the role are destroyed, not moved. */
  revokeForRole(role: InviteRole): number {
    let revoked = 0;
    for (const invite of this.invites.values()) {
      if (invite.role !== role || invite.revoked) continue;
      if (isLive(invite, this.options.now())) revoked += 1;
      invite.revoked = true;
    }
    return revoked;
  }

  /** Diagnostic: number of ids currently holding failure history. */
  failureTrackerSize(): number {
    return this.failures.size;
  }

  /** Diagnostic: current-window failures for one id, 0 when it was evicted. */
  failureCount(id: string): number {
    const record = this.failures.get(id);
    if (!record) return 0;
    const cutoff = this.options.now() - this.options.failureWindowMs;
    return record.times.filter((timestamp) => timestamp > cutoff).length;
  }

  private newId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = randomBytes(ID_BYTES).toString('base64url');
      if (!this.invites.has(id)) return id;
    }
    throw new AppError(500, 'INTERNAL', 'Could not allocate an invite id.');
  }

  private pruneInvites(now: number): void {
    for (const [id, invite] of this.invites) {
      if (invite.revoked || (invite.expiresAt !== null && now >= invite.expiresAt)) {
        this.invites.delete(id);
      }
    }
  }

  private recordFailure(id: string, now: number): void {
    let record = this.failures.get(id);
    if (!record) {
      this.ensureCapacity(id, now);
      record = { times: [], blockedUntil: 0 };
      this.failures.set(id, record);
    } else {
      if (record.blockedUntil <= now) record.blockedUntil = 0;
      record.times = record.times.filter((timestamp) => now - timestamp < this.options.failureWindowMs);
    }

    record.times.push(now);
    if (record.times.length >= this.options.failureLimit) {
      record.blockedUntil = now + this.options.blockMs;
    }
  }

  /**
   * Evict only an unblocked entry. If every entry is blocked we keep them all;
   * the new id is still added, so fresh guesses always count. This is the
   * deliberate soft-cap rule tested by the all-blocked overflow case.
   */
  private ensureCapacity(incomingId: string, now: number): void {
    if (this.failures.has(incomingId) || this.failures.size < this.options.failureTrackerCap) return;
    for (const [id, record] of this.failures) {
      if (id === incomingId) continue;
      if (record.blockedUntil > now) continue;
      this.failures.delete(id);
      return;
    }
  }
}

function isLive(invite: Invite, now: number): boolean {
  if (invite.revoked) return false;
  if (invite.expiresAt !== null && now >= invite.expiresAt) return false;
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) return false;
  return true;
}

function copyInvite(invite: Invite): Invite {
  return { ...invite };
}
