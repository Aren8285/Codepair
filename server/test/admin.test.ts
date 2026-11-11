import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TestDocClient } from './helpers/docClient.js';
import { startTestServer, waitFor, type TestServer } from './helpers/testServer.js';

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
      'DELETE /admin/api/rooms/:roomId',
      'GET /admin/api/events',
      'GET /admin/api/fs/list',
      'GET /admin/api/invites',
      'GET /admin/api/lobby',
      'GET /admin/api/policy',
      'GET /admin/api/rooms',
      'GET /admin/api/rooms/:roomId/events',
      'GET /admin/api/rooms/:roomId/invites',
      'GET /admin/api/rooms/:roomId/lobby',
      'GET /admin/api/rooms/:roomId/policy',
      'GET /admin/api/rooms/:roomId/state',
      'GET /admin/api/rooms/:roomId/tokens',
      'GET /admin/api/state',
      'GET /admin/api/tokens',
      'GET /admin/api/tunnel',
      'POST /admin/api/connections/:connectionId/kick',
      'POST /admin/api/invites',
      'POST /admin/api/invites/:id/revoke',
      'POST /admin/api/lobby/:id/admit',
      'POST /admin/api/lobby/:id/deny',
      'POST /admin/api/lobby/lock',
      'POST /admin/api/rooms',
      'POST /admin/api/rooms/:roomId/connections/:connectionId/kick',
      'POST /admin/api/rooms/:roomId/invites',
      'POST /admin/api/rooms/:roomId/invites/:id/revoke',
      'POST /admin/api/rooms/:roomId/lobby/:id/admit',
      'POST /admin/api/rooms/:roomId/lobby/:id/deny',
      'POST /admin/api/rooms/:roomId/lobby/lock',
      'POST /admin/api/rooms/:roomId/moderators',
      'POST /admin/api/rooms/:roomId/session/root',
      'POST /admin/api/rooms/:roomId/tokens/:role/rotate',
      'POST /admin/api/session/root',
      'POST /admin/api/tokens/:role/rotate',
      'PUT /admin/api/policy/rules',
      'PUT /admin/api/rooms/:roomId/policy/rules',
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

// ---------------------------------------------------------------------------
// v0.5: token rotation and tunnel status
// ---------------------------------------------------------------------------

const V5_OWNER = 'owner-token-0123456789ab';
const V5_EDITOR = 'editor-token-0123456789ab';
const V5_VIEWER = 'viewer-token-0123456789ab';
const V5_TOKENS = { owner: V5_OWNER, editor: V5_EDITOR, viewer: V5_VIEWER };

async function rotateRole(role: 'owner' | 'editor' | 'viewer') {
  return adminJson<{ role: string; token: string } & ApiError>(`/admin/api/tokens/${role}/rotate`, {
    method: 'POST',
  });
}

