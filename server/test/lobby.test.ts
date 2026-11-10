import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ConfigError, parseConfig } from '../src/config.js';
import { startTestServer, type TestRole, type TestServer } from './helpers/testServer.js';

let current: TestServer | undefined;
const sockets: WebSocket[] = [];
const fixtures: string[] = [];

const OWNER = 'owner-token-0123456789ab';
const EDITOR = 'editor-token-0123456789ab';
const VIEWER = 'viewer-token-0123456789ab';

const TOKENS = { owner: OWNER, editor: EDITOR, viewer: VIEWER };

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await current?.cleanup();
  current = undefined;
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson<T = unknown>(
  response: Response,
): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const text = await response.text();
  return {
    status: response.status,
    body: (text.length > 0 ? JSON.parse(text) : undefined) as T,
    text,
    headers: response.headers,
  };
}

interface LobbyEntry {
  id: string;
  connectionId: string;
  displayName: string;
  requestedAt: number;
  state: string;
  tokenRole: string;
  grantedRole?: string;
}

interface LobbySnapshotBody {
  enabled: boolean;
  locked: boolean;
  pending: LobbyEntry[];
  admitted: Array<{ connectionId: string; displayName: string; role: string; connectedSince: number }>;
}

interface LobbyStatusBody {
  enabled: boolean;
  locked: boolean;
  state: string;
  displayName?: string;
  seat?: string;
  expiresAt?: number;
}

interface ErrorBody {
  error?: { code: string; message: string };
}

/** A per-tab id; the shape is the contract (`[A-Za-z0-9_-]{16,64}`). */
function cid(seed: string): string {
  return `cid-${seed}`.padEnd(24, '0');
}

function headers(connectionId?: string): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' };
  if (connectionId) result['X-CodePair-Connection'] = connectionId;
  return result;
}

function join(role: TestRole, connectionId: string, displayName = 'Guest') {
  return current!.requestAs(role, '/api/lobby/join', {
    method: 'POST',
    headers: headers(connectionId),
    body: JSON.stringify({ displayName }),
  }).then((response) => readJson<LobbyStatusBody & ErrorBody>(response));
}

function lobbyStatus(role: TestRole, connectionId?: string) {
  return current!.requestAs(role, '/api/lobby/status', { headers: headers(connectionId) }).then((response) =>
    readJson<LobbyStatusBody>(response),
  );
}

function getLobby() {
  return current!.requestAdmin('/admin/api/lobby').then((response) => readJson<LobbySnapshotBody>(response));
}

function adminPost(route: string, body?: unknown) {
  return current!.requestAdmin(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function admit(id: string, role: 'editor' | 'viewer') {
  return adminPost(`/admin/api/lobby/${id}/admit`, { role }).then((response) =>
    readJson<{ entry?: LobbyEntry } & ErrorBody>(response),
  );
}

function deny(id: string) {
  return adminPost(`/admin/api/lobby/${id}/deny`).then((response) => readJson<{ entry?: LobbyEntry } & ErrorBody>(response));
}

function setLocked(locked: boolean) {
  return adminPost('/admin/api/lobby/lock', { locked }).then((response) =>
    readJson<LobbySnapshotBody & ErrorBody>(response),
  );
}

function kick(connectionId: string) {
  return adminPost(`/admin/api/connections/${encodeURIComponent(connectionId)}/kick`).then((response) =>
    readJson<ErrorBody>(response),
  );
}

/**
 * Wait up to `settleMs` for the socket's own outcome: a lobby refusal completes
 * the upgrade and closes with a code, so "opened" alone is not the answer.
 */
function socketOutcome(route: string, token: string, settleMs = 400): Promise<{ opened: boolean; code?: number; reason?: string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${current!.wsBase}${route}`, ['codepair', token]);
    sockets.push(socket);
    let opened = false;
    let settled = false;
    const finish = (value: { opened: boolean; code?: number; reason?: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    socket.once('open', () => {
      opened = true;
    });
    socket.once('close', (code, reason) => finish({ opened, code, reason: reason.toString() }));
    socket.once('error', () => {
      // Rejections are reported through close/unexpected-response.
    });
    setTimeout(() => finish({ opened }), settleMs);
  });
}

function openSocket(route: string, token: string): Promise<{
  socket: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${current!.wsBase}${route}`, ['codepair', token]);
    sockets.push(socket);
    const closed = new Promise<{ code: number; reason: string }>((settle) =>
      socket.once('close', (code, reason) => settle({ code, reason: reason.toString() })),
    );
    socket.once('open', () => resolve({ socket, closed }));
    socket.once('error', reject);
  });
}

