import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathGuard, SandboxError } from '../src/security/pathGuard.js';

let base: string;
let root: string;
let guard: PathGuard;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-guard-'));
  root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export {};\n');

  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret\n');
  fs.symlinkSync(path.join(base, 'outside', 'secret.txt'), path.join(root, 'leak.txt'));
  fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'outside-dir'));
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'src-link'));

  guard = new PathGuard(root);
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function expectCode(fn: () => unknown, code: 'INVALID_PATH' | 'PATH_ESCAPE'): void {
  try {
    fn();
    throw new Error('expected SandboxError');
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).code).toBe(code);
  }
}

describe('PathGuard', () => {
  it('canonicalises the root', () => {
    expect(guard.root).toBe(fs.realpathSync(root));
  });

  it.each(['', 'README.md', 'src', 'src/app.ts', './README.md', 'src//app.ts', 'src/./app.ts'])(
    'accepts %j',
    (input) => {
      const resolved = guard.resolve(input);
      expect(path.relative(guard.root, resolved)).not.toMatch(/^\.\./);
    },
  );

  it.each([
    '../etc/passwd',
    '..',
    'a/../../b',
    'src/../README.md',
    'src/..',
    '../../../../tmp',
    '/etc/passwd',
    '//etc/passwd',
    'C:\\Windows\\win.ini',
    'c:/windows',
    'src\\app.ts',
    '~/secret',
    'a\0b',
  ])('rejects %j', (input) => {
    expect(() => guard.resolve(input)).toThrow(SandboxError);
  });

  it('distinguishes invalid paths from escapes', () => {
    expectCode(() => guard.resolve('/etc/passwd'), 'INVALID_PATH');
    expectCode(() => guard.resolve('~/x'), 'INVALID_PATH');
    expectCode(() => guard.resolve('..'), 'PATH_ESCAPE');
    expectCode(() => guard.resolve('src/../../x'), 'PATH_ESCAPE');
  });

  it('rejects symlinks that point outside the root', () => {
    expectCode(() => guard.resolve('leak.txt'), 'PATH_ESCAPE');
    expectCode(() => guard.resolve('outside-dir/secret.txt'), 'PATH_ESCAPE');
  });

  it('allows symlinks that stay inside the root', () => {
    const resolved = guard.resolve('src-link/app.ts');
    expect(path.basename(resolved)).toBe('app.ts');
  });

  it('rejects creation through an escaping symlinked directory', () => {
    expectCode(() => guard.resolve('outside-dir/new-file.txt'), 'PATH_ESCAPE');
  });

  it('allows paths that do not exist yet but stay inside', () => {
    expect(guard.resolve('src/new-file.ts')).toBe(path.join(guard.root, 'src', 'new-file.ts'));
  });

  it('round-trips toRelative and rejects outside paths', () => {
    expect(guard.toRelative(path.join(guard.root, 'src', 'app.ts'))).toBe('src/app.ts');
    expectCode(() => guard.toRelative(path.join(base, 'outside', 'secret.txt')), 'PATH_ESCAPE');
  });

  it('rejects non-string input', () => {
    expectCode(() => guard.resolve(42 as unknown as string), 'INVALID_PATH');
  });
});
