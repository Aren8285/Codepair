import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers/testServer.js';

let current: TestServer | undefined;

afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

async function request(ctx: TestServer, route: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${ctx.token}`);
  return fetch(`${ctx.base}${route}`, { ...init, headers });
}

async function apiJson<T = unknown>(
  ctx: TestServer,
  route: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await request(ctx, route, init);
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

describe('HTTP API', () => {
  it('requires the bearer token for API calls', async () => {
    current = await startTestServer({ files: { 'README.md': '# hi\n' } });
    const missing = await fetch(`${current.base}/api/session`);
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');

    const wrong = await fetch(`${current.base}/api/session`, { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);

    const health = await fetch(`${current.base}/api/health`);
    expect(health.status).toBe(200);

    const ok = await apiJson<{
      mode: string;
      role: string;
      rootName: string;
      roomId: string;
      capabilities: string[];
      rtc: { iceServers: unknown[] };
    }>(current, '/api/session');
    expect(ok.status).toBe(200);
    expect(ok.body.mode).toBe('read-write');
    expect(ok.body.role).toBe('owner');
    expect(ok.body.capabilities).toContain('fs.write');
    expect(ok.body.rootName).toBe('project');
    expect(ok.body.roomId).toMatch(/^[a-z0-9]{1,8}-[a-z0-9]{1,8}$/);
    expect(ok.body.rtc.iceServers.length).toBeGreaterThan(0);
  });

  it('lists real files, ignores heavy folders and never leaks absolute paths', async () => {
    current = await startTestServer({
      files: {
        'README.md': '# hi\n',
        'src/index.ts': 'export {};\n',
        'node_modules/pkg/index.js': 'module.exports = 1;\n',
        '.git/config': '[core]\n',
        '.hidden/secret.txt': 'visible?\n',
      },
    });
    const root = await apiJson<{ entries: Array<{ name: string; path: string; type: string }> }>(current, '/api/tree');
    expect(root.status).toBe(200);
    const names = root.body.entries.map((entry) => entry.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(names).toContain('.hidden');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
    expect(JSON.stringify(root.body)).not.toContain(current.root);

    const nested = await apiJson<{ entries: Array<{ name: string }> }>(current, '/api/tree?path=src');
    expect(nested.body.entries.map((entry) => entry.name)).toEqual(['index.ts']);
  });

  it('blocks traversal, absolute paths, NUL bytes and symlink escapes', async () => {
    current = await startTestServer({ files: { 'README.md': '# hi\n' } });
    const outsideDir = path.join(path.dirname(current.root), 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret\n');
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(current.root, 'leak.txt'));

    for (const route of [
      '/api/file?path=../outside/secret.txt',
      '/api/file?path=..%2Foutside%2Fsecret.txt',
      '/api/file?path=%2Fetc%2Fpasswd',
      '/api/file?path=leak.txt',
      '/api/tree?path=..',
      '/api/tree?path=../../',
    ]) {
      const result = await apiJson<{ error: { code: string } }>(current, route);
      expect([400, 403], `${route} returned ${result.status}`).toContain(result.status);
      expect(['PATH_ESCAPE', 'INVALID_PATH']).toContain(result.body.error.code);
    }

    const nul = await apiJson<{ error: { code: string } }>(current, '/api/file?path=README.md%00');
    expect(nul.status).toBe(400);
    expect(nul.body.error.code).toBe('INVALID_PATH');

    expect(fs.readFileSync(path.join(outsideDir, 'secret.txt'), 'utf8')).toBe('top secret\n');
  });

  it('reads text files and refuses binary files', async () => {
    current = await startTestServer({ files: { 'notes.txt': 'hello\n', 'blob.bin': 'abc\u0000def' } });
    const file = await apiJson<{ content: string; path: string }>(current, '/api/file?path=notes.txt');
    expect(file.status).toBe(200);
    expect(file.body.content).toBe('hello\n');
    expect(file.body.path).toBe('notes.txt');

    const binary = await apiJson<{ error: { code: string } }>(current, '/api/file?path=blob.bin');
    expect(binary.status).toBe(400);
    expect(binary.body.error.code).toBe('BINARY_FILE');
  });

  it('performs file create, rename and delete inside the sandbox', async () => {
    current = await startTestServer({ files: { 'README.md': '# hi\n' } });

    const directory = await apiJson<{ entry: { path: string } }>(current, '/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes', type: 'directory' }),
    });
    expect(directory.status).toBe(201);
    expect(fs.statSync(path.join(current.root, 'notes')).isDirectory()).toBe(true);

    const file = await apiJson<{ entry: { path: string } }>(current, '/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes/today.md', type: 'file', content: '# today\n' }),
    });
    expect(file.status).toBe(201);
    expect(fs.readFileSync(path.join(current.root, 'notes', 'today.md'), 'utf8')).toBe('# today\n');

    const duplicate = await apiJson<{ error: { code: string } }>(current, '/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes/today.md', type: 'file' }),
    });
    expect(duplicate.status).toBe(409);

    const traversal = await apiJson<{ error: { code: string } }>(current, '/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../escape.md', type: 'file', content: 'nope' }),
    });
    expect(traversal.status).toBe(403);
    expect(fs.existsSync(path.join(path.dirname(current.root), 'escape.md'))).toBe(false);

    const renamed = await apiJson<{ entry: { path: string } }>(current, '/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'notes/today.md', to: 'notes/tomorrow.md' }),
    });
    expect(renamed.status).toBe(200);
    expect(fs.existsSync(path.join(current.root, 'notes', 'today.md'))).toBe(false);
    expect(fs.existsSync(path.join(current.root, 'notes', 'tomorrow.md'))).toBe(true);

    const deleted = await apiJson<{ path: string }>(current, '/api/files?path=notes', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(fs.existsSync(path.join(current.root, 'notes'))).toBe(false);
  });

  it('protects the project root and .git from deletion', async () => {
    current = await startTestServer({ files: { 'README.md': '# hi\n' } });
    const dotGit = await apiJson<{ error: { code: string } }>(current, '/api/files?path=.git', { method: 'DELETE' });
    expect(dotGit.status).toBe(403);
    expect(dotGit.body.error.code).toBe('PROTECTED_PATH');
    const root = await apiJson<{ error: { code: string } }>(current, '/api/files?path=', { method: 'DELETE' });
    expect(root.status).toBe(400);
  });

  it('enforces read-only mode on every mutation but keeps reading available', async () => {
    current = await startTestServer({ files: { 'README.md': '# hi\n' }, args: ['--mode', 'read-only'] });

    const session = await apiJson<{ role: string; capabilities: string[] }>(current, '/api/session');
    expect(session.body.role).toBe('viewer');
    expect(session.body.capabilities).not.toContain('fs.write');
    expect(session.body.capabilities).not.toContain('term.use');

    const read = await apiJson<{ content: string }>(current, '/api/file?path=README.md');
    expect(read.status).toBe(200);

    for (const [route, init] of [
      [
        '/api/files',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'new.md', type: 'file' }),
        },
      ],
      [
        '/api/files/rename',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'README.md', to: 'renamed.md' }),
        },
      ],
      ['/api/files?path=README.md', { method: 'DELETE' }],
    ] as const) {
      const result = await apiJson<{ error: { code: string } }>(current, route, init);
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('FORBIDDEN');
    }
    expect(fs.existsSync(path.join(current.root, 'README.md'))).toBe(true);
  });

  it('searches file names with bounded results', async () => {
    current = await startTestServer({
      files: { 'src/app.tsx': '', 'src/App.css': '', 'docs/app-guide.md': '', 'node_modules/app/index.js': '' },
    });
    const result = await apiJson<{ entries: Array<{ path: string }>; truncated: boolean }>(current, '/api/search?q=app');
    expect(result.status).toBe(200);
    expect(result.body.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['src/app.tsx', 'src/App.css', 'docs/app-guide.md']),
    );
    expect(result.body.entries.some((entry) => entry.path.includes('node_modules'))).toBe(false);
  });

  it('rejects invalid JSON bodies without crashing', async () => {
    current = await startTestServer();
    const result = await fetch(`${current.base}/api/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    expect(result.status).toBe(400);
  });
});