async function roomId(): Promise<string> {
  const session = await readJson<{ roomId: string }>(await current!.requestAs('editor', '/api/session'));
  return session.body.roomId;
}

async function waitForLobbyState(role: TestRole, connectionId: string, state: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if ((await lobbyStatus(role, connectionId)).body.state === state) return;
    if (Date.now() - started > 5000) throw new Error(`Timed out waiting for lobby state ${state}.`);
    await sleep(50);
  }
}

describe('join lobby', () => {
  it('lets the owner in without the lobby, even when the room is locked', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const ownerCid = cid('owner');

    expect((await setLocked(true)).status).toBe(200);
    const socket = await socketOutcome(`/ws/doc?path=a.txt&cid=${ownerCid}`, OWNER);
    expect(socket.opened, 'the owner never waits on the host').toBe(true);

    const snapshot = await getLobby();
    expect(snapshot.body.locked).toBe(true);
    expect(snapshot.body.pending, 'the owner is never a pending request').toEqual([]);
    expect(snapshot.body.admitted.map((entry) => entry.connectionId)).toContain(ownerCid);
    expect(snapshot.body.admitted[0]?.role).toBe('owner');
  });

  it('holds an editor until admission, then opens doc, terminal and signal', async () => {
    current = await startTestServer({
      lobby: true,
      files: { 'a.txt': 'x\n' },
      tokens: TOKENS,
      env: { CODE_PAIR_TERMINAL: 'on' },
    });
    const editorCid = cid('editor');

    const joined = await join('editor', editorCid, 'Ada');
    expect(joined.status).toBe(200);
    expect(joined.body.state, 'a fresh request waits, it is not admitted').toBe('waiting');
    expect(joined.body.seat).toBeUndefined();

    const pending = (await getLobby()).body.pending;
    expect(pending.length, 'the request is queued before any host action').toBe(1);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.displayName).toBe('Ada');
    expect(pending[0]?.tokenRole).toBe('editor');

    const pendingDoc = await socketOutcome(`/ws/doc?path=a.txt&cid=${editorCid}`, EDITOR);
    expect(pendingDoc.opened, 'the upgrade completes so the tab sees the code').toBe(true);
    expect(pendingDoc.code, 'refused with the lobby code').toBe(4425);

    const admitted = await admit(pending[0]!.id, 'editor');
    expect(admitted.status).toBe(200);
    expect(admitted.body.entry?.state).toBe('admitted');
    expect(admitted.body.entry?.grantedRole).toBe('editor');
    expect((await lobbyStatus('editor', editorCid)).body.state).toBe('admitted');

    expect((await socketOutcome(`/ws/doc?path=a.txt&cid=${editorCid}`, EDITOR)).opened).toBe(true);
    expect((await socketOutcome(`/ws/terminal?cid=${editorCid}`, EDITOR)).opened).toBe(true);
    expect((await socketOutcome(`/ws/signal?room=${await roomId()}&cid=${editorCid}`, EDITOR)).opened).toBe(true);
  });

  it('refuses to admit a viewer token as editor and keeps it pending', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const viewerCid = cid('viewer');
    await join('viewer', viewerCid, 'Vic');
    const pending = (await getLobby()).body.pending;
    expect(pending.length, 'the request is queued before any host action').toBe(1);

    const escalated = await admit(pending[0]!.id, 'editor');
    expect(escalated.status, 'the seat may never exceed the token role').toBe(403);
    expect(escalated.body.error?.code).toBe('ROLE_CEILING');
    expect((await lobbyStatus('viewer', viewerCid)).body.state).toBe('waiting');
    expect((await socketOutcome(`/ws/doc?path=a.txt&cid=${viewerCid}`, VIEWER)).code).toBe(4425);
  });

  it('denies an entry and refuses that connection with the declined reason', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const editorCid = cid('denied');
    await join('editor', editorCid, 'Eve');
    const pending = (await getLobby()).body.pending;
    expect(pending.length, 'the request is queued before any host action').toBe(1);

    const denied = await deny(pending[0]!.id);
    expect(denied.status).toBe(200);
    expect(denied.body.entry?.state).toBe('denied');
    expect((await lobbyStatus('editor', editorCid)).body.state).toBe('denied');
    expect((await getLobby()).body.pending).toEqual([]);
    expect((await getLobby()).body.admitted).toEqual([]);

    const socket = await socketOutcome(`/ws/doc?path=a.txt&cid=${editorCid}`, EDITOR);
    expect(socket.opened, 'the upgrade completes so the tab sees the code').toBe(true);
    expect(socket.code).toBe(4425);
    expect(socket.reason).toContain('declined');
  });

  it('keeps a viewer seat read-only on HTTP and in /api/session', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const viewerCid = cid('seat');
    await join('viewer', viewerCid, 'Vic');
    const pending = (await getLobby()).body.pending;
    expect(pending.length, 'the request is queued before any host action').toBe(1);
    expect((await admit(pending[0]!.id, 'viewer')).status).toBe(200);

    const tree = await current.requestAs('viewer', '/api/tree', { headers: headers(viewerCid) });
    expect(tree.status).toBe(200);

    const create = await readJson<ErrorBody>(
      await current.requestAs('viewer', '/api/files', {
        method: 'POST',
        headers: headers(viewerCid),
        body: JSON.stringify({ path: 'b.txt', type: 'file' }),
      }),
    );
    expect(create.status, 'a lobby seat never grants a write').toBe(403);
    expect(create.body.error?.code).toBe('FORBIDDEN');

    const session = await readJson<{ capabilities: string[] }>(
      await current.requestAs('viewer', '/api/session', { headers: headers(viewerCid) }),
    );
    expect(session.body.capabilities).not.toContain('fs.write');
  });

  it('applies a downward seat: an editor admitted as viewer loses writes', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const editorCid = cid('down');
    await join('editor', editorCid, 'Ada');
    const pending = (await getLobby()).body.pending;
    expect(pending.length, 'the request is queued before any host action').toBe(1);
    expect((await admit(pending[0]!.id, 'viewer')).status).toBe(200);
    expect((await lobbyStatus('editor', editorCid)).body.seat).toBe('viewer');

    const create = await current.requestAs('editor', '/api/files', {
      method: 'POST',
      headers: headers(editorCid),
      body: JSON.stringify({ path: 'b.txt', type: 'file' }),
    });
    expect(create.status, 'the Host can narrow an editor token').toBe(403);

    const session = await readJson<{ capabilities: string[] }>(
      await current.requestAs('editor', '/api/session', { headers: headers(editorCid) }),
    );
    expect(session.body.capabilities).not.toContain('fs.write');
  });

  it('refuses new joins while locked, leaves admitted connections alone, and still admits the owner', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const insideCid = cid('inside');
    await join('editor', insideCid, 'Ina');
    const pending = (await getLobby()).body.pending;
    expect(pending.length, 'the request is queued before any host action').toBe(1);
    await admit(pending[0]!.id, 'editor');
    const live = await openSocket(`/ws/doc?path=a.txt&cid=${insideCid}`, EDITOR);

    expect((await setLocked(true)).status).toBe(200);
    expect((await getLobby()).body.locked).toBe(true);

    const refused = await join('editor', cid('outside'), 'Out');
    expect(refused.status, 'a locked room refuses instead of queueing').toBe(403);
    expect(refused.body.error?.code).toBe('LOBBY_LOCKED');
    expect(refused.body.error?.message).toBe('The room is locked.');
    expect((await getLobby()).body.pending).toEqual([]);

    await sleep(100);
    expect(live.socket.readyState, 'lock does not kick people already in').toBe(WebSocket.OPEN);
    expect((await socketOutcome(`/ws/doc?path=a.txt&cid=${cid('owner')}`, OWNER)).opened).toBe(true);
  });

  it('kicks every socket of one connection, refuses a retry, and treats a new connection id as new', async () => {
    current = await startTestServer({
      lobby: true,
      files: { 'a.txt': 'x\n' },
      tokens: TOKENS,
      env: { CODE_PAIR_TERMINAL: 'on' },
    });
    const editorCid = cid('kicked');
    await join('editor', editorCid, 'Kit');
    const pending = (await getLobby()).body.pending;
    expect(pending.length, 'the request is queued before any host action').toBe(1);
    await admit(pending[0]!.id, 'editor');

    const doc = await openSocket(`/ws/doc?path=a.txt&cid=${editorCid}`, EDITOR);
    const terminal = await openSocket(`/ws/terminal?cid=${editorCid}`, EDITOR);
    const signal = await openSocket(`/ws/signal?room=${await roomId()}&cid=${editorCid}`, EDITOR);

    expect((await kick(editorCid)).status).toBe(204);
    const [docClose, terminalClose, signalClose] = await Promise.all([doc.closed, terminal.closed, signal.closed]);
    for (const [label, outcome] of [
      ['doc', docClose],
      ['terminal', terminalClose],
      ['signal', signalClose],
    ] as const) {
      expect(outcome.code, `${label} is closed with 4429`).toBe(4429);
      expect(outcome.reason).toBe('The host removed you from this session.');
    }
    expect((await getLobby()).body.admitted.map((entry) => entry.connectionId)).not.toContain(editorCid);

    const retry = await socketOutcome(`/ws/doc?path=a.txt&cid=${editorCid}`, EDITOR);
    expect(retry.opened, 'a kicked connection id is not re-queued').toBe(true);
    expect(retry.code).toBe(4425);
    expect(retry.reason).toContain('removed');

    const freshCid = cid('fresh');
    const fresh = await join('editor', freshCid, 'New');
    expect(fresh.body.state, 'a reload (new id) goes through the lobby').toBe('waiting');
    const freshPending = (await getLobby()).body.pending;
    expect((await admit(freshPending[0]!.id, 'editor')).status).toBe(200);
    expect((await socketOutcome(`/ws/doc?path=a.txt&cid=${freshCid}`, EDITOR)).opened).toBe(true);
  });

  it('expires an unanswered request and rejects a late admit cleanly', async () => {
    current = await startTestServer({
      lobby: true,
      files: { 'a.txt': 'x\n' },
      tokens: TOKENS,
      args: ['--lobby-timeout', '1'],
    });
    const viewerCid = cid('slow');
    await join('viewer', viewerCid, 'Late');
    const pending = (await getLobby()).body.pending;
    expect(pending.length, 'the request is queued before any host action').toBe(1);

    await waitForLobbyState('viewer', viewerCid, 'expired');
    expect((await getLobby()).body.pending, 'an expired request leaves the queue').toEqual([]);

    const late = await admit(pending[0]!.id, 'viewer');
    expect(late.status, 'a late admit fails cleanly').toBe(409);
    expect(late.body.error?.code).toBe('LOBBY_CLOSED');
    expect((await socketOutcome(`/ws/doc?path=a.txt&cid=${viewerCid}`, VIEWER)).code).toBe(4425);
  });

  it('refuses the 51st pending request instead of dropping it silently', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    for (let index = 0; index < 50; index += 1) {
      const response = await join('editor', cid(`p${String(index).padStart(2, '0')}`), `P${index}`);
      expect(response.status, `request ${index}`).toBe(200);
      expect(response.body.state).toBe('waiting');
    }
    const overflow = await join('editor', cid('overflow'), 'Extra');
    expect(overflow.status).toBe(429);
    expect(overflow.body.error?.code).toBe('LOBBY_FULL');
    expect(overflow.body.error?.message).toBe('The lobby is full.');
    expect((await getLobby()).body.pending).toHaveLength(50);
  });

  it('resets the lobby on a root switch', async () => {
    current = await startTestServer({
      lobby: true,
      files: { 'a.txt': 'x\n' },
      tokens: TOKENS,
      env: { CODE_PAIR_TERMINAL: 'on' },
    });
    const editorCid = cid('switch');
    await join('editor', editorCid, 'Ada');
    const queued = (await getLobby()).body.pending;
    expect(queued.length, 'the request is queued before the switch').toBe(1);
    await admit(queued[0]!.id, 'editor');
    expect((await setLocked(true)).status).toBe(200);
    expect((await socketOutcome(`/ws/doc?path=a.txt&cid=${editorCid}`, EDITOR)).opened).toBe(true);

    const nextRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-lobby-root-'));
    fixtures.push(nextRoot);
    fs.writeFileSync(path.join(nextRoot, 'a.txt'), 'y\n');
    const switched = await current.requestAdmin('/admin/api/session/root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: nextRoot }),
    });
    expect(switched.status).toBe(200);

    const snapshot = await getLobby();
    expect(snapshot.body.pending, 'pending requests belong to the old root').toEqual([]);
    expect(snapshot.body.admitted, 'admissions belong to the old root').toEqual([]);
    expect(snapshot.body.locked, 'the new session starts unlocked').toBe(false);

    expect(
      (await socketOutcome(`/ws/doc?path=a.txt&cid=${editorCid}`, EDITOR)).code,
      'the same tab must ask again after a switch',
    ).toBe(4425);
    expect((await join('editor', cid('after'), 'Again')).body.state).toBe('waiting');
  });

  it('keeps file names behind the waiting room, but leaves /api/session reachable', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const editorCid = cid('http');

    const session = await current.requestAs('editor', '/api/session', { headers: headers(editorCid) });
    expect(session.status, '/api/session drives the waiting screen').toBe(200);

    const waiting = await readJson<ErrorBody>(
      await current.requestAs('editor', '/api/tree', { headers: headers(editorCid) }),
    );
    expect(waiting.status).toBe(403);
    expect(waiting.body.error?.code).toBe('LOBBY_WAITING');

    await join('editor', editorCid, 'Ada');
    await admit((await getLobby()).body.pending[0]!.id, 'editor');
    expect((await current.requestAs('editor', '/api/tree', { headers: headers(editorCid) })).status).toBe(200);
  });

  it('fails closed when a non-owner socket carries no connection id', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const outcome = await socketOutcome('/ws/doc?path=a.txt', EDITOR);
    expect(outcome.opened, 'the upgrade completes so the tab sees the code').toBe(true);
    expect(outcome.code).toBe(4425);
    expect(outcome.reason).toContain('connection id');
  });

  it('never lets a guest borrow an owner connection id', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const ownerCid = cid('ownerid');
    expect((await socketOutcome(`/ws/doc?path=a.txt&cid=${ownerCid}`, OWNER)).opened).toBe(true);

    const http = await readJson<ErrorBody>(
      await current.requestAs('editor', '/api/tree', { headers: headers(ownerCid) }),
    );
    expect(http.status, 'an owner connection id is not a guest seat').toBe(403);
    expect(http.body.error?.code).toBe('LOBBY_WAITING');

    const socket = await socketOutcome(`/ws/doc?path=a.txt&cid=${ownerCid}`, EDITOR);
    expect(socket.code, 'the upgrade closes with the lobby code').toBe(4425);
  });

  it('serves the host console events over SSE with a query token, and only there', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });

    const missing = await fetch(`${current.adminBase}/admin/api/events`);
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${current.adminBase}/admin/api/events?token=nope`);
    expect(wrong.status, 'a bad token is refused').toBe(401);

    const controller = new AbortController();
    const stream = await fetch(`${current.adminBase}/admin/api/events?token=${encodeURIComponent(current.adminToken)}`, {
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    const first = await Promise.race([reader!.read(), sleep(3000).then(() => undefined)]);
    expect(first, 'the stream greets with a snapshot').toBeDefined();
    expect(new TextDecoder().decode(first!.value)).toContain('event: snapshot');
    controller.abort();

    // The same query parameter on another admin route is still refused.
    const elsewhere = await current.requestAdmin('/admin/api/state?token=' + encodeURIComponent(current.adminToken), {
      headers: { Authorization: '' },
    });
    expect(elsewhere.status, 'the query token is scoped to SSE only').toBe(401);
  });

  it('admits immediately with --no-lobby and rejects lobby actions', async () => {
    current = await startTestServer({ lobby: false, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const editorCid = cid('nolobby');

    const joined = await join('editor', editorCid, 'Ada');
    expect(joined.status).toBe(200);
    expect(joined.body.enabled).toBe(false);
    expect(joined.body.state).toBe('admitted');
    expect(joined.body.seat).toBe('editor');

    const snapshot = await getLobby();
    expect(snapshot.body.enabled).toBe(false);
    expect(snapshot.body.admitted.map((entry) => entry.connectionId)).toContain(editorCid);
    expect((await socketOutcome(`/ws/doc?path=a.txt&cid=${editorCid}`, EDITOR)).opened).toBe(true);

    const rejected = await admit('any-id', 'editor');
    expect(rejected.status, 'lobby actions are refused, not silently ignored').toBe(409);
    expect(rejected.body.error?.code).toBe('LOBBY_DISABLED');
  });

  it('parses --no-lobby and --lobby-timeout and refuses bad timeouts', () => {
    const base = ['--root', '/tmp', '--token', OWNER];
    const defaults = parseConfig(base, {}, '/tmp');
    expect(defaults.lobbyEnabled, 'the lobby is on by default').toBe(true);
    expect(defaults.lobbyTimeoutMs).toBe(120_000);

    const disabled = parseConfig([...base, '--no-lobby'], {}, '/tmp');
    expect(disabled.lobbyEnabled).toBe(false);

    const custom = parseConfig([...base, '--lobby-timeout', '5'], {}, '/tmp');
    expect(custom.lobbyTimeoutMs).toBe(5000);

    for (const invalid of ['0', '3601', 'abc', '-1']) {
      expect(() => parseConfig([...base, '--lobby-timeout', invalid], {}, '/tmp'), invalid).toThrow(ConfigError);
    }
  });

  it('sanitizes the display name shown to the Host', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    await join('editor', cid('name1'), 'A\u0000B\tC');
    await join('editor', cid('name2'), 'x'.repeat(200));
    await join('editor', cid('name3'), '');

    const pending = (await getLobby()).body.pending;
    expect(pending).toHaveLength(3);
    expect(pending[0]?.displayName, 'control characters are stripped').toBe('ABC');
    expect(pending[1]?.displayName).toHaveLength(40);
    expect(pending[2]?.displayName).toBe('Guest');
  });

  it('requires the admin capability for every lobby route', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const guest = await fetch(`${current.adminBase}/admin/api/lobby`, {
      headers: { Authorization: `Bearer ${EDITOR}` },
    });
    expect(guest.status).toBe(401);
    const kickAsGuest = await fetch(`${current.adminBase}/admin/api/connections/${cid('x')}/kick`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${EDITOR}` },
    });
    expect(kickAsGuest.status).toBe(401);
  });
});
