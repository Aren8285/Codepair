import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as encoding from 'lib0/encoding';
import * as authModule from '../src/security/auth.js';
import * as serverModule from '../src/server.js';
import { AppError } from '../src/errors.js';
import { ConfigError, parseConfig } from '../src/config.js';
import type { Capability, Principal } from '../src/security/principal.js';
import { TEST_TOKEN, startTestServer, waitFor, type TestServer } from './helpers/testServer.js';
import { TestDocClient } from './helpers/docClient.js';

const EDITOR_TOKEN = 'editor-token-0123456789ab';
const VIEWER_TOKEN = 'viewer-token-0123456789ab';
const STRANGER_TOKEN = 'stranger-token-0123456789';

let current: TestServer | undefined;
const clients: TestDocClient[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const socket of sockets.splice(0)) {
    try {
      socket.terminate();
    } catch {
      // already gone
    }
  }
  await current?.cleanup();
  current = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tenant(): TestServer {
  if (!current) throw new Error('test server is not running');
  return current;
}

async function connectDoc(ctx: TestServer, token: string, file: string): Promise<TestDocClient> {
  const client = await TestDocClient.connect({ wsUrl: ctx.wsUrl, token, path: file });
  clients.push(client);
  return client;
}

async function sessionInfo(ctx: TestServer, token: string): Promise<{
  status: number;
  body: { role?: string; mode?: string; capabilities?: string[] };
}> {
  const response = await fetch(`${ctx.base}/api/session`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: (await response.json()) as { role?: string; mode?: string; capabilities?: string[] } };
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return body.error;
}

interface TerminalResult {
  closeCode?: number;
  closeReason?: string;
  output: string;
  ready: boolean;
}

/** Open /ws/terminal with one token and collect everything until it closes. */
function runTerminal(ctx: TestServer, token: string): Promise<TerminalResult> {
  const url = ctx.wsUrl.replace('/ws/doc', '/ws/terminal');
  return new Promise((resolve) => {
    const result: TerminalResult = { output: '', ready: false };
    const socket = new WebSocket(url, ['codepair', token]);
    sockets.push(socket);
    const timer = setTimeout(() => socket.close(), 4000);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'input', data: 'echo role-pty-ok\r' }));
    });
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(String(data)) as { type?: string; data?: string };
        if (message.type === 'ready') result.ready = true;
        if (message.type === 'output' && typeof message.data === 'string') {
          result.output += message.data;
          if (/role-pty-ok/.test(result.output)) socket.close();
        }
      } catch {
        // ignore non-JSON frames
      }
    });
    socket.on('close', (code, reason) => {
      result.closeCode = code;
      result.closeReason = String(reason);
      finish();
    });
    socket.on('error', finish);
  });
}

