import { randomUUID } from 'node:crypto';
import { DocumentHub } from '../documents/documentHub.js';
import { FileService } from '../files/fileService.js';
import { AccessFileService } from '../files/policyFileService.js';
import { InviteStore, type InviteTokenSource } from '../invites/invites.js';
import { Lobby } from '../lobby/lobby.js';
import { AccessPolicy, type Rule } from '../security/accessPolicy.js';
import { PathGuard } from '../security/pathGuard.js';
import type { Principal } from '../security/principal.js';
import { TerminalService, type TerminalSpawn } from '../terminal/terminalService.js';
import { InterviewStore } from '../interview/interviewStore.js';
import type { InterviewSandboxStatus } from '../terminal/interviewSandbox.js';

/**
 * One project root and everything bound to it. Switching roots builds a new
 * Session and disposes the old one; nothing root-bound is shared between them.
 */
export interface Session {
  /** Random, per root selection. */
  readonly id: string;
  /** Canonical (realpath) project root. */
  readonly root: string;
  readonly createdAt: number;
  readonly pathGuard: PathGuard;
  readonly files: FileService;
  readonly documents: DocumentHub;
  readonly terminals: TerminalService;
  /** Host rule list plus the built-in secret defaults; per session, in memory. */
  readonly policy: AccessPolicy;
  /** The waiting room for this session; a root switch builds a fresh, empty one. */
  readonly lobby: Lobby;
  /** Invite links for this root; a root switch builds a fresh, empty set. */
  readonly invites: InviteStore;
  /** GO 1 stub: consent, integrity events and replay data for this session. */
  readonly interview: InterviewStore;
  /** The single file-access choke point for one principal. */
  access(principal: Principal): AccessFileService;
}

export interface SessionOptions {
  saveDebounceMs: number;
  maxFileBytes: number;
  terminalEnabled: boolean;
  /** Directory names the guest API never lists. */
  ignored: ReadonlySet<string>;
  /** Host rules installed at startup (`--rule`). */
  hostRules?: readonly Rule[];
  /** The Host confirmed lifting a default secret at startup (`--confirm-unhide`). */
  confirmUnhide?: boolean;
  /** Lobby configuration; a switched-to session gets the same settings, empty state. */
  lobby?: {
    enabled: boolean;
    timeoutMs: number;
    onChange?: () => void;
  };
  /** Guest token lookup used by invite redemption (never a token snapshot). */
  inviteTokens?: InviteTokenSource;
  /** Injectable clock for invite expiry/rate tests. */
  inviteNow?: () => number;
  /** Interview room profile and its writable subdirectory. */
  interviewProfile?: 'interview';
  candidateDir?: string;
  interviewRoomId?: string;
  /** GO 1 stub: startup sandbox probe result. */
  interviewSandbox?: InterviewSandboxStatus;
  /** Test seams for the terminal paths. */
  terminalSpawn?: TerminalSpawn;
  sandboxSpawn?: TerminalSpawn;
}

/** Construct a session from a directory that already exists. */
export function createSession(root: string, options: SessionOptions): Session {
  const pathGuard = new PathGuard(root);
  const files = new FileService(pathGuard, {
    maxFileBytes: options.maxFileBytes,
    ignored: new Set(options.ignored),
  });
  const policy = new AccessPolicy();
  policy.setRules(options.hostRules ?? [], options.confirmUnhide === true);
  const interview = new InterviewStore({ roomId: options.interviewRoomId });
  const documents = new DocumentHub(files, {
    saveDebounceMs: options.saveDebounceMs,
    policy,
    onUpdate: (event) => {
      if (event.origin !== 'candidate' || !event.connectionId) return;
      if (!interview.hasConsent(event.connectionId)) return;
      interview.noteUpdate({
        connectionId: event.connectionId,
        path: event.path,
        chars: event.chars,
        insertedChars: event.insertedChars,
        origin: 'candidate',
      });
      if (event.content !== undefined) interview.captureSnapshot(event.path, event.content);
    },
  });
  const terminals = new TerminalService(pathGuard, {
    enabled: options.terminalEnabled,
    sandbox: options.interviewSandbox,
    sandboxCandidateDir: options.candidateDir ?? 'solution',
    spawn: options.terminalSpawn,
    sandboxSpawn: options.sandboxSpawn,
  });
  const lobby = new Lobby({
    enabled: options.lobby?.enabled ?? true,
    timeoutMs: options.lobby?.timeoutMs ?? 120_000,
    onChange: options.lobby?.onChange,
  });
  const invites = new InviteStore(options.inviteTokens ?? { tokenFor: () => undefined }, {
    now: options.inviteNow,
  });
  const session: Omit<Session, 'access'> = {
    id: randomUUID(),
    root: pathGuard.root,
    createdAt: Date.now(),
    pathGuard,
    files,
    documents,
    terminals,
    policy,
    lobby,
    invites,
    interview,
  };
  return { ...session, access: (principal) => AccessFileService.forSession(session, principal) };
}