async function createV5Invite(role: 'editor' | 'viewer' = 'editor') {
  return adminJson<{ invite: { id: string; role: string; usedCount: number } } & ApiError>('/admin/api/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
}

async function redeemV5Invite(id: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${current!.base}/api/invites/${encodeURIComponent(id)}/redeem`, {
    method: 'POST',
  });
  return { status: response.status, text: await response.text() };
}

describe('[v0.5] token rotation', () => {
  it('[v0.5] rotates editor: new requests reject the old token while the open document socket keeps syncing', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'base\n' },
      tokens: V5_TOKENS,
    });

    const live = await TestDocClient.connect({
      wsUrl: current.wsUrl,
      token: V5_EDITOR,
      path: 'a.txt',
    });

    try {
      const rotated = await rotateRole('editor');
      expect(rotated.status).toBe(200);
      expect(rotated.body.role).toBe('editor');
      const next = rotated.body.token;
      expect(next).not.toBe(V5_EDITOR);
      expect(next.length).toBeGreaterThanOrEqual(16);

      const oldSession = await fetch(`${current.base}/api/session`, {
        headers: { Authorization: `Bearer ${V5_EDITOR}` },
      });
      expect(oldSession.status, 'the old token stops authenticating new requests').toBe(401);

      const newSession = await fetch(`${current.base}/api/session`, {
        headers: { Authorization: `Bearer ${next}` },
      });
      expect(newSession.status).toBe(200);

      // The already-open socket never re-authenticates: it can still write...
      live.text.insert(0, 'after-rotation ');
      const fresh = await TestDocClient.connect({
        wsUrl: current.wsUrl,
        token: next,
        path: 'a.txt',
      });
      try {
        await waitFor(
          () => fresh.text.toString().includes('after-rotation'),
          5000,
          'the post-rotation write to reach a new socket',
        );

        // ...and still receives from the new connection.
        fresh.text.insert(0, 'from-new-token ');
        await waitFor(
          () => live.text.toString().includes('from-new-token'),
          5000,
          'the old socket to receive the new socket update',
        );
      } finally {
        fresh.destroy();
      }

      await expect(
        TestDocClient.connect({ wsUrl: current.wsUrl, token: V5_EDITOR, path: 'a.txt' }),
        'a second new connection with the old token must fail',
      ).rejects.toThrow();
    } finally {
      live.destroy();
    }
  });

  it('[v0.5] rotating a role revokes its live invites instead of moving them to the new token', async () => {
    current = await startTestServer({
      lobby: true,
      files: { 'a.txt': 'x\n' },
      tokens: V5_TOKENS,
    });

    const created = await createV5Invite('editor');
    expect(created.status).toBe(201);
    const rotated = await rotateRole('editor');
    expect(rotated.status).toBe(200);
    expect(rotated.body.token).not.toBe(V5_EDITOR);

    const afterRotate = await redeemV5Invite(created.body.invite.id);
    const unknown = await redeemV5Invite('unknown-invite-id-0123456789');
    expect(afterRotate.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(afterRotate.text).toBe(unknown.text);

    expect(
      (
        await fetch(`${current.base}/api/session`, {
          headers: { Authorization: `Bearer ${V5_EDITOR}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${current.base}/api/session`, {
          headers: { Authorization: `Bearer ${rotated.body.token}` },
        })
      ).status,
    ).toBe(200);
  });

  it('[v0.5] refuses to rotate a role with no configured token, but rotates owner', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      tokens: { owner: V5_OWNER },
    });

    const missing = await rotateRole('viewer');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('TOKEN_NOT_CONFIGURED');

    const owner = await rotateRole('owner');
    expect(owner.status).toBe(200);
    expect(owner.body.token).not.toBe(V5_OWNER);

    expect(
      (
        await fetch(`${current.base}/api/session`, {
          headers: { Authorization: `Bearer ${V5_OWNER}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${current.base}/api/session`, {
          headers: { Authorization: `Bearer ${owner.body.token}` },
        })
      ).status,
    ).toBe(200);
  });

  it('[v0.5] returns a rotated token once and never exposes it on later GETs', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, tokens: V5_TOKENS });
    const rotated = await rotateRole('editor');
    expect(rotated.status).toBe(200);
    const token = rotated.body.token;

    for (const route of ['/admin/api/tokens', '/admin/api/state', '/admin/api/tunnel', '/admin/api/invites']) {
      const response = await current.requestAdmin(route);
      const text = await response.text();
      expect(response.status, route).toBe(200);
      expect(text, `${route} must not echo the rotated token`).not.toContain(token);
    }

    const again = await rotateRole('editor');
    expect(again.status).toBe(200);
    expect(again.body.token).not.toBe(token);
  });
});

describe('[v0.5] tunnel status', () => {
  it('[v0.5] reports configured false and install instructions without inventing a tunnel', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      tunnelStatus: {
        configured: false,
        provider: null,
        running: false,
        publicUrl: null,
        cloudflaredInstalled: false,
        installInstructions: 'Install cloudflared, then restart with --tunnel cloudflare.',
      },
    });

    const status = await adminJson<{
      configured: boolean;
      provider: string | null;
      running: boolean;
      publicUrl: string | null;
      cloudflaredInstalled: boolean;
      installInstructions: string | null;
    }>('/admin/api/tunnel');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      configured: false,
      provider: null,
      running: false,
      publicUrl: null,
      cloudflaredInstalled: false,
      installInstructions: 'Install cloudflared, then restart with --tunnel cloudflare.',
    });

    const guest = await fetch(`${current.base}/admin/api/tunnel`);
    expect(guest.status).toBe(404);
  });

  it('[v0.5] reports the live tunnel URL and installed state from the injected status', async () => {
    const mocked = {
      configured: true,
      provider: 'cloudflare' as const,
      running: true,
      publicUrl: 'https://example-test.trycloudflare.com',
      cloudflaredInstalled: true,
      installInstructions: null,
    };
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, tunnelStatus: mocked });

    const status = await adminJson<typeof mocked>('/admin/api/tunnel');
    expect(status.status).toBe(200);
    expect(status.body).toEqual(mocked);
    expect(JSON.stringify(status.body)).not.toContain(current.adminToken);
  });
});

describe('[v0.5] additional role and default-status coverage', () => {
  it('[v0.5] rotates viewer independently of owner and editor', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, tokens: V5_TOKENS });
    const rotated = await rotateRole('viewer');
    expect(rotated.status).toBe(200);
    expect(rotated.body.role).toBe('viewer');
    expect(rotated.body.token).not.toBe(V5_VIEWER);

    const oldViewer = await fetch(`${current.base}/api/session`, {
      headers: { Authorization: `Bearer ${V5_VIEWER}` },
    });
    expect(oldViewer.status).toBe(401);
    const newViewer = await fetch(`${current.base}/api/session`, {
      headers: { Authorization: `Bearer ${rotated.body.token}` },
    });
    expect(newViewer.status).toBe(200);
    expect(((await newViewer.json()) as { role: string }).role).toBe('viewer');

    // A different role's token is untouched by the rotation.
    const editor = await fetch(`${current.base}/api/session`, {
      headers: { Authorization: `Bearer ${V5_EDITOR}` },
    });
    expect(editor.status).toBe(200);
  });

  it('[v0.5] reports configured false by default when no tunnel flag was passed', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const status = await adminJson<{
      configured: boolean;
      provider: string | null;
      running: boolean;
      publicUrl: string | null;
      cloudflaredInstalled: boolean;
      installInstructions: string | null;
    }>('/admin/api/tunnel');

    expect(status.status).toBe(200);
    expect(status.body.configured).toBe(false);
    expect(status.body.provider).toBeNull();
    expect(status.body.running).toBe(false);
    expect(status.body.publicUrl).toBeNull();
    expect(typeof status.body.cloudflaredInstalled).toBe('boolean');
    expect(status.body.installInstructions).toContain('--tunnel cloudflare');
  });
});
