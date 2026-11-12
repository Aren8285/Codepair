import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { generateAccessToken, TokenStore } from '../security/auth.js';
import { normalizeCandidateDir } from '../terminal/interviewSandbox.js';
import type { Rule } from '../security/accessPolicy.js';
import { SWITCH_CLOSE_CODE, SWITCH_CLOSE_REASON, type SwitchOptions, type SwitchResult } from '../session/sessionManager.js';
import { createSession, type Session, type SessionOptions } from '../session/session.js';
import { assertSwitchable } from '../session/hostPaths.js';
import { SignalingHub } from '../signaling/signalingHub.js';
import { generateRoomId } from '../config.js';

/** Close code every socket in a deleted room receives. */
export const ROOM_CLOSE_CODE = 4412;
export const ROOM_CLOSE_REASON = 'The host closed this room.';

/**
 * A room owns one session, its own guest tokens and its own live signalling
 * hub. Root switches replace only `session`; tokens and call state survive.
 */
export interface Room {
  readonly id: string;
  readonly session: Session;
  readonly createdAt: number;
  readonly tokens: TokenStore;
  readonly signaling: SignalingHub;
  readonly moderators: Set<string>;
  readonly isDefault: boolean;
  /** GO 1 stub: the interview policy/seed is implemented in GO 2. */
  readonly profile?: 'interview';
  readonly candidateDir?: string;
}

interface MutableRoom {
  readonly id: string;
  session: Session;
  readonly createdAt: number;
  readonly tokens: TokenStore;
  readonly signaling: SignalingHub;
  readonly moderators: Set<string>;
  readonly isDefault: boolean;
  readonly profile?: 'interview';
  readonly candidateDir?: string;
}

export interface CreateRoomOptions {
  root: string;
  confirmBroad?: boolean;
  profile?: 'interview';
  candidateDir?: string;
}

export interface RoomDisposeResult {
  flushErrors: string[];
}

type RoomSessionOptions = Omit<SessionOptions, 'inviteTokens' | 'lobby'> & {
  lobby?: { enabled: boolean; timeoutMs: number };
};

