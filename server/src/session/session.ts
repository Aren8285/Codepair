import { randomUUID } from 'node:crypto';
import { DocumentHub } from '../documents/documentHub.js';
import { FileService } from '../files/fileService.js';
import { AccessFileService } from '../files/policyFileService.js';
import { AccessPolicy, type Rule } from '../security/accessPolicy.js';
import { PathGuard } from '../security/pathGuard.js';
import type { Principal } from '../security/principal.js';
import { TerminalService } from '../terminal/terminalService.js';

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
  const documents = new DocumentHub(files, { saveDebounceMs: options.saveDebounceMs, policy });
  const terminals = new TerminalService(pathGuard, { enabled: options.terminalEnabled });
  const session: Omit<Session, 'access'> = {
    id: randomUUID(),
    root: pathGuard.root,
    createdAt: Date.now(),
    pathGuard,
    files,
    documents,
    terminals,
    policy,
  };
  return { ...session, access: (principal) => AccessFileService.forSession(session, principal) };
}
