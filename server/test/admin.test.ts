import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TestDocClient } from './helpers/docClient.js';
import { startTestServer, type TestServer } from './helpers/testServer.js';

let current: TestServer | undefined;
const fixtures: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await current?.cleanup();
  current = undefined;
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-admin-'));
  fixtures.push(dir);
  return dir;
}

interface AdminState {
  session: { id: string; rootName: string; rootPath: string; createdAt: number };
  openDocuments: number;
  documentConnections: number;
  terminals: number;
}

interface DirEntry {
  name: string;
  path: string;
  isSymlink: boolean;
  readable: boolean;
}

interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  truncated: boolean;
}

interface ApiError {
  error: { code: string; message: string };
}

async function adminJson<T>(route: string, init: RequestInit = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await current!.requestAdmin(route, init);
  const text = await response.text();
  const body = (text.length > 0 ? JSON.parse(text) : undefined) as T;
  return { status: response.status, body, headers: response.headers };
}

function listUrl(target: string, showHidden = false): string {
  return `/admin/api/fs/list?path=${encodeURIComponent(target)}${showHidden ? '&showHidden=1' : ''}`;
}

function makeTree(): string {
  const dir = fixture();
  for (const name of ['alpha', 'zeta', '.hidden', 'alpha/nested', 'locked']) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'file.txt'), 'not a directory\n');
  fs.writeFileSync(path.join(dir, '.dotfile'), 'hidden file\n');
  fs.symlinkSync(path.join(dir, 'alpha'), path.join(dir, 'link-to-alpha'), 'dir');
  return dir;
}

