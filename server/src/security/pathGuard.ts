import fs from 'node:fs';
import path from 'node:path';

export type SandboxErrorCode = 'INVALID_PATH' | 'PATH_ESCAPE';

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * Resolves every project-relative path and proves it stays inside one real
 * directory. Two independent checks are applied:
 *
 *  1. Lexical: reject absolute paths, `..` segments, NUL bytes and Windows
 *     separators, then verify `path.relative(root, resolved)` does not escape.
 *  2. Physical: realpath the target (or its nearest existing ancestor for
 *     creates) and verify that the canonical location is still inside the
 *     root. This blocks symlinks that point outside even when the path text
 *     looks harmless.
 *
 * Residual risk: a symlink swapped between the check and the file operation
 * (TOCTOU) is not fully eliminated. The root is canonicalised once at startup;
 * use OS-level isolation when stronger guarantees are required.
 */
export class PathGuard {
  readonly root: string;

  constructor(rootInput: string) {
    const resolved = path.resolve(rootInput);
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      throw new Error(`Project root does not exist: ${resolved}`);
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new Error(`Project root is not a directory: ${real}`);
    }
    this.root = real;
  }

  /** Resolve a client-supplied relative path to an absolute path inside root. */
  resolve(relativePath: string): string {
    if (typeof relativePath !== 'string') {
      throw new SandboxError('INVALID_PATH', 'Path must be a string.');
    }
    if (relativePath.includes('\0')) {
      throw new SandboxError('INVALID_PATH', 'Path contains a NUL byte.');
    }
    if (relativePath.includes('\\')) {
      throw new SandboxError('INVALID_PATH', 'Backslashes are not allowed in project paths.');
    }
    if (relativePath.startsWith('~')) {
      throw new SandboxError('INVALID_PATH', 'Home-directory expansion is not supported.');
    }
    if (path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
      throw new SandboxError('INVALID_PATH', 'Absolute paths are not allowed; use a project-relative path.');
    }

    const segments = relativePath.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.some((segment) => segment === '..')) {
      throw new SandboxError('PATH_ESCAPE', 'Parent-directory traversal is not allowed.');
    }
    const cleaned = segments.join('/');
    const absolute = path.resolve(this.root, cleaned);

    const relative = path.relative(this.root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new SandboxError('PATH_ESCAPE', 'That path is outside the project.');
    }

    this.assertPhysicalContainment(absolute);
    return absolute;
  }

  /** Convert an absolute path inside the root back to its project-relative form. */
  toRelative(absolutePath: string): string {
    const relative = path.relative(this.root, absolutePath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new SandboxError('PATH_ESCAPE', 'That path is outside the project.');
    }
    return relative.split(path.sep).join('/');
  }

  private assertPhysicalContainment(absolute: string): void {
    let candidate = absolute;
    // Walk up to the nearest existing entry; only then can realpath prove
    // where a create would actually land.
    for (;;) {
      try {
        const real = fs.realpathSync(candidate);
        const relative = path.relative(this.root, real);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new SandboxError('PATH_ESCAPE', 'That path resolves outside the project.');
        }
        return;
      } catch (error) {
        if (error instanceof SandboxError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) {
          throw new SandboxError('PATH_ESCAPE', 'That path is outside the project.');
        }
        candidate = parent;
      }
    }
  }
}
