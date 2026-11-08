import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';

const MAX_PATH_LENGTH = 4096;
const MAX_ENTRIES = 500;

/**
 * Exact-match system roots. Only these directories themselves need
 * confirmation: `/usr/local/proj` and `/private/tmp/site` are ordinary
 * projects. Both sides are realpathed, so `/etc` still matches `/private/etc`.
 */
const DEFAULT_SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/var', '/System', '/Library', '/private', '/dev', '/proc'];

/** Credential directories: the directory itself and everything beneath it. */
const CREDENTIAL_DIR_NAMES = ['.ssh', '.aws', '.gnupg', '.config'];

export interface HostPathOptions {
  /** Directory treated as the Host's home. Defaults to `$HOME` / `os.homedir()`. */
  home?: string;
  /** Exact-match system directories that always need `confirmBroad`. Injectable for tests. */
  systemDirs?: string[];
  /** Credential directories (and descendants) that are always refused. Injectable for tests. */
  credentialDirs?: string[];
  /** The Host explicitly accepted a broad root. */
  confirmBroad?: boolean;
}

export interface HostDirectoryEntry {
  name: string;
  path: string;
  isSymlink: boolean;
  readable: boolean;
}

export interface HostDirectoryListing {
  path: string;
  parent: string | null;
  entries: HostDirectoryEntry[];
  truncated: boolean;
}

function homeDir(): string {
  const fromEnv = process.env.HOME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : os.homedir();
}

/** `fs.realpath.native`, promisified: the same syscall the OS uses. */
function realpathNative(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.realpath.native(target, (error, resolved) => (error ? reject(error) : resolve(resolved)));
  });
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpathNative(target);
  } catch {
    return null;
  }
}

/** Realpath every entry that exists; a missing entry is simply not a match. */
async function canonicalList(entries: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(entries.map((entry) => realpathOrNull(entry)));
  return resolved.filter((entry): entry is string => entry !== null);
}

function pathError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return notFound('That path does not exist.');
  if (code === 'EACCES' || code === 'EPERM') return forbidden();
  if (code === 'ENOTDIR') return badRequest('That path is not a directory.');
  if (code === 'ENAMETOOLONG') return badRequest('That path is too long.');
  return new AppError(500, 'INTERNAL', 'Could not read that path.');
}

/** Absolute, NUL-free, <= 4096 chars, no `..` segments. POSIX only. */
function normalizeInput(raw: string | undefined): string {
  const value = raw === undefined || raw.length === 0 ? homeDir() : raw;
  if (value.length > MAX_PATH_LENGTH) throw badRequest('That path is too long.');
  if (value.includes('\u0000')) throw badRequest('That path contains an invalid character.');
  if (!path.isAbsolute(value)) throw badRequest('That path must be absolute.');
  if (value.split('/').includes('..')) throw badRequest('That path must not contain ".." segments.');
  return value;
}

function isRoot(candidate: string): boolean {
  return path.parse(candidate).root === candidate;
}

function isAncestor(ancestor: string, descendant: string): boolean {
  if (descendant === ancestor) return false;
  const prefix = ancestor.endsWith(path.sep) ? ancestor : `${ancestor}${path.sep}`;
  return descendant.startsWith(prefix);
}

async function isReadable(target: string): Promise<boolean> {
  try {
    await fsp.access(target, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a Host-supplied path to its canonical directory.
 * Absolute, realpath'd, a real directory, and readable by this process.
 */
export async function resolveHostDirectory(raw?: string, _options: HostPathOptions = {}): Promise<string> {
  const value = normalizeInput(raw);

  let real: string;
  try {
    real = await realpathNative(value);
  } catch (error) {
    throw pathError(error);
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(real);
  } catch (error) {
    throw pathError(error);
  }
  if (!stat.isDirectory()) throw badRequest('That path is not a directory.');
  if (!(await isReadable(real))) throw forbidden();
  return real;
}

/**
 * Refuse broad roots. Always: the filesystem root, the home directory, anything
 * that contains the home directory, and credential directories. System
 * directories are refused unless the Host passed `confirmBroad`.
 */
export async function assertSwitchable(target: string, options: HostPathOptions = {}): Promise<string> {
  const canonical = await resolveHostDirectory(target, options);
  const home = await realpathOrNull(options.home ?? homeDir());
  const systemDirs = await canonicalList(options.systemDirs ?? DEFAULT_SYSTEM_DIRS);
  const credentialDirs = await canonicalList(
    options.credentialDirs ?? (home ? CREDENTIAL_DIR_NAMES.map((name) => path.join(home, name)) : []),
  );

  const broad = (reason: string): never => {
    throw new AppError(400, 'BROAD_ROOT', reason);
  };

  if (isRoot(canonical)) throw new AppError(400, 'BROAD_ROOT', 'The filesystem root cannot be the project root.');

  // Credentials are refused outright: `confirmBroad` is for broad roots, and no
  // amount of confirmation makes ~/.ssh a sensible project for guest sessions.
  if (credentialDirs.some((dir) => canonical === dir || isAncestor(dir, canonical))) {
    broad('A credentials directory can never be the project root.');
  }

  // The home directory and its ancestors are refused outright: `~/.ssh` and
  // `~/.aws` are ordinary files under them, and every guest could read them.
  if (home && canonical === home) broad('The home directory can never be the project root.');
  if (home && isAncestor(canonical, home)) {
    broad('A directory that contains your home directory can never be the project root.');
  }

  if (options.confirmBroad !== true && systemDirs.includes(canonical)) {
    broad('A system directory needs confirmBroad: true.');
  }

  return canonical;
}

/**
 * Folder picker: directories only, never files or contents. Hidden entries are
 * excluded unless asked for, results are sorted by name and capped at 500.
 */
export async function listHostDirectories(
  raw?: string,
  showHidden = false,
  options: HostPathOptions = {},
): Promise<HostDirectoryListing> {
  const target = await resolveHostDirectory(raw, options);

  let dirents: fs.Dirent[];
  try {
    dirents = await fsp.readdir(target, { withFileTypes: true });
  } catch (error) {
    throw pathError(error);
  }

  const candidates: Array<{ name: string; absolute: string; isSymlink: boolean }> = [];
  for (const dirent of dirents) {
    if (!showHidden && dirent.name.startsWith('.')) continue;
    const absolute = path.join(target, dirent.name);
    if (dirent.isDirectory()) {
      candidates.push({ name: dirent.name, absolute, isSymlink: false });
      continue;
    }
    if (!dirent.isSymbolicLink()) continue;
    try {
      const stat = await fsp.stat(absolute);
      if (stat.isDirectory()) candidates.push({ name: dirent.name, absolute, isSymlink: true });
    } catch {
      // Dangling symlink: not a directory, so not offered.
    }
  }

  candidates.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  const entries = await Promise.all(
    candidates.slice(0, MAX_ENTRIES).map(async (candidate) => ({
      name: candidate.name,
      path: candidate.absolute,
      isSymlink: candidate.isSymlink,
      readable: await isReadable(candidate.absolute),
    })),
  );

  return {
    path: target,
    parent: isRoot(target) ? null : path.dirname(target),
    entries,
    truncated: candidates.length > MAX_ENTRIES,
  };
}