describe('admin listener', () => {
  it('binds to 127.0.0.1 even when the guest listens on every interface', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, bindHost: '0.0.0.0' });

    const guest = current.server.httpServer.address() as AddressInfo | null;
    const admin = current.server.admin.httpServer.address() as AddressInfo | null;

    expect(guest).not.toBeNull();
    expect(admin, 'the admin listener must be bound').not.toBeNull();
    expect(guest!.address).toBe('0.0.0.0');
    expect(admin!.address).toBe('127.0.0.1');
    expect(admin!.port).toBe(current.adminPort);
    expect(current.adminBase).toBe(`http://127.0.0.1:${admin!.port}`);
  });

  it('never serves admin routes on the guest port', async () => {
    current = await startTestServer({ files: { 'README.md': '# hi\n' } });

    const headerSets: Array<Record<string, string>> = [{}, { Authorization: `Bearer ${current.adminToken}` }];
    for (const headers of headerSets) {
      const response = await fetch(`${current.base}/admin/api/state`, { headers });
      expect(response.status).toBe(404);
      const body = (await response.json()) as ApiError;
      expect(body.error.code).toBe('NOT_FOUND');
    }

    // The guest app has no /admin route handlers at all: the whole prefix is a
    // default-deny middleware placed before the SPA fallback.
    const app = current.server.app as unknown as { _router: { stack: Array<{ route?: { path?: string } }> } };
    const adminRoutes = app._router.stack.filter((layer) => layer.route?.path?.startsWith('/admin'));
    expect(adminRoutes).toEqual([]);
  });

  it('keeps guest and admin tokens apart in both directions', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      tokens: {
        owner: 'owner-token-0123456789ab',
        editor: 'editor-token-0123456789ab',
        viewer: 'viewer-token-0123456789ab',
      },
    });

    for (const token of [current.tokens.owner, current.tokens.editor!, current.tokens.viewer!, 'garbage-token-value']) {
      const response = await current.requestAdmin('/admin/api/state', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status, token).toBe(401);
    }

    const missing = await current.requestAdmin('/admin/api/state', { headers: { Authorization: '' } });
    expect(missing.status).toBe(401);

    const adminOnGuest = await fetch(`${current.base}/api/session`, {
      headers: { Authorization: `Bearer ${current.adminToken}` },
    });
    expect(adminOnGuest.status).toBe(401);

    expect((await current.requestAdmin('/admin/api/state')).status).toBe(200);
  });

  it('requires the Host header to be the admin origin', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const port = current.adminPort;
    const admin = current.adminToken;

    // Every request below carries the valid admin token, so a 403 can only come
    // from the Host check, never from authentication.
    const withToken = { Authorization: `Bearer ${admin}` };

    for (const host of ['evil.example', '127.0.0.1:1', '127.0.0.1', 'localhost', `evil.example:${port}`]) {
      const response = await current.requestAdmin('/admin/api/state', {
        headers: { ...withToken, Host: host },
      });
      expect(response.status, host).toBe(403);
      expect(((await response.json()) as ApiError).error.code, host).toBe('FORBIDDEN');
    }

    // Positive control: same token, same request, correct Host on the same port.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const response = await current.requestAdmin('/admin/api/state', {
        headers: { ...withToken, Host: host },
      });
      expect(response.status, host).toBe(200);
      expect(await response.text(), host).toContain('session');
    }
  });

  it('limits Origin to the loopback admin origin', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const port = current.adminPort;

    for (const origin of [
      'http://evil.example',
      `http://127.0.0.1:${port + 1}`,
      `https://127.0.0.1:${port}`,
      'null',
    ]) {
      const response = await current.requestAdmin('/admin/api/state', { headers: { Origin: origin } });
      expect(response.status, origin).toBe(403);
    }

    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      const response = await current.requestAdmin('/admin/api/state', { headers: { Origin: origin } });
      expect(response.status, origin).toBe(200);
    }

    // Non-browser clients (curl) send no Origin and stay usable.
    expect((await current.requestAdmin('/admin/api/state')).status).toBe(200);
  });

  it('rejects requests that a proxy forwarded to the admin port', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });

    const forwarded: Record<string, string> = {
      'X-Forwarded-For': '203.0.113.7',
      'X-Forwarded-Host': 'evil.example',
      Forwarded: 'for=203.0.113.7;host=evil.example',
      'CF-Connecting-IP': '203.0.113.7',
      'X-Real-IP': '203.0.113.7',
    };

    for (const [name, value] of Object.entries(forwarded)) {
      const response = await current.requestAdmin('/admin/api/state', { headers: { [name]: value } });
      expect(response.status, name).toBe(403);
    }
  });

  it('never emits CORS headers, including on preflight', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const origin = `http://127.0.0.1:${current.adminPort}`;

    const responses = [
      await current.requestAdmin('/admin/api/state'),
      await current.requestAdmin('/admin/api/state', { method: 'OPTIONS' }),
      await current.requestAdmin('/admin/api/fs/list', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
      }),
      await current.requestAdmin('/admin/api/state', { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } }),
      await current.requestAdmin('/admin/api/session/root', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'relative' }),
      }),
    ];

    for (const response of responses) {
      for (const [name] of response.headers) {
        expect(name.toLowerCase().startsWith('access-control-'), name).toBe(false);
      }
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('never returns the admin token and never writes it to the console', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const token = current.adminToken;
    expect(token.length).toBeGreaterThanOrEqual(43);

    const captured: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const spies = [
      stdout,
      stderr,
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      }),
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      }),
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      }),
    ];

    const bodies: string[] = [];
    try {
      for (const route of ['/admin/api/state', '/admin/api/fs/list', '/admin/api/state']) {
        const response = await current.requestAdmin(route);
        bodies.push(response.headers.toString());
        bodies.push(await response.text());
      }
      const denied = await current.requestAdmin('/admin/api/state', { headers: { Host: 'evil.example' } });
      bodies.push(await denied.text());
      const wrongToken = await current.requestAdmin('/admin/api/state', {
        headers: { Authorization: `Bearer ${token.slice(0, -1)}` },
      });
      bodies.push(await wrongToken.text());
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const all = bodies.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toMatch(/"token"/);
    expect(captured.join('\n')).not.toContain(token);
  });

  it('audits every admin route: exact list, each gated by session.admin', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const { ADMIN_AUTHENTICATION } = await import('../src/admin/adminApp.js');
    const serverModule = await import('../src/server.js');

    type RouteLayer = {
      route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Record<PropertyKey, unknown> }> };
      handle?: Record<PropertyKey, unknown>;
    };
    const app = current.server.admin.app as unknown as { _router?: { stack: RouteLayer[] } };
    const layers = app._router?.stack ?? [];

    const authMounted = layers.some(
      (layer) => !layer.route && layer.handle?.[ADMIN_AUTHENTICATION] === true,
    );
    expect(authMounted).toBe(true);

    const routes = layers
      .filter(
        (layer): layer is RouteLayer & { route: NonNullable<RouteLayer['route']> } =>
          Boolean(layer.route && layer.route.path.startsWith('/admin/api')),
      )
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods).map((method) => method.toUpperCase()),
        gates: layer.route.stack
          .map((entry) => entry.handle[serverModule.CAPABILITY_GATE])
          .filter((value): value is string => typeof value === 'string'),
      }));

    expect(routes.map((route) => `${route.methods.join(',')} ${route.path}`).sort()).toEqual([
      'GET /admin/api/fs/list',
      'GET /admin/api/state',
      'POST /admin/api/session/root',
    ]);

    for (const route of routes) {
      expect(route.gates, `${route.path} must requireCap('session.admin')`).toEqual(['session.admin']);
    }
  });

  it('has no WebSocket upgrade handler on the admin port', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });

    const outcome = await new Promise<{ opened: boolean; error?: string }>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${current!.adminPort}/ws/doc`, ['codepair', current!.adminToken]);
      sockets.push(socket);
      const timer = setTimeout(() => resolve({ opened: false, error: 'timeout' }), 5000);
      socket.on('open', () => {
        clearTimeout(timer);
        resolve({ opened: true });
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        resolve({ opened: false, error: error.message });
      });
    });

    expect(outcome.opened).toBe(false);
    expect(outcome.error).not.toBe('timeout');
  });

  it('describes the active session and its open handles', async () => {
    current = await startTestServer({ files: { 'a.txt': 'hello\n' } });

    const initial = await adminJson<AdminState>('/admin/api/state');
    expect(initial.status).toBe(200);
    expect(initial.body.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(initial.body.session.rootName).toBe('project');
    expect(fs.realpathSync(initial.body.session.rootPath)).toBe(fs.realpathSync(current.root));
    expect(typeof initial.body.session.createdAt).toBe('number');
    expect(initial.body.openDocuments).toBe(0);
    expect(initial.body.documentConnections).toBe(0);
    expect(initial.body.terminals).toBe(0);

    const client = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'a.txt' });
    try {
      const open = await adminJson<AdminState>('/admin/api/state');
      expect(open.body.openDocuments).toBe(1);
      expect(open.body.documentConnections).toBe(1);
    } finally {
      client.destroy();
    }
  });

  it('closes both listeners and their keep-alive connections', async () => {
    const server = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const adminPort = server.adminPort;
    const guestPort = Number(new URL(server.base).port);
    const agent = new http.Agent({ keepAlive: true });

    await new Promise<void>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: guestPort, path: '/api/health', agent }, (response) => {
          response.resume();
          response.on('end', () => resolve());
        })
        .on('error', reject);
    });

    // Preconditions: both listeners really are up before shutdown, so the
    // post-close assertions below cannot pass vacuously.
    expect(server.server.httpServer.listening).toBe(true);
    expect(server.server.admin.httpServer.listening).toBe(true);

    await server.cleanup();

    expect(server.server.httpServer.listening).toBe(false);
    expect(server.server.admin.httpServer.listening).toBe(false);

    const outcome = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: adminPort });
      socket.on('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.on('error', (error) => resolve((error as NodeJS.ErrnoException).code ?? 'error'));
    });
    expect(outcome).toBe('ECONNREFUSED');
    agent.destroy();
  });
});

describe('folder picker', () => {
  it('lists only directories, sorted, with hidden ones excluded by default', async () => {
    const tree = makeTree();
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });

    const listed = await adminJson<DirListing>(listUrl(tree));
    expect(listed.status).toBe(200);
    expect(listed.body.path).toBe(fs.realpathSync(tree));
    expect(listed.body.entries.map((entry) => entry.name)).toEqual(['alpha', 'link-to-alpha', 'locked', 'zeta']);
    expect(listed.body.truncated).toBe(false);
    expect(listed.body.parent).toBe(path.dirname(fs.realpathSync(tree)));

    // never files, never contents or sizes
    for (const entry of listed.body.entries) {
      expect(Object.keys(entry).sort()).toEqual(['isSymlink', 'name', 'path', 'readable']);
    }
    expect(JSON.stringify(listed.body)).not.toContain('file.txt');
    expect(JSON.stringify(listed.body)).not.toContain('.dotfile');
  });

  it('shows hidden directories when asked', async () => {
    const tree = makeTree();
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });

    const listed = await adminJson<DirListing>(listUrl(tree, true));
    expect(listed.body.entries.map((entry) => entry.name)).toEqual([
      '.hidden',
      'alpha',
      'link-to-alpha',
      'locked',
      'zeta',
    ]);
  });

  it('flags a symlink to a directory', async () => {
    const tree = makeTree();
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });

    const listed = await adminJson<DirListing>(listUrl(tree));
    const link = listed.body.entries.find((entry) => entry.name === 'link-to-alpha');
    expect(link).toBeDefined();
    expect(link!.isSymlink).toBe(true);
    expect(link!.readable).toBe(true);
    expect(listed.body.entries.find((entry) => entry.name === 'alpha')!.isSymlink).toBe(false);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'marks an unreadable directory as not readable',
    async () => {
      const tree = makeTree();
      const locked = path.join(tree, 'locked');
      fs.chmodSync(locked, 0o000);
      current = await startTestServer({ files: { 'a.txt': 'x\n' } });

      try {
        const listed = await adminJson<DirListing>(listUrl(tree));
        const entry = listed.body.entries.find((candidate) => candidate.name === 'locked');
        expect(entry).toBeDefined();
        expect(entry!.readable).toBe(false);
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    },
  );

  it('rejects malformed, missing and non-directory paths without leaking paths', async () => {
    const tree = makeTree();
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const long = `/${'a'.repeat(5000)}`;

    const cases: Array<{ label: string; url: string; status: number }> = [
      { label: 'relative', url: listUrl('relative/path'), status: 400 },
      { label: 'dot-dot', url: listUrl(`${tree}/../..`), status: 400 },
      { label: 'nul byte', url: `/admin/api/fs/list?path=${encodeURIComponent(`${tree}\u0000x`)}`, status: 400 },
      { label: 'too long', url: listUrl(long), status: 400 },
      { label: 'missing', url: listUrl(path.join(tree, 'nope')), status: 404 },
      { label: 'a file', url: listUrl(path.join(tree, 'file.txt')), status: 400 },
    ];

    for (const testCase of cases) {
      const listed = await adminJson<ApiError>(testCase.url);
      expect(listed.status, testCase.label).toBe(testCase.status);
      expect(listed.body.error.code, testCase.label).toMatch(/^[A-Z_]+$/);
      const serialized = JSON.stringify(listed.body);
      expect(serialized, testCase.label).not.toContain(tree);
      expect(serialized, testCase.label).not.toContain('    at ');
    }
  });

  it('caps the listing at 500 entries and sets truncated', async () => {
    const tree = fixture();
    for (let index = 0; index < 502; index += 1) {
      fs.mkdirSync(path.join(tree, `dir-${String(index).padStart(3, '0')}`));
    }
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });

    const listed = await adminJson<DirListing>(listUrl(tree));
    expect(listed.status).toBe(200);
    expect(listed.body.entries).toHaveLength(500);
    expect(listed.body.truncated).toBe(true);
    expect(listed.body.entries[0]!.name).toBe('dir-000');
  });
});
