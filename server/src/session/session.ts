import { randomUUID } from 'node:crypto';
import { DocumentHub } from '../documents/documentHub.js';
import { FileService } from '../files/fileService.js';
import { PathGuard } from '../security/pathGuard.js';
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
}

export interface SessionOptions {
  saveDebounceMs: number;
  maxFileBytes: number;
  terminalEnabled: boolean;
  /** Directory names the guest API never lists. */
  ignored: ReadonlySet<string>;
}

/** Construct a session from a directory that already exists. */
export function createSession(root: string, options: SessionOptions): Session {
  const pathGuard = new PathGuard(root);
  const files = new FileService(pathGuard, {
    maxFileBytes: options.maxFileBytes,
    ignored: new Set(options.ignored),
  });
  const documents = new DocumentHub(files, { saveDebounceMs: options.saveDebounceMs });
  const terminals = new TerminalService(pathGuard, { enabled: options.terminalEnabled });
  return {
    id: randomUUID(),
    root: pathGuard.root,
    createdAt: Date.now(),
    pathGuard,
    files,
    documents,
    terminals,
  };
}