/**
 * Owns every room in the daemon.
 *
 * Lifecycle work is serialised through one queue: creating, switching or
 * deleting a room can never interleave their build/swap/dispose phases. Reads
 * never queue, so a request resolves the room once and keeps that object.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, MutableRoom>();
  private readonly defaultRoom: MutableRoom;
  private readonly baseOptions: RoomSessionOptions;
  private readonly onLobbyChange: (roomId: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    defaultRoomId: string,
    initialRoot: string,
    defaultTokens: TokenStore,
    options: RoomSessionOptions,
    onLobbyChange?: (roomId: string) => void,
  ) {
    this.baseOptions = options;
    this.onLobbyChange = onLobbyChange ?? (() => {});
    const session = createSession(initialRoot, this.optionsFor(defaultRoomId, defaultTokens, true));
    this.defaultRoom = this.makeRoom(defaultRoomId, session, defaultTokens, true);
    this.rooms.set(defaultRoomId, this.defaultRoom);
  }

  /** Resolve the default room's current session (legacy callers). */
  current(): Session {
    this.assertOpen();
    return this.defaultRoom.session;
  }

  currentRoom(): Room {
    this.assertOpen();
    return this.defaultRoom;
  }

  get(roomId: string): Room | undefined {
    this.assertOpen();
    return this.rooms.get(roomId);
  }

  list(): Room[] {
    this.assertOpen();
    return [...this.rooms.values()];
  }

  isActive(room: Room): boolean {
    if (this.disposed) return false;
    return this.rooms.get(room.id) === room;
  }

  switchRoot(target: string, options?: SwitchOptions): Promise<SwitchResult>;
  switchRoot(roomId: string, target: string, options?: SwitchOptions): Promise<SwitchResult>;
  switchRoot(
    roomIdOrTarget: string,
    targetOrOptions?: string | SwitchOptions,
    maybeOptions: SwitchOptions = {},
  ): Promise<SwitchResult> {
    const byRoom = typeof targetOrOptions === 'string';
    const roomId = byRoom ? roomIdOrTarget : this.defaultRoom.id;
    const target = byRoom ? targetOrOptions : roomIdOrTarget;
    const options = (byRoom ? maybeOptions : (targetOrOptions ?? {})) as SwitchOptions;
    return this.enqueue(() => this.doSwitch(roomId, target, options));
  }

  async create(options: CreateRoomOptions): Promise<Room> {
    return this.enqueue(async () => {
      this.assertOpen();
      const canonical = await assertSwitchable(options.root, { confirmBroad: options.confirmBroad === true });
      this.assertRootAvailable(canonical);

      let id = generateRoomId();
      while (id === this.defaultRoom.id || this.rooms.has(id)) id = generateRoomId();

      const profile = options.profile;
      let candidateDir: string | undefined;
      if (profile === 'interview') {
        try {
          candidateDir = normalizeCandidateDir(options.candidateDir ?? 'solution');
        } catch {
          throw new AppError(400, 'INVALID_CANDIDATE_DIR', 'candidateDir must be a relative directory inside the project.');
        }
        const solution = path.resolve(canonical, candidateDir);
        if (solution !== canonical && !solution.startsWith(`${canonical}${path.sep}`)) {
          throw new AppError(400, 'INVALID_CANDIDATE_DIR', 'candidateDir must stay inside the project.');
        }
        // Seed the one writable folder. This is a directory only; task files
        // remain whatever the Host put in the root.
        try {
          await fsp.mkdir(solution, { recursive: true });
          // Docker bind mounts resolve a symlinked source on the Host. Reject a
          // candidate directory whose real path escaped the room root, otherwise
          // the `solution:rw` mount could expose a Host directory outside it.
          const realSolution = await fsp.realpath(solution);
          if (realSolution !== canonical && !realSolution.startsWith(`${canonical}${path.sep}`)) {
            throw new AppError(400, 'INVALID_CANDIDATE_DIR', 'candidateDir must stay inside the project.');
          }
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(409, 'CANDIDATE_DIR_UNAVAILABLE', 'The candidate directory could not be created.');
        }
      }
      const tokens = this.freshTokens(profile === 'interview');
      const session = createSession(
        canonical,
        this.optionsFor(
          id,
          tokens,
          false,
          profile,
          candidateDir,
          profile === 'interview' && candidateDir ? interviewRules(candidateDir) : undefined,
        ),
      );
      const room = this.makeRoom(id, session, tokens, false, profile, candidateDir);
      this.rooms.set(id, room);
      return room;
    });
  }

  /** Delete one non-default room. The default room and the last room are permanent. */
  dispose(roomId: string): Promise<RoomDisposeResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      const room = this.rooms.get(roomId);
      if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'That room does not exist.');
      if (room.isDefault) {
        throw new AppError(409, 'DEFAULT_ROOM', 'The default room cannot be closed.');
      }
      if (this.rooms.size <= 1) {
        throw new AppError(409, 'LAST_ROOM', 'At least one room must remain open.');
      }

      this.rooms.delete(roomId);
      const { flushErrors } = await room.session.documents.dispose({
        closeCode: ROOM_CLOSE_CODE,
        reason: ROOM_CLOSE_REASON,
      });
      room.session.terminals.dispose({ closeCode: ROOM_CLOSE_CODE, reason: ROOM_CLOSE_REASON });
      room.signaling.dispose({ code: ROOM_CLOSE_CODE, reason: ROOM_CLOSE_REASON });
      room.session.lobby.dispose();
      room.session.interview.dispose();
      return { flushErrors };
    });
  }

  /** Shut every room down. No lifecycle operation may run afterwards. */
  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.queue.catch(() => undefined);
    await Promise.all(
      [...this.rooms.values()].map(async (room) => {
        await room.session.documents.dispose();
        room.session.terminals.dispose();
        room.signaling.dispose();
        room.session.lobby.dispose();
        room.session.interview.dispose();
      }),
    );
    this.rooms.clear();
  }

  private async doSwitch(roomId: string, target: string, options: SwitchOptions): Promise<SwitchResult> {
    this.assertOpen();
    const room = this.rooms.get(roomId);
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'That room does not exist.');

    const canonical = await assertSwitchable(target, { confirmBroad: options.confirmBroad === true });
    if (canonical === room.session.root) {
      return { changed: false, session: room.session, flushErrors: [] };
    }
    this.assertRootAvailable(canonical, room.id);

    const next = createSession(
      canonical,
      this.optionsFor(
        room.id,
        room.tokens,
        false,
        room.profile,
        room.candidateDir,
        room.profile === 'interview' && room.candidateDir ? interviewRules(room.candidateDir) : undefined,
      ),
    );
    const previous = room.session;
    room.session = next;

    const { flushErrors } = await previous.documents.dispose({
      closeCode: SWITCH_CLOSE_CODE,
      reason: SWITCH_CLOSE_REASON,
    });
    previous.terminals.dispose({ closeCode: SWITCH_CLOSE_CODE, reason: SWITCH_CLOSE_REASON });
    previous.lobby.dispose();
    previous.interview.dispose();

    return { changed: true, session: next, flushErrors };
  }

  private optionsFor(
    roomId: string,
    tokens: TokenStore,
    initial: boolean,
    profile?: 'interview',
    candidateDir?: string,
    interviewRules?: readonly Rule[],
  ): SessionOptions {
    const interview = profile === 'interview';
    return {
      ...this.baseOptions,
      hostRules: interview ? interviewRules ?? [] : initial ? this.baseOptions.hostRules : [],
      confirmUnhide: interview ? false : initial ? this.baseOptions.confirmUnhide : false,
      interviewRoomId: roomId,
      ...(interview ? { interviewProfile: 'interview' as const, candidateDir } : {}),
      inviteTokens: tokens,
      lobby: {
        enabled: this.baseOptions.lobby?.enabled ?? true,
        timeoutMs: this.baseOptions.lobby?.timeoutMs ?? 120_000,
        onChange: () => this.onLobbyChange(roomId),
      },
    };
  }

  private makeRoom(
    id: string,
    session: Session,
    tokens: TokenStore,
    isDefault: boolean,
    profile?: 'interview',
    candidateDir?: string,
  ): MutableRoom {
    const moderators = new Set<string>();
    const signaling = new SignalingHub({ room: id, moderators });
    return {
      id,
      session,
      createdAt: session.createdAt,
      tokens,
      signaling,
      moderators,
      isDefault,
      ...(profile ? { profile } : {}),
      ...(candidateDir ? { candidateDir } : {}),
    };
  }

  private freshTokens(interview = false): TokenStore {
    const values = new Set<string>();
    while (values.size < (interview ? 4 : 3)) values.add(generateAccessToken());
    const [owner, editor, viewer, candidate] = [...values];
    return new TokenStore([
      { token: owner!, role: 'owner' },
      { token: editor!, role: 'editor' },
      { token: viewer!, role: 'viewer' },
      ...(interview ? [{ token: candidate!, role: 'candidate' as const }] : []),
    ]);
  }

  private assertRootAvailable(root: string, exceptRoomId?: string): void {
    for (const room of this.rooms.values()) {
      if (room.id === exceptRoomId) continue;
      if (room.session.root === root) {
        throw new AppError(409, 'ROOM_ROOT_IN_USE', 'That project root is already open in another room.');
      }
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new AppError(503, 'SHUTTING_DOWN', 'The server is shutting down.');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** One room-wide policy using the existing rule mechanism. */
function interviewRules(candidateDir: string): Rule[] {
  return [
    { pattern: candidateDir, access: 'rw' },
    { pattern: `${candidateDir}/**`, access: 'rw' },
    { pattern: '**', access: 'r' },
  ];
}
