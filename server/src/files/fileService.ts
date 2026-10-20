import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { PathGuard } from '../security/pathGuard.js';

export const DEFAULT_IGNORED = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.DS_Store',
];

/** Server-side protected names: never listed, renamed or deleted through the API. */
const PROTECTED = new Set(['.git', 'node_modules']);

const MAX_TREE_ENTRIES = 4000;
const MAX_SEARCH_RESULTS = 200;
const BINARY_SNIFF_BYTES = 8000;

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: number;
  symlink?: boolean;
  blocked?: boolean;
}

export interface TreeResult {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  mtime: number;
}

export interface FileServiceOptions {
  maxFileBytes: number;
  ignored: Set<string>;
}

export class FileService {
  constructor(
    private readonly guard: PathGuard,
    private readonly options: FileServiceOptions,
  ) {}

  get maxFileBytes(): number {
    return this.options.maxFileBytes;
  }

  async tree(relativeDir = ''): Promise<TreeResult> {
    const absolute = this.guard.resolve(relativeDir);
    const stat = await fsp.stat(absolute);
    if (!stat.isDirectory()) throw new AppError(400, 'NOT_A_DIRECTORY', 'That path is not a directory.');

    const dirents = await fsp.readdir(absolute, { withFileTypes: true });
    const entries: FileEntry[] = [];
    let truncated = false;

    for (const dirent of dirents) {
      if (this.options.ignored.has(dirent.name)) continue;
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      const childRelative = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
      let symlink = false;
      let blocked = false;
      let size: number | undefined;
      let mtime: number | undefined;

      if (dirent.isSymbolicLink()) {
        symlink = true;
        try {
          this.guard.toRelative(fs.realpathSync(path.join(absolute, dirent.name)));
          const target = await fsp.stat(path.join(absolute, dirent.name));
          size = target.isFile() ? target.size : undefined;
          mtime = target.mtimeMs;
        } catch {
          blocked = true;
        }
      } else {
        try {
          const info = await fsp.stat(path.join(absolute, dirent.name));
          size = info.isFile() ? info.size : undefined;
          mtime = info.mtimeMs;
        } catch {
          blocked = true;
        }
      }

      entries.push({
        name: dirent.name,
        path: childRelative,
        type: dirent.isDirectory() ? 'directory' : 'file',
        ...(size !== undefined ? { size } : {}),
        ...(mtime !== undefined ? { mtime } : {}),
        ...(symlink ? { symlink: true } : {}),
        ...(blocked ? { blocked: true } : {}),
      });
    }

    entries.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });

    return { path: relativeDir, entries, truncated };
  }

  async read(relativePath: string): Promise<FileContent> {
    const file = await this.readTextForDocument(relativePath);
    return { path: file.relative, content: file.content, size: Buffer.byteLength(file.content), mtime: file.mtime };
  }

  async readTextForDocument(relativePath: string): Promise<{
    absolute: string;
    relative: string;
    content: string;
    mtime: number;
    ino: number;
  }> {
    if (!relativePath) throw new AppError(400, 'INVALID_PATH', 'A file path is required.');
    const absolute = this.guard.resolve(relativePath);
    const stat = await fsp.stat(absolute);
    if (!stat.isFile()) throw new AppError(400, 'INVALID_PATH', 'That path is not a file.');
    if (stat.size > this.options.maxFileBytes) {
      throw new AppError(413, 'FILE_TOO_LARGE', `Files larger than ${formatBytes(this.options.maxFileBytes)} cannot be opened.`);
    }
    const buffer = await fsp.readFile(absolute);
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      throw new AppError(400, 'BINARY_FILE', 'Binary files cannot be opened in the editor.');
    }
    return {
      absolute,
      relative: this.guard.toRelative(absolute),
      content: buffer.toString('utf8'),
      mtime: stat.mtimeMs,
      ino: stat.ino,
    };
  }

  async create(relativePath: string, type: 'file' | 'directory', content = ''): Promise<FileEntry> {
    this.assertNotProtected(relativePath);
    if (Buffer.byteLength(content) > this.options.maxFileBytes) {
      throw new AppError(413, 'FILE_TOO_LARGE', 'The new file is too large.');
    }
    const absolute = this.guard.resolve(relativePath);
    const parent = path.dirname(absolute);
    const parentStat = await fsp.stat(parent).catch(() => undefined);
    if (!parentStat?.isDirectory()) throw new AppError(400, 'INVALID_PATH', 'The parent folder does not exist.');
    if (path.relative(this.guard.root, parent).startsWith('..')) {
      throw new AppError(403, 'PATH_ESCAPE', 'That path is outside the project.');
    }

    try {
      if (type === 'directory') {
        await fsp.mkdir(absolute);
      } else {
        await fsp.writeFile(absolute, content, { flag: 'wx' });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AppError(409, 'ALREADY_EXISTS', 'Something already exists at that path.');
      }
      throw error;
    }

    const stat = await fsp.stat(absolute);
    return {
      name: path.basename(absolute),
      path: this.guard.toRelative(absolute),
      type,
      ...(type === 'file' ? { size: stat.size } : {}),
      mtime: stat.mtimeMs,
    };
  }

  async rename(from: string, to: string): Promise<FileEntry> {
    this.assertNotProtected(from);
    this.assertNotProtected(to);
    if (!from || !to) throw new AppError(400, 'INVALID_PATH', 'Both paths are required.');
    const source = this.guard.resolve(from);
    const target = this.guard.resolve(to);
    if (source === target) throw new AppError(400, 'INVALID_PATH', 'Source and destination are the same.');
    if (source === this.guard.root) throw new AppError(403, 'PROTECTED_PATH', 'The project root cannot be renamed.');
    if (target === this.guard.root) throw new AppError(403, 'PROTECTED_PATH', 'The project root cannot be replaced.');

    const targetParent = await fsp.stat(path.dirname(target)).catch(() => undefined);
    if (!targetParent?.isDirectory()) throw new AppError(400, 'INVALID_PATH', 'The destination folder does not exist.');
    if (await exists(target)) throw new AppError(409, 'ALREADY_EXISTS', 'The destination already exists.');

    const stat = await fsp.lstat(source);
    await fsp.rename(source, target);
    return {
      name: path.basename(target),
      path: this.guard.toRelative(target),
      type: stat.isDirectory() ? 'directory' : 'file',
      ...(stat.isFile() ? { size: stat.size } : {}),
      mtime: stat.mtimeMs,
    };
  }

  async remove(relativePath: string): Promise<{ path: string }> {
    this.assertNotProtected(relativePath);
    if (!relativePath) throw new AppError(400, 'INVALID_PATH', 'A path is required.');
    const absolute = this.guard.resolve(relativePath);
    if (absolute === this.guard.root) throw new AppError(403, 'PROTECTED_PATH', 'The project root cannot be deleted.');
    const stat = await fsp.lstat(absolute);
    await fsp.rm(absolute, { recursive: stat.isDirectory(), force: false });
    return { path: this.guard.toRelative(absolute) };
  }

  async search(query: string): Promise<{ query: string; entries: FileEntry[]; truncated: boolean }> {
    const needle = query.trim().toLowerCase();
    if (!needle) return { query, entries: [], truncated: false };

    const entries: FileEntry[] = [];
    const queue: string[] = [''];
    let visited = 0;
    let truncated = false;

    while (queue.length > 0) {
      const relativeDir = queue.shift()!;
      let dirents: fs.Dirent[];
      try {
        dirents = await fsp.readdir(this.guard.resolve(relativeDir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        visited += 1;
        if (visited > 8000) {
          truncated = true;
          break;
        }
        if (this.options.ignored.has(dirent.name)) continue;
        if (dirent.isSymbolicLink()) continue;
        const child = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) {
          queue.push(child);
        } else if (dirent.name.toLowerCase().includes(needle)) {
          entries.push({ name: dirent.name, path: child, type: 'file' });
          if (entries.length >= MAX_SEARCH_RESULTS) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }

    entries.sort((left, right) => left.path.localeCompare(right.path));
    return { query, entries, truncated };
  }

  private assertNotProtected(relativePath: string): void {
    if (!relativePath) return;
    const first = relativePath.split('/').filter(Boolean)[0];
    if (first && PROTECTED.has(first)) {
      throw new AppError(403, 'PROTECTED_PATH', 'That file is protected and cannot be modified through CodePair.');
    }
  }
}

export async function atomicWriteFile(absolutePath: string, content: string): Promise<void> {
  const directory = path.dirname(absolutePath);
  const temporary = path.join(directory, `.${path.basename(absolutePath)}.${randomBytes(6).toString('hex')}.tmp`);
  await fsp.writeFile(temporary, content, { mode: 0o644 });
  try {
    await fsp.rename(temporary, absolutePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fsp.lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}
