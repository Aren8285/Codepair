import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { forbidden, notFound } from '../errors.js';
import { AccessView, type Access, type AccessPolicy } from '../security/accessPolicy.js';
import { normalizePathForMatch } from '../security/glob.js';
import type { PathGuard } from '../security/pathGuard.js';
import type { Capability, Principal } from '../security/principal.js';
import type { FileContent, FileEntry, FileService, TreeResult } from './fileService.js';

const MAX_SUBTREE_ENTRIES = 4000;
const VISIBLE_PATH_MESSAGE = 'That path does not exist.';

/** The session pieces the guarded view needs; structural so `session.ts` can pass itself. */
export interface AccessSession {
  readonly files: FileService;
  readonly pathGuard: PathGuard;
  readonly policy: AccessPolicy;
}

/** A hidden path is indistinguishable from a missing one. */
function hiddenPath(): Error {
  return notFound(VISIBLE_PATH_MESSAGE);
}

/**
 * The one policy choke point for guest file access. Every HTTP file route and
 * the document-socket upgrade go through an instance of this class, which is
 * built once per request/connection from the resolved session.
 *
 * Policy decisions are made here, on top of PathGuard's normalised relative
 * path (and the canonical path where one exists). PathGuard never weakens: this
 * layer can only refuse more.
 */
export class AccessFileService {
  readonly view: AccessView;

  constructor(
    private readonly session: AccessSession,
    readonly capabilities: ReadonlySet<Capability>,
    readonly principal: Principal,
  ) {
    this.view = new AccessView(session.policy, capabilities);
  }

  static forSession(session: AccessSession, principal: Principal): AccessFileService {
    return new AccessFileService(session, principal.capabilities, principal);
  }

  protected get files(): FileService {
    return this.session.files;
  }

  async tree(relativeDir = ''): Promise<TreeResult> {
    const directory = normalizePathForMatch(relativeDir);
    if (!this.view.visible(directory, this.canonicalTarget(relativeDir) ?? undefined)) {
      throw hiddenPath();
    }
    return this.files.tree(relativeDir, (relPath, canonicalRelPath) =>
      this.entryAccess(relPath, canonicalRelPath),
    );
  }

  async read(relativePath: string): Promise<FileContent> {
    const requested = normalizePathForMatch(relativePath);
    // Decide from the name alone first, so a hidden file is refused before any
    // filesystem call (no existence or timing oracle for the obvious cases).
    if (!this.view.read(requested)) throw hiddenPath();
    if (!this.view.read(requested, this.canonicalTarget(relativePath) ?? undefined)) {
      throw hiddenPath();
    }
    return this.files.read(relativePath);
  }

  search(query: string): Promise<{ query: string; entries: FileEntry[]; truncated: boolean }> {
    return this.files.search(query, (relPath, canonicalRelPath) => this.entryAccess(relPath, canonicalRelPath));
  }

  async create(relativePath: string, type: 'file' | 'directory', content = ''): Promise<FileEntry> {
    this.assertMutable(relativePath);
    return this.files.create(relativePath, type, content);
  }

  async rename(from: string, to: string): Promise<FileEntry> {
    this.assertMutable(from);
    this.assertMutable(to);
    // A directory move can change a descendant's decision even when both
    // endpoints are allowed, so compare the whole subtree first.
    const absolute = this.session.pathGuard.resolve(from);
    const stat = await fsp.lstat(absolute).catch(() => undefined);
    if (stat?.isDirectory()) this.assertSubtreeStable(from, to);
    return this.files.rename(from, to);
  }

  async remove(relativePath: string): Promise<{ path: string }> {
    this.assertMutable(relativePath);
    return this.files.remove(relativePath);
  }

  /** Resolved access for the document-socket upgrade, before any read. */
  documentAccess(relativePath: string): { visible: boolean; write: boolean } {
    const requested = normalizePathForMatch(relativePath);
    const access = this.view.decide(requested, this.canonicalTarget(relativePath) ?? undefined);
    return {
      visible: access !== 'hidden',
      write: access === 'rw' && this.capabilities.has('fs.write'),
    };
  }

  private entryAccess(relPath: string, canonicalRelPath: string | null): Access {
    const access = this.view.decide(relPath, canonicalRelPath ?? undefined);
    if (access === 'hidden') return 'hidden';
    return access === 'rw' && this.capabilities.has('fs.write') ? 'rw' : 'r';
  }

  private assertMutable(relativePath: string): void {
    if (normalizePathForMatch(relativePath).length === 0) return;
    const requested = normalizePathForMatch(relativePath);
    const access = this.view.decide(requested, this.canonicalTarget(relativePath) ?? undefined);
    if (access !== 'rw' || !this.capabilities.has('fs.write')) throw forbidden();
  }

  /**
   * Best-effort canonical target: realpath the nearest existing ancestor and
   * append the segments that do not exist yet. Check-then-act, not atomic —
   * the same TOCTOU caveat PathGuard documents applies here.
   */
  private canonicalTarget(relativePath: string): string | null {
    const segments = normalizePathForMatch(relativePath).split('/').filter(Boolean);
    if (segments.length === 0) return '';
    let resolved: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const absolute = path.join(this.session.pathGuard.root, ...segments.slice(0, index + 1));
      try {
        const real = fs.realpathSync(absolute);
        resolved = this.session.pathGuard.toRelative(real).split('/');
      } catch {
        return [...resolved, ...segments.slice(index)].join('/');
      }
    }
    return resolved.join('/');
  }

  /** Refuse a directory rename if any descendant's effective access would change. */
  private assertSubtreeStable(from: string, to: string): void {
    const absolute = this.session.pathGuard.resolve(from);
    const relatives: string[] = [];
    const walk = (directory: string, prefix: string): void => {
      for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
        if (relatives.length >= MAX_SUBTREE_ENTRIES) throw forbidden();
        const child = prefix ? `${prefix}/${dirent.name}` : dirent.name;
        relatives.push(child);
        if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
          walk(path.join(directory, dirent.name), child);
        }
      }
    };
    walk(absolute, '');

    const baseFrom = normalizePathForMatch(from);
    const baseTo = normalizePathForMatch(to);
    const sameAccess = (oldPath: string, newPath: string): void => {
      if (this.view.decide(oldPath) !== this.view.decide(newPath)) throw forbidden();
    };
    sameAccess(baseFrom, baseTo);
    for (const relative of relatives) {
      sameAccess(`${baseFrom}/${relative}`, `${baseTo}/${relative}`);
    }
  }
}
