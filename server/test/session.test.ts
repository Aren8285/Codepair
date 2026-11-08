import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TestDocClient } from './helpers/docClient.js';
import { startTestServer, waitFor, type TestServer } from './helpers/testServer.js';

const SWITCH_REASON = 'The host switched to a different project.';

let current: TestServer | undefined;
const fixtures: string[] = [];
const sockets: WebSocket[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const socket of sockets.splice(0)) socket.terminate();
  await current?.cleanup();
  current = undefined;
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(prefix = 'codepair-switch-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

function projectWith(files: Record<string, string>): string {
  const dir = fixture();
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

interface SessionShape {
  id: string;
  root: string;
  createdAt: number;
  files: { read: (relativePath: string) => Promise<{ content: string }> };
  documents: {
    openDocuments: number;
    documentConnections: number;
    pollingCount: number;
    disposed: boolean;
    prepare: (relativePath: string) => Promise<void>;
    dispose: (options?: { closeCode?: number; reason?: string }) => Promise<{ flushErrors: string[] }>;
  };
  terminals: {
    activeSessions: number;
    shellSetupDir?: string;
    disposed: boolean;
    handle: (socket: unknown, principal: unknown) => void;
  };
}

function sessions(): {
  current: () => SessionShape;
  switchRoot: (
    target: string,
    options?: { confirmBroad?: boolean },
  ) => Promise<{ changed: boolean; session: SessionShape; flushErrors: string[] }>;
} {
  return (current!.server as unknown as { sessions: ReturnType<typeof sessions> }).sessions;
}

interface SwitchResult {
  status: number;
  body: { changed?: boolean; session?: { id: string; rootPath: string }; flushErrors?: string[] } & {
    error?: { code: string; message: string };
  };
  raw: string;
}

async function switchRoot(target: string, extra: Record<string, unknown> = {}): Promise<SwitchResult> {
  const response = await current!.requestAdmin('/admin/api/session/root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target, ...extra }),
  });
  const raw = await response.text();
  let body: SwitchResult['body'];
  try {
    body = JSON.parse(raw) as SwitchResult['body'];
  } catch {
    body = {};
  }
  return { status: response.status, body, raw };
}

async function guestJson<T>(route: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${current!.base}${route}`, {
    headers: { Authorization: `Bearer ${current!.token}` },
  });
  const text = await response.text();
  return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : undefined) as T };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface SocketOutcome {
  opened: boolean;
  code?: number;
  reason?: string;
  error?: string;
}

function openRaw(url: string, token: string): { socket: WebSocket; outcome: Promise<SocketOutcome> } {
  const socket = new WebSocket(url, ['codepair', token]);
  sockets.push(socket);
  const outcome = new Promise<SocketOutcome>((resolve) => {
    let opened = false;
    let lastError: string | undefined;
    const timer = setTimeout(() => resolve({ opened, error: lastError ?? 'timeout' }), 8000);
    socket.on('open', () => {
      opened = true;
    });
    socket.on('error', (error) => {
      lastError = error.message;
    });
    socket.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ opened, code, reason: String(reason), error: lastError });
    });
  });
  return { socket, outcome };
}

describe('session switching', () => {
  it('serves the new project on the guest port after a switch', async () => {
    const other = projectWith({ 'new.md': 'new root\n' });
    current = await startTestServer({ files: { 'old.md': 'old root\n' } });

    const before = await guestJson<{ entries: Array<{ name: string }> }>('/api/tree');
    expect(before.body.entries.map((entry) => entry.name)).toEqual(['old.md']);

    const switched = await switchRoot(other);
    expect(switched.status).toBe(200);
    expect(switched.body.changed).toBe(true);
    expect(fs.realpathSync(switched.body.session!.rootPath)).toBe(fs.realpathSync(other));

    const after = await guestJson<{ entries: Array<{ name: string }> }>('/api/tree');
    expect(after.body.entries.map((entry) => entry.name)).toEqual(['new.md']);

    const oldFile = await fetch(`${current.base}/api/file?path=old.md`, {
      headers: { Authorization: `Bearer ${current.token}` },
    });
    expect(oldFile.status).toBe(404);

    const state = await current.requestAdmin('/admin/api/state');
    const stateBody = (await state.json()) as { session: { rootPath: string } };
    expect(fs.realpathSync(stateBody.session.rootPath)).toBe(fs.realpathSync(other));
  });

  it('refuses the filesystem root, the home directory and its parents outright', async () => {
    const fakeHome = fixture('codepair-home-');
    fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.config'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, 'work'), { recursive: true });
    process.env.HOME = fakeHome;

    current = await startTestServer({ files: { 'a.txt': 'x\n' } });

    const root = await switchRoot('/');
    expect(root.status).toBe(400);
    expect(root.body.error!.code).toBe('BROAD_ROOT');

    const home = await switchRoot(fakeHome);
    expect(home.status).toBe(400);
    expect(home.body.error!.code).toBe('BROAD_ROOT');

    const ssh = await switchRoot(path.join(fakeHome, '.ssh'));
    expect(ssh.status).toBe(400);
    expect(ssh.body.error!.code).toBe('BROAD_ROOT');

    const parent = await switchRoot(path.dirname(fakeHome));
    expect(parent.status).toBe(400);
    expect(parent.body.error!.code).toBe('BROAD_ROOT');

    const ordinary = await switchRoot(path.join(fakeHome, 'work'));
    expect(ordinary.status).toBe(200);
    expect(ordinary.body.changed).toBe(true);

    const sshConfirmed = await switchRoot(path.join(fakeHome, '.ssh'), { confirmBroad: true });
    expect(sshConfirmed.status).toBe(400);
    expect(sshConfirmed.body.error!.code).toBe('BROAD_ROOT');

    // The home directory and its parents are refused even when confirmed: with
    // home as the root, ~/.ssh is an ordinary file every guest could read.
    for (const target of [fakeHome, path.dirname(fakeHome)]) {
      const confirmed = await switchRoot(target, { confirmBroad: true });
      expect(confirmed.status, target).toBe(400);
      expect(confirmed.body.error!.code, target).toBe('BROAD_ROOT');
    }
    expect(fs.realpathSync(sessions().current().root)).toBe(fs.realpathSync(path.join(fakeHome, 'work')));
  });

  it('matches system directories exactly after realpath, not by prefix', async () => {
    const { assertSwitchable } = await import('../src/session/hostPaths.js');
    const base = fixture();
    const systemDir = path.join(base, 'system');
    fs.mkdirSync(path.join(systemDir, 'child'), { recursive: true });
    const alias = path.join(base, 'etc-alias');
    fs.symlinkSync(systemDir, alias, 'dir');
    const home = path.join(base, 'home');
    fs.mkdirSync(home);

    const options = { home, systemDirs: [systemDir], credentialDirs: [] };

    // The alias is not on the list, but its realpath is: refuse it.
    await expect(assertSwitchable(alias, options)).rejects.toMatchObject({ code: 'BROAD_ROOT' });
    await expect(assertSwitchable(systemDir, options)).rejects.toMatchObject({ code: 'BROAD_ROOT' });

    // Descendants of a listed system directory are ordinary projects.
    await expect(assertSwitchable(path.join(systemDir, 'child'), options)).resolves.toBe(
      fs.realpathSync(path.join(systemDir, 'child')),
    );

    // `confirmBroad` still opens a system directory: that is the one override left.
    await expect(assertSwitchable(systemDir, { ...options, confirmBroad: true })).resolves.toBe(
      fs.realpathSync(systemDir),
    );
  });

  it('refuses a credential directory and everything beneath it, through symlinks', async () => {
    const { assertSwitchable } = await import('../src/session/hostPaths.js');
    const base = fixture();
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const realConfig = path.join(base, 'dotconfig-real');
    fs.mkdirSync(path.join(realConfig, 'sub'), { recursive: true });
    fs.symlinkSync(realConfig, path.join(home, '.config'), 'dir');

    const options = { home, systemDirs: [], credentialDirs: [path.join(home, '.config')] };

    for (const target of [path.join(home, '.config'), path.join(home, '.config', 'sub'), realConfig, path.join(realConfig, 'sub')]) {
      await expect(assertSwitchable(target, options)).rejects.toMatchObject({ code: 'BROAD_ROOT' });
    }
  });

  it('refuses a credential directory even with confirmBroad', async () => {
    const { assertSwitchable } = await import('../src/session/hostPaths.js');
    const base = fixture();
    const home = path.join(base, 'home');
    const config = path.join(home, '.config');
    fs.mkdirSync(path.join(config, 'sub'), { recursive: true });

    const options = { home, systemDirs: [], credentialDirs: [config], confirmBroad: true };
    for (const target of [config, path.join(config, 'sub')]) {
      await expect(assertSwitchable(target, options)).rejects.toMatchObject({ code: 'BROAD_ROOT' });
    }
  });

  it('still refuses the real /etc with the default system list (macOS /private/etc)', async () => {
    const { assertSwitchable } = await import('../src/session/hostPaths.js');
    await expect(assertSwitchable('/etc', { home: os.homedir(), credentialDirs: [] })).rejects.toMatchObject({
      code: 'BROAD_ROOT',
    });
  });

  it('does nothing when the target is already the root', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const before = sessions().current().id;
    const raw = openRaw(`${current.wsUrl}?path=a.txt`, current.token);
    await waitFor(() => raw.socket.readyState === WebSocket.OPEN, 5000, 'doc socket');

    const result = await switchRoot(current.root);
    expect(result.status).toBe(200);
    expect(result.body.changed).toBe(false);
    expect(result.body.session!.id).toBe(before);
    expect(sessions().current().id).toBe(before);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(raw.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('leaves everything running when the new path is invalid', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const before = sessions().current().id;
    const raw = openRaw(`${current.wsUrl}?path=a.txt`, current.token);
    await waitFor(() => raw.socket.readyState === WebSocket.OPEN, 5000, 'doc socket');

    const result = await switchRoot(path.join(fixture(), 'missing'));
    expect(result.status).toBe(404);
    expect(sessions().current().id).toBe(before);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(raw.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('closes document and terminal sockets with 4410 and keeps signalling open', async () => {
    const other = projectWith({ 'x.md': 'x\n' });
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, env: { CODE_PAIR_TERMINAL: 'on' } });

    const doc = openRaw(`${current.wsUrl}?path=a.txt`, current.token);
    await waitFor(() => doc.socket.readyState === WebSocket.OPEN, 5000, 'doc socket');

    const terminal = openRaw(current.wsUrl.replace('/ws/doc', '/ws/terminal'), current.token);
    await waitFor(() => terminal.socket.readyState === WebSocket.OPEN, 5000, 'terminal socket');

    const signal = openRaw(
      `${current.wsUrl.replace('/ws/doc', '/ws/signal')}?room=${encodeURIComponent(current.config.roomId)}`,
      current.token,
    );
    await waitFor(() => signal.socket.readyState === WebSocket.OPEN, 5000, 'signal socket');

    expect((await switchRoot(other)).body.changed).toBe(true);

    expect(await doc.outcome).toMatchObject({ code: 4410, reason: SWITCH_REASON });
    expect(await terminal.outcome).toMatchObject({ code: 4410, reason: SWITCH_REASON });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(signal.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('closes a document upgrade that was still preparing when the switch landed', async () => {
    const other = projectWith({ 'x.md': 'x\n' });
    current = await startTestServer({ files: { 'slow.txt': 'content\n' } });
    const old = sessions().current();

    const entered = deferred();
    const release = deferred();
    const prepare = old.documents.prepare.bind(old.documents);
    old.documents.prepare = async (relativePath: string) => {
      entered.resolve();
      await release.promise;
      return prepare(relativePath);
    };

    const raw = openRaw(`${current.wsUrl}?path=slow.txt`, current.token);
    await entered.promise;
    expect((await switchRoot(other)).body.changed).toBe(true);
    release.resolve();

    expect(await raw.outcome).toMatchObject({ code: 4410, reason: SWITCH_REASON });
    expect(old.documents.openDocuments).toBe(0);
    expect(old.documents.documentConnections).toBe(0);
  });

  it('closes a terminal that arrives mid-switch without spawning a shell', async () => {
    const other = projectWith({ 'x.md': 'x\n' });
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, env: { CODE_PAIR_TERMINAL: 'on' } });
    const old = sessions().current();

    const ptyModule = await import('node-pty');
    const spawn = vi.spyOn(ptyModule, 'spawn');
    const entered = deferred();
    const release = deferred();
    const handle = old.terminals.handle.bind(old.terminals);
    old.terminals.handle = (socket: unknown, principal: unknown) => {
      entered.resolve();
      return release.promise.then(() => handle(socket, principal));
    };

    const raw = openRaw(current.wsUrl.replace('/ws/doc', '/ws/terminal'), current.token);
    await entered.promise;
    expect((await switchRoot(other)).body.changed).toBe(true);
    release.resolve();

    expect(await raw.outcome).toMatchObject({ code: 4410, reason: SWITCH_REASON });
    expect(old.terminals.activeSessions).toBe(0);
    expect(spawn, 'no PTY may be spawned for a terminal that arrived mid-switch').not.toHaveBeenCalled();

    // Positive control: the spy really intercepts. A terminal on the new session does spawn.
    const live = openRaw(current.wsUrl.replace('/ws/doc', '/ws/terminal'), current.token);
    await waitFor(() => live.socket.readyState === WebSocket.OPEN, 5000, 'terminal socket');
    expect(spawn, 'the spawn spy must see a real terminal').toHaveBeenCalled();
    spawn.mockRestore();
    live.socket.close();
  });

  it('refuses a connection that reaches a session mid-disposal with 4410', async () => {
    const other = projectWith({ 'x.md': 'x\n' });
    current = await startTestServer({
      files: { 'note.md': 'original\n' },
      env: { CODE_PAIR_SAVE_DEBOUNCE_MS: '2000' },
    });
    const oldRoot = current.root;
    const old = sessions().current();
    const client = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'note.md' });
    const witness = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'note.md' });
    client.text.insert(client.text.length, 'dirty\n');
    await waitFor(() => witness.text.toString().includes('dirty'), 5000, 'edit applied in memory');

    // This upgrade resolves the OLD session, then stalls while it reads the file.
    const prepareEntered = deferred();
    const releasePrepare = deferred();
    const prepare = old.documents.prepare.bind(old.documents);
    old.documents.prepare = async (relativePath: string) => {
      prepareEntered.resolve();
      await releasePrepare.promise;
      return prepare(relativePath);
    };
    const raw = openRaw(`${current.wsUrl}?path=note.md`, current.token);
    await prepareEntered.promise;

    // Disposal then starts and is held on the real flush of the dirty document.
    const hub = old.documents as unknown as { sessions: Map<string, { flush: () => Promise<void> }> };
    const openDocs = [...hub.sessions.values()];
    expect(openDocs).toHaveLength(1);
    const docSession = openDocs[0]!;
    const flush = docSession.flush.bind(docSession);
    const flushEntered = deferred();
    const releaseFlush = deferred();
    docSession.flush = async () => {
      flushEntered.resolve();
      await releaseFlush.promise;
      return flush();
    };

    const switching = switchRoot(other);
    await flushEntered.promise;
    // The disposed flag flipped synchronously, before that flush was awaited.
    expect(old.documents.disposed).toBe(true);

    // The held upgrade now finishes against a hub that is going away.
    releasePrepare.resolve();
    expect(await raw.outcome).toMatchObject({ code: 4410, reason: SWITCH_REASON });
    expect(old.documents.openDocuments).toBe(0);

    releaseFlush.resolve();
    expect((await switching).status).toBe(200);
    expect(fs.readFileSync(path.join(oldRoot, 'note.md'), 'utf8')).toBe('original\ndirty\n');
    client.destroy();
    witness.destroy();
  });

  it('keeps edits made just before a switch in the old project only', async () => {
    const other = projectWith({ 'fresh.md': 'fresh\n' });
    // 2000 ms debounce: the switch is the only thing that can have saved the
    // edit by the time these assertions run.
    current = await startTestServer({
      files: { 'note.md': 'original\n' },
      env: { CODE_PAIR_SAVE_DEBOUNCE_MS: '2000' },
    });
    const oldRoot = current.root;

    const client = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'note.md' });
    const witness = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'note.md' });

    client.text.insert(client.text.length, 'typed before the switch\n');
    await waitFor(() => witness.text.toString().includes('typed before the switch'), 5000, 'edit applied in memory');
    // The edit is in the shared document, not yet on disk: only disposal can save it.
    expect(fs.readFileSync(path.join(oldRoot, 'note.md'), 'utf8')).toBe('original\n');

    const switched = await switchRoot(other);
    expect(switched.status).toBe(200);
    expect(switched.body.changed).toBe(true);
    expect(switched.body.flushErrors).toEqual([]);

    expect(fs.readFileSync(path.join(oldRoot, 'note.md'), 'utf8')).toBe('original\ntyped before the switch\n');
    expect(fs.existsSync(path.join(other, 'note.md'))).toBe(false);
    const otherListing = fs.readdirSync(other).sort();

    // Nothing from the old session appears afterwards, in either root: 2x debounce.
    await new Promise((resolve) => setTimeout(resolve, 4400));
    expect(fs.readFileSync(path.join(oldRoot, 'note.md'), 'utf8')).toBe('original\ntyped before the switch\n');
    expect(fs.readdirSync(other).sort()).toEqual(otherListing);
    expect(fs.existsSync(path.join(other, 'note.md'))).toBe(false);

    client.destroy();
    witness.destroy();
  });

  it('lands a reconnecting client in the new project', async () => {
    const other = projectWith({ 'next.md': 'from the new root\n' });
    current = await startTestServer({ files: { 'note.md': 'old root\n' } });
    expect((await switchRoot(other)).body.changed).toBe(true);

    const client = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'next.md' });
    try {
      expect(client.text.toString()).toBe('from the new root\n');
    } finally {
      client.destroy();
    }
  });

  it('stops the old session pollers and marks it disposed', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const old = sessions().current();
    const client = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'a.txt' });

    expect(old.documents.pollingCount).toBe(1);
    expect(old.documents.disposed).toBe(false);

    expect((await switchRoot(projectWith({ 'b.txt': 'y\n' }))).body.changed).toBe(true);

    expect(old.documents.disposed).toBe(true);
    expect(old.documents.pollingCount).toBe(0);
    client.destroy();
  });

  it('kills the old PTYs and removes their shell setup directory', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, env: { CODE_PAIR_TERMINAL: 'on' } });
    const old = sessions().current();

    const terminal = openRaw(current.wsUrl.replace('/ws/doc', '/ws/terminal'), current.token);
    await waitFor(() => terminal.socket.readyState === WebSocket.OPEN, 5000, 'terminal socket');
    const rcDir = await waitFor(() => old.terminals.shellSetupDir, 5000, 'shell setup directory');

    expect(fs.existsSync(rcDir)).toBe(true);
    expect(old.terminals.activeSessions).toBe(1);

    expect((await switchRoot(projectWith({ 'b.txt': 'y\n' }))).body.changed).toBe(true);

    expect(await terminal.outcome).toMatchObject({ code: 4410, reason: SWITCH_REASON });
    expect(old.terminals.activeSessions).toBe(0);
    expect(fs.existsSync(rcDir)).toBe(false);
  });

  it('serializes concurrent switches and disposes every superseded session', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, env: { CODE_PAIR_TERMINAL: 'on' } });
    const manager = sessions();

    const first = manager.current();
    const client = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'a.txt' });
    expect(first.documents.pollingCount).toBe(1);
    expect(first.terminals.shellSetupDir).toBeDefined();
    expect(fs.existsSync(first.terminals.shellSetupDir!)).toBe(true);

    const targets = Array.from({ length: 5 }, (_, index) => projectWith({ [`f${index}.md`]: `${index}\n` }));
    const results = await Promise.all(targets.map((target) => manager.switchRoot(target)));

    // Serialized in call order: all five are applied, the fifth root is active.
    expect(results.map((result) => result.changed)).toEqual([true, true, true, true, true]);
    expect(results.map((result) => result.session.root)).toEqual(targets.map((target) => fs.realpathSync(target)));

    const active = manager.current();
    expect(active.root).toBe(fs.realpathSync(targets[4]!));
    expect(active).toBe(results[4]!.session);
    expect(active.documents.disposed).toBe(false);

    // Every superseded session is torn down, not merely abandoned: its poller is
    // stopped, no PTY survives, and its generated rc directory is removed.
    const superseded = [first, ...results.slice(0, 4).map((result) => result.session)];
    for (const session of superseded) {
      expect(session.documents.disposed).toBe(true);
      expect(session.documents.pollingCount).toBe(0);
      expect(session.terminals.activeSessions).toBe(0);
      expect(session.terminals.shellSetupDir).toBeDefined();
      expect(fs.existsSync(session.terminals.shellSetupDir!)).toBe(false);
    }

    const state = await current.requestAdmin('/admin/api/state');
    const stateBody = (await state.json()) as {
      session: { rootPath: string };
      openDocuments: number;
      terminals: number;
    };
    expect(fs.realpathSync(stateBody.session.rootPath)).toBe(fs.realpathSync(targets[4]!));
    expect(stateBody.openDocuments).toBe(0);
    expect(stateBody.terminals).toBe(0);

    const tree = await guestJson<{ entries: Array<{ name: string }> }>('/api/tree');
    expect(tree.body.entries.map((entry) => entry.name)).toEqual(['f4.md']);
    client.destroy();
  });

  it('finishes an in-flight request against the session it started with', async () => {
    const other = projectWith({ 'a.txt': 'new content\n' });
    current = await startTestServer({ files: { 'a.txt': 'old content\n' } });
    const old = sessions().current();

    const entered = deferred();
    const release = deferred();
    const read = old.files.read.bind(old.files);
    old.files.read = async (relativePath: string) => {
      entered.resolve();
      await release.promise;
      return read(relativePath);
    };

    const pending = fetch(`${current.base}/api/file?path=a.txt`, {
      headers: { Authorization: `Bearer ${current.token}` },
    });
    await entered.promise;
    expect((await switchRoot(other)).body.changed).toBe(true);
    release.resolve();

    const response = await pending;
    expect(response.status).toBe(200);
    expect(((await response.json()) as { content: string }).content).toBe('old content\n');
  });

  it('gives each of two simultaneous requests one consistent session', async () => {
    const other = projectWith({ 'b.txt': 'new\n' });
    current = await startTestServer({ files: { 'b.txt': 'old\n' } });
    const old = sessions().current();

    const entered = deferred();
    const release = deferred();
    const read = old.files.read.bind(old.files);
    old.files.read = async (relativePath: string) => {
      entered.resolve();
      await release.promise;
      return read(relativePath);
    };

    const first = fetch(`${current.base}/api/file?path=b.txt`, {
      headers: { Authorization: `Bearer ${current.token}` },
    });
    await entered.promise;
    expect((await switchRoot(other)).body.changed).toBe(true);
    const second = await fetch(`${current.base}/api/file?path=b.txt`, {
      headers: { Authorization: `Bearer ${current.token}` },
    });
    release.resolve();

    const [before, after] = await Promise.all([first, second]);
    expect(((await before.json()) as { content: string }).content).toBe('old\n');
    expect(((await after.json()) as { content: string }).content).toBe('new\n');
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'reports flush failures without failing the switch',
    async () => {
      const other = projectWith({ 'ok.md': 'ok\n' });
      current = await startTestServer({
        files: { 'note.md': 'original\n' },
        env: { CODE_PAIR_SAVE_DEBOUNCE_MS: '1000' },
      });
      const oldRoot = current.root;
      const client = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'note.md' });
      const witness = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'note.md' });
      client.text.insert(0, 'dirty ');
      // The server (not just this client) must hold the edit before the switch,
      // otherwise there is nothing for disposal to fail to write.
      await waitFor(() => witness.text.toString().startsWith('dirty '), 5000, 'edit applied in memory');

      fs.chmodSync(oldRoot, 0o500);
      try {
        const result = await switchRoot(other);
        expect(result.status).toBe(200);
        expect(result.body.changed).toBe(true);
        expect(result.body.flushErrors).toContain('note.md');
      } finally {
        fs.chmodSync(oldRoot, 0o700);
        client.destroy();
        witness.destroy();
      }
    },
  );

  it('never overwrites a file that changed on disk while this session had edits', async () => {
    const other = projectWith({ 'x.md': 'x\n' });
    current = await startTestServer({
      files: { 'note.md': 'original\n' },
      env: { CODE_PAIR_SAVE_DEBOUNCE_MS: '5000' },
    });
    const oldRoot = current.root;
    const client = await TestDocClient.connect({ wsUrl: current.wsUrl, token: current.token, path: 'note.md' });

    client.text.insert(client.text.length, 'local edit\n');
    await waitFor(() => client.text.toString().includes('local edit'), 5000, 'in-memory edit');

    fs.writeFileSync(path.join(oldRoot, 'note.md'), 'host rewrite\n');
    await waitFor(
      () => client.metas.some((meta) => meta.type === 'external' && meta.conflict === true),
      10_000,
      'external-change conflict',
    );

    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      const result = await switchRoot(other);
      expect(result.status).toBe(200);
      expect(result.body.changed).toBe(true);
      expect(fs.readFileSync(path.join(oldRoot, 'note.md'), 'utf8')).toBe('host rewrite\n');
    } finally {
      warn.mockRestore();
      client.destroy();
    }

    expect(warnings.join('\n')).toContain('note.md');
  });
});