function joinSignal(ctx: TestServer, token: string): Promise<{ type?: string; code?: string }> {
  const port = new URL(ctx.wsUrl).port;
  const url = `ws://127.0.0.1:${port}/ws/signal?room=${encodeURIComponent(ctx.config.roomId)}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ['codepair', token]);
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error('signalling join timed out')), 5000);
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'join', name: 'Tester', color: '#3366ff', mic: true, cam: false, screen: false }));
    });
    socket.on('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as { type?: string; code?: string });
      socket.close();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Ask the server to flush an open document (META control frame, type "flush"). */
function sendFlush(client: TestDocClient): void {
  const socket = (client as unknown as { socket?: WebSocket }).socket;
  if (!socket) throw new Error('document client has no socket');
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint8Array(encoder, new TextEncoder().encode(JSON.stringify({ type: 'flush' })));
  socket.send(encoding.toUint8Array(encoder));
}

type GateMiddleware = (request: unknown, response: unknown, next: (error?: unknown) => void) => void;

interface ServerGates {
  requireCap?: (capability: string) => GateMiddleware;
}

interface AuthFactory {
  createAuthenticator(
    grants: ReadonlyArray<{ token: string; role: 'owner' | 'editor' | 'viewer' }>,
    compare?: (left: Buffer, right: Buffer) => boolean,
  ): (rawToken: string | undefined | null) => Principal | null;
}

function buildAuthenticator(
  grants: ReadonlyArray<{ token: string; role: 'owner' | 'editor' | 'viewer' }>,
  compare: (left: Buffer, right: Buffer) => boolean,
): (rawToken: string | undefined | null) => Principal | null {
  const factory = (authModule as unknown as Partial<AuthFactory>).createAuthenticator;
  if (!factory) throw new Error('createAuthenticator is not exported by server/src/security/auth.ts yet');
  return factory(grants, compare);
}

describe('role tokens and HTTP capabilities', () => {
  it('authenticates every configured role token and rejects an unknown token', async () => {
    current = await startTestServer({
      files: { 'README.md': '# hi\n' },
      tokens: { editor: EDITOR_TOKEN, viewer: VIEWER_TOKEN },
    });

    for (const [role, token] of [
      ['owner', current.tokens.owner],
      ['editor', EDITOR_TOKEN],
      ['viewer', VIEWER_TOKEN],
    ] as const) {
      const session = await sessionInfo(current, token);
      expect(session.status, `${role} session`).toBe(200);
      expect(session.body.role).toBe(role);
      expect(session.body.capabilities).toContain('fs.read');
    }

    const stranger = await sessionInfo(current, STRANGER_TOKEN);
    expect(stranger.status).toBe(401);

    const missing = await fetch(`${current.base}/api/session`);
    expect(missing.status).toBe(401);
    expect((await errorOf(missing)).code).toBe('UNAUTHORIZED');
  });

  it('refuses to start when two roles share a token', () => {
    const shared = 'shared-token-0123456789abcd';
    expect(() => parseConfig(['--root', process.cwd(), '--token', shared, '--editor-token', shared], {})).toThrow(
      ConfigError,
    );
    expect(() => parseConfig(['--root', process.cwd(), '--token', shared, '--viewer-token', shared], {})).toThrow(
      /distinct/i,
    );
    expect(() =>
      parseConfig(['--root', process.cwd(), '--editor-token', shared, '--viewer-token', shared], {}),
    ).toThrow(ConfigError);
  });

  it('lets a viewer read but not create, rename or delete, and leaves the disk untouched', async () => {
    current = await startTestServer({
      files: { 'README.md': '# hi\n', 'notes/keep.md': 'keep\n' },
      tokens: { viewer: VIEWER_TOKEN },
    });

    expect((await current.requestAs('viewer', '/api/tree')).status).toBe(200);
    expect((await current.requestAs('viewer', '/api/tree?path=notes')).status).toBe(200);
    expect((await current.requestAs('viewer', '/api/file?path=README.md')).status).toBe(200);
    expect((await current.requestAs('viewer', '/api/search?q=keep')).status).toBe(200);

    const created = await current.requestAs('viewer', '/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'new.md', type: 'file', content: 'nope\n' }),
    });
    expect(created.status).toBe(403);
    const createError = await errorOf(created);
    expect(createError.code).toBe('FORBIDDEN');
    expect(createError.message).toMatch(/not permitted|permission/i);
    expect(createError.message).not.toContain('fs.write');

    const renamed = await current.requestAs('viewer', '/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'README.md', to: 'renamed.md' }),
    });
    expect(renamed.status).toBe(403);
    expect((await errorOf(renamed)).code).toBe('FORBIDDEN');

    const deleted = await current.requestAs('viewer', '/api/files?path=README.md', { method: 'DELETE' });
    expect(deleted.status).toBe(403);
    expect((await errorOf(deleted)).code).toBe('FORBIDDEN');

    expect(fs.readFileSync(path.join(current.root, 'README.md'), 'utf8')).toBe('# hi\n');
    expect(fs.readFileSync(path.join(current.root, 'notes', 'keep.md'), 'utf8')).toBe('keep\n');
    expect(fs.existsSync(path.join(current.root, 'new.md'))).toBe(false);
    expect(fs.existsSync(path.join(current.root, 'renamed.md'))).toBe(false);
  });

  it('lets an editor create, write through the document, rename and delete', async () => {
    current = await startTestServer({
      files: { 'README.md': '# hi\n' },
      tokens: { editor: EDITOR_TOKEN },
    });

    const directory = await current.requestAs('editor', '/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes', type: 'directory' }),
    });
    expect(directory.status).toBe(201);

    const file = await current.requestAs('editor', '/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes/today.md', type: 'file', content: '# today\n' }),
    });
    expect(file.status).toBe(201);
    expect(fs.readFileSync(path.join(current.root, 'notes', 'today.md'), 'utf8')).toBe('# today\n');

    const editor = await connectDoc(current, EDITOR_TOKEN, 'notes/today.md');
    await waitFor(() => editor.text.toString() === '# today\n', 3000, 'editor initial content');
    editor.text.insert(editor.text.length, 'editor-was-here\n');
    await waitFor(
      () => fs.readFileSync(path.join(current!.root, 'notes', 'today.md'), 'utf8').includes('editor-was-here'),
      5000,
      'editor write persisted',
    );

    const renamed = await current.requestAs('editor', '/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'notes/today.md', to: 'notes/tomorrow.md' }),
    });
    expect(renamed.status).toBe(200);
    expect(fs.existsSync(path.join(current.root, 'notes', 'tomorrow.md'))).toBe(true);

    const deleted = await current.requestAs('editor', '/api/files?path=notes', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(fs.existsSync(path.join(current.root, 'notes'))).toBe(false);
  });

  it('gives the viewer the document but drops its edits before they reach the server', async () => {
    current = await startTestServer({
      files: { 'locked.md': 'original\n' },
      tokens: { viewer: VIEWER_TOKEN },
    });

    const viewer = await connectDoc(current, VIEWER_TOKEN, 'locked.md');
    expect(viewer.text.toString()).toBe('original\n');

    viewer.text.insert(0, 'VIEWER-EDIT ');
    await waitFor(() => viewer.metas.some((meta) => meta.type === 'denied'), 5000, 'denied meta');
    await sleep(250);

    expect(fs.readFileSync(path.join(current.root, 'locked.md'), 'utf8')).toBe('original\n');

    const owner = await connectDoc(current, current.tokens.owner, 'locked.md');
    await waitFor(() => owner.text.toString() === 'original\n', 3000, 'owner initial content');
    await sleep(150);
    expect(owner.text.toString()).not.toContain('VIEWER-EDIT');
  });

  it('ignores a viewer flush control message instead of writing to disk', async () => {
    current = await startTestServer({
      files: { 'locked.md': 'original\n' },
      tokens: { viewer: VIEWER_TOKEN },
    });

    const viewer = await connectDoc(current, VIEWER_TOKEN, 'locked.md');
    viewer.text.insert(0, 'NOPE ');
    await waitFor(() => viewer.metas.some((meta) => meta.type === 'denied'), 5000, 'denied meta');

    sendFlush(viewer);
    await sleep(400);

    expect(fs.readFileSync(path.join(current.root, 'locked.md'), 'utf8')).toBe('original\n');
    expect(viewer.metas.some((meta) => meta.type === 'saved')).toBe(false);
  });

  it('still shows a viewer cursor to other clients while their edit stays local', async () => {
    current = await startTestServer({
      files: { 'shared.md': 'base\n' },
      tokens: { viewer: VIEWER_TOKEN },
    });

    const viewer = await connectDoc(current, VIEWER_TOKEN, 'shared.md');
    const owner = await connectDoc(current, current.tokens.owner, 'shared.md');
    await waitFor(() => owner.text.toString() === 'base\n', 3000, 'owner initial content');

    viewer.setUser('ViewerAware', '#ff00aa');
    await waitFor(() => {
      const states = [...owner.awareness.getStates().values()] as Array<{ user?: { name: string } }>;
      return states.some((state) => state.user?.name === 'ViewerAware');
    }, 5000, 'viewer awareness on the owner');

    viewer.text.insert(0, 'hidden ');
    await waitFor(() => viewer.metas.some((meta) => meta.type === 'denied'), 5000, 'denied meta');
    await sleep(200);

    expect(owner.text.toString()).toBe('base\n');
    expect(fs.readFileSync(path.join(current.root, 'shared.md'), 'utf8')).toBe('base\n');
  });

  it('drops a viewer edit that arrives in its sync step 2 reply', async () => {
    current = await startTestServer({
      files: { 'preconnect.md': 'original\n' },
      tokens: { viewer: VIEWER_TOKEN },
    });

    // Edit before opening the socket: the change can only travel in the client's
    // sync step 2 answer to the server's step 1, never as a live update.
    const viewer = new TestDocClient({ wsUrl: current.wsUrl, token: VIEWER_TOKEN, path: 'preconnect.md' });
    clients.push(viewer);
    viewer.text.insert(0, 'PRE-CONNECT ');
    await viewer.open();
    await viewer.waitForSync();

    await waitFor(() => viewer.metas.some((meta) => meta.type === 'denied'), 5000, 'denied meta for sync step 2');
    await sleep(250);

    expect(fs.readFileSync(path.join(current.root, 'preconnect.md'), 'utf8')).toBe('original\n');

    const owner = await connectDoc(current, current.tokens.owner, 'preconnect.md');
    await waitFor(() => owner.text.toString() === 'original\n', 3000, 'owner initial content');
    await sleep(150);
    expect(owner.text.toString()).not.toContain('PRE-CONNECT');
  });

  it('still drops a viewer edit that is replayed after reconnecting', async () => {
    current = await startTestServer({
      files: { 'reconnect.md': 'base\n' },
      tokens: { viewer: VIEWER_TOKEN },
    });

    const viewer = await connectDoc(current, VIEWER_TOKEN, 'reconnect.md');
    await waitFor(() => viewer.text.toString() === 'base\n', 3000, 'viewer initial content');

    viewer.closeSocket();
    viewer.text.insert(0, 'RECONNECTED ');
    await viewer.reconnect();

    await waitFor(() => viewer.metas.some((meta) => meta.type === 'denied'), 5000, 'denied meta after reconnect');
    await sleep(250);

    expect(fs.readFileSync(path.join(current.root, 'reconnect.md'), 'utf8')).toBe('base\n');
  });

  it('keeps /api/health public and answers 401 for missing or garbage tokens', async () => {
    current = await startTestServer({ files: { 'README.md': '# hi\n' }, tokens: { viewer: VIEWER_TOKEN } });

    expect((await fetch(`${current.base}/api/health`)).status).toBe(200);

    for (const route of ['/api/session', '/api/tree', '/api/file?path=README.md']) {
      const anonymous = await fetch(`${current.base}${route}`);
      expect(anonymous.status, `${route} anonymous`).toBe(401);
      expect((await errorOf(anonymous)).code).toBe('UNAUTHORIZED');

      const garbage = await fetch(`${current.base}${route}`, {
        headers: { Authorization: 'Bearer garbage-token-0123456789ab' },
      });
      expect(garbage.status, `${route} garbage token`).toBe(401);
      expect((await errorOf(garbage)).code).toBe('UNAUTHORIZED');
    }
  });
});

describe('terminal and call capabilities', () => {
  it('closes the viewer terminal with 4403 while an editor gets a real PTY', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      tokens: { editor: EDITOR_TOKEN, viewer: VIEWER_TOKEN },
      env: { CODE_PAIR_TERMINAL: 'on' },
    });

    const viewer = await runTerminal(current, VIEWER_TOKEN);
    expect(viewer.closeCode).toBe(4403);
    expect(viewer.output).toBe('');
    expect(viewer.ready).toBe(false);

    const editor = await runTerminal(current, EDITOR_TOKEN);
    expect(editor.ready).toBe(true);
    expect(editor.output).toMatch(/role-pty-ok/);
  });

  it('keeps the terminal feature flag ahead of the capability', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      args: ['--no-terminal'],
      tokens: { editor: EDITOR_TOKEN },
      env: { CODE_PAIR_TERMINAL: 'on' },
    });

    const editor = await runTerminal(current, EDITOR_TOKEN);
    expect(editor.closeCode).toBe(4403);
    expect(editor.closeReason).toMatch(/disabled/i);
    expect(editor.ready).toBe(false);
  });

  it('lets a viewer join signalling but never an unauthenticated socket', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, tokens: { viewer: VIEWER_TOKEN } });

    const joined = await joinSignal(current, VIEWER_TOKEN);
    expect(joined.type).toBe('joined');

    const port = Number(new URL(current.wsUrl).port);
    const status = await new Promise<number>((resolve, reject) => {
      const request = [
        'GET /ws/signal HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: codepair, wrong-token-0123456789abcdef',
        '\r\n',
      ].join('\r\n');
      const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('no response'));
      }, 4000);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
      });
      socket.on('close', () => {
        clearTimeout(timer);
        resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1] ?? 0));
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(status).toBe(401);
  });

  it('keeps two simultaneous connections on their own principals', async () => {
    current = await startTestServer({
      files: { 'team.md': 'base\n' },
      tokens: { viewer: VIEWER_TOKEN },
    });

    const [owner, viewer] = await Promise.all([
      connectDoc(current, current.tokens.owner, 'team.md'),
      connectDoc(current, VIEWER_TOKEN, 'team.md'),
    ]);
    await waitFor(() => owner.text.toString() === 'base\n' && viewer.text.toString() === 'base\n', 3000, 'initial sync');

    const [ownerSession, viewerSession] = await Promise.all([
      sessionInfo(current, current.tokens.owner),
      sessionInfo(current, VIEWER_TOKEN),
    ]);
    expect(ownerSession.body.role).toBe('owner');
    expect(viewerSession.body.role).toBe('viewer');
    expect(ownerSession.body.capabilities).toContain('fs.write');
    expect(viewerSession.body.capabilities).not.toContain('fs.write');

    owner.text.insert(owner.text.length, 'OWNER\n');
    viewer.text.insert(0, 'VIEWER\n');

    const [ownerCreate, viewerCreate] = await Promise.all([
      current.requestAs('owner', '/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'owner.md', type: 'file', content: 'owner\n' }),
      }),
      current.requestAs('viewer', '/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'viewer.md', type: 'file', content: 'viewer\n' }),
      }),
    ]);
    expect(ownerCreate.status).toBe(201);
    expect(viewerCreate.status).toBe(403);

    await waitFor(
      () => fs.readFileSync(path.join(current!.root, 'team.md'), 'utf8').includes('OWNER'),
      5000,
      'owner write persisted',
    );
    await sleep(250);
    const onDisk = fs.readFileSync(path.join(current.root, 'team.md'), 'utf8');
    expect(onDisk).not.toContain('VIEWER');
    expect(fs.existsSync(path.join(current.root, 'viewer.md'))).toBe(false);
  });
});

describe('mode compatibility', () => {
  it('treats --token with --mode read-only exactly like the old read-only session', async () => {
    current = await startTestServer({
      files: { 'README.md': '# hi\n' },
      args: ['--mode', 'read-only'],
      env: { CODE_PAIR_TERMINAL: 'on' },
    });

    const session = await sessionInfo(current, current.token);
    expect(session.status).toBe(200);
    expect(session.body.role).toBe('viewer');
    expect(session.body.mode).toBe('read-only');
    expect(session.body.capabilities).not.toContain('fs.write');
    expect(session.body.capabilities).not.toContain('fs.delete');
    expect(session.body.capabilities).not.toContain('term.use');

    expect((await current.requestAs('owner', '/api/file?path=README.md')).status).toBe(200);

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
      const result = await current.requestAs('owner', route, init);
      expect(result.status, route).toBe(403);
      expect((await errorOf(result)).code).toBe('FORBIDDEN');
    }
    expect(fs.existsSync(path.join(current.root, 'README.md'))).toBe(true);

    const terminal = await runTerminal(current, current.token);
    expect(terminal.closeCode).toBe(4403);
    expect(terminal.output).toBe('');
  });
});

describe('authentication timing', () => {
  const grants = [
    { token: 'owner-token-0123456789abcd', role: 'owner' as const },
    { token: 'editor-token-0123456789ab', role: 'editor' as const },
    { token: 'viewer-token-0123456789ab', role: 'viewer' as const },
  ];

  function countingCompare() {
    const state = { calls: 0 };
    const compare = (left: Buffer, right: Buffer): boolean => {
      state.calls += 1;
      return timingSafeEqual(left, right);
    };
    return { state, compare };
  }

  it('compares every configured token, whatever matches', () => {
    const cases: Array<{ label: string; presented: string; role: string | null }> = [
      { label: 'first token', presented: grants[0]!.token, role: 'owner' },
      { label: 'middle token', presented: grants[1]!.token, role: 'editor' },
      { label: 'last token', presented: grants[2]!.token, role: 'viewer' },
      { label: 'wrong, same length', presented: 'nope-token-0123456789abcde', role: null },
      { label: 'wrong, different length', presented: 'short', role: null },
    ];

    for (const testCase of cases) {
      const { state, compare } = countingCompare();
      const authenticate = buildAuthenticator(grants, compare);
      const principal = authenticate(testCase.presented);
      expect(principal?.role ?? null, testCase.label).toBe(testCase.role);
      expect(state.calls, `${testCase.label} compare calls`).toBe(grants.length);
    }
  });

  it('rejects a missing token and an unknown token without a principal', () => {
    const { compare } = countingCompare();
    const authenticate = buildAuthenticator(grants, compare);
    expect(authenticate(undefined)).toBeNull();
    expect(authenticate(null)).toBeNull();
    expect(authenticate('')).toBeNull();
  });
});

describe('gates that no real role can trip', () => {
  // No role grants an empty capability set, so a hand-built principal is the
  // only way to prove the gates fail closed instead of being dead code.
  const emptyPrincipal: Principal = {
    id: 'empty-principal-00000000-0000-4000-8000-000000000000',
    role: 'viewer',
    capabilities: new Set<Capability>(),
  };

  async function principalsModule(): Promise<{
    can: (principal: Principal | null | undefined, capability: Capability) => boolean;
    CAPABILITIES: readonly Capability[];
  }> {
    try {
      return (await import('../src/security/principal.js')) as {
        can: (principal: Principal | null | undefined, capability: Capability) => boolean;
        CAPABILITIES: readonly Capability[];
      };
    } catch {
      throw new Error('server/src/security/principal.ts does not exist yet');
    }
  }

  async function startWithEmptyPrincipal(files: Record<string, string> = { 'README.md': '# hi\n' }): Promise<TestServer> {
    const factory = (authModule as unknown as Partial<AuthFactory>).createAuthenticator;
    if (!factory) throw new Error('createAuthenticator is not exported by server/src/security/auth.ts yet');
    const real = factory([
      { token: TEST_TOKEN, role: 'owner' },
      { token: VIEWER_TOKEN, role: 'viewer' },
    ]);
    return startTestServer({
      files,
      tokens: { viewer: VIEWER_TOKEN },
      authOverride: (rawToken) => (rawToken === TEST_TOKEN ? emptyPrincipal : real(rawToken)),
    });
  }

  it('denies every capability on a principal that has none', async () => {
    const { can, CAPABILITIES } = await principalsModule();
    for (const capability of CAPABILITIES) {
      expect(can(emptyPrincipal, capability), capability).toBe(false);
    }
    expect(can(emptyPrincipal, 'fs.read')).toBe(false);
    expect(can(emptyPrincipal, 'call.join')).toBe(false);
  });

  it('returns 403 FORBIDDEN from requireCap for that principal', async () => {
    const gates = serverModule as unknown as Partial<ServerGates>;
    if (!gates.requireCap) throw new Error('requireCap is not exported by server/src/server.ts yet');
    const middleware = gates.requireCap('fs.read');

    const error = await new Promise<unknown>((resolve) => {
      middleware({ principal: emptyPrincipal }, {}, (nextError?: unknown) => resolve(nextError));
    });
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(403);
    expect((error as AppError).code).toBe('FORBIDDEN');
    expect((error as AppError).message).not.toContain('fs.read');

    current = await startWithEmptyPrincipal();
    const forbidden = await current.requestAs('owner', '/api/tree');
    expect(forbidden.status).toBe(403);
    expect((await errorOf(forbidden)).code).toBe('FORBIDDEN');

    // Proof the seam only removes capabilities: a real viewer still reads.
    expect((await current.requestAs('viewer', '/api/tree')).status).toBe(200);
  });

  it('refuses the document upgrade for that principal', async () => {
    current = await startWithEmptyPrincipal({ 'doc.md': 'text\n' });
    const port = new URL(current.wsUrl).port;

    const outcome = await new Promise<{ opened: boolean; error?: string }>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/doc?path=doc.md`, ['codepair', TEST_TOKEN]);
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
    expect(outcome.error).toMatch(/403/);
  });

  it('closes signalling with 4403 on join for that principal', async () => {
    current = await startWithEmptyPrincipal();
    const port = new URL(current.wsUrl).port;

    const code = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/ws/signal?room=${encodeURIComponent(current!.config.roomId)}`,
        ['codepair', TEST_TOKEN],
      );
      sockets.push(socket);
      const timer = setTimeout(() => reject(new Error('signalling socket never closed')), 5000);
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'join', name: 'Nobody', color: '#3366ff', mic: false, cam: false, screen: false }));
      });
      socket.on('close', (closeCode) => {
        clearTimeout(timer);
        resolve(closeCode);
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(code).toBe(4403);
  });
});

describe('route audit', () => {
  type RouteLayer = {
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: Record<PropertyKey, unknown> }>;
    };
    handle?: Record<PropertyKey, unknown>;
  };

  it('gates every /api route behind authentication plus a capability gate', async () => {
    current = await startTestServer({ files: { 'README.md': '# hi\n' } });
    const app = current.server.app as unknown as { _router: { stack: RouteLayer[] } };
    const layers = app._router.stack;

    // Without the `/api` authenticator, an ungated route would be fully public.
    const authMounted = layers.some(
      (layer) => !layer.route && layer.handle?.[serverModule.API_AUTHENTICATION] === true,
    );
    expect(authMounted).toBe(true);

    const routes = layers
      .filter((layer): layer is RouteLayer & { route: NonNullable<RouteLayer['route']> } =>
        Boolean(layer.route && layer.route.path.startsWith('/api')),
      )
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods).map((method) => method.toUpperCase()),
        gate: layer.route.stack
          .map((entry) => entry.handle[serverModule.CAPABILITY_GATE])
          .find((value): value is Capability => typeof value === 'string'),
      }));

    // Exact snapshot of the API surface: a new route must be added here on purpose.
    expect(routes.map((route) => `${route.methods.join(',')} ${route.path}`).sort()).toEqual([
      'DELETE /api/files',
      'GET /api/file',
      'GET /api/health',
      'GET /api/search',
      'GET /api/session',
      'GET /api/tree',
      'POST /api/files',
      'POST /api/files/rename',
    ]);

    for (const route of routes) {
      if (route.path === '/api/health') {
        expect(route.gate, '/api/health stays public').toBeUndefined();
        continue;
      }
      if (route.path === '/api/session') {
        // Authenticated but capability-free: every role may describe itself.
        expect(route.gate).toBeUndefined();
        continue;
      }
      expect(route.gate, `${route.path} must use requireCap(...)`).toBeDefined();
    }
  });

  it('rejects an upgrade to an unknown path without reaching a handler', async () => {
    current = await startTestServer({ files: { 'README.md': '# hi\n' } });
    const port = new URL(current.wsUrl).port;

    const outcome = await new Promise<{ opened: boolean; error?: string }>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/nope`, ['codepair', TEST_TOKEN]);
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

    // The 404 is written by the default upgrade branch, before any WebSocketServer
    // is asked to upgrade the socket, so no doc/terminal/signal handler can run.
    expect(outcome.opened).toBe(false);
    expect(outcome.error).toMatch(/Unexpected server response: 404/);
  });
});
