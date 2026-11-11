import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startTestServer, type TestServer } from './helpers/testServer.js';

let current: TestServer | undefined;
const fixtures: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.terminate();
    } catch {
      // already closed
    }
  }
  await current?.cleanup();
  current = undefined;
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-room-'));
  fixtures.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

interface CreatedRoom {
  room: { id: string; rootName: string; rootPath: string; createdAt: number; isDefault: boolean };
  tokens: { owner: string; editor: string; viewer: string };
}

async function createRoom(root: string): Promise<CreatedRoom> {
  const response = await current!.requestAdmin('/admin/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: root }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(201);
  return JSON.parse(text) as CreatedRoom;
}

async function adminJson<T>(route: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await current!.requestAdmin(route, init);
  const text = await response.text();
  return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : undefined) as T };
}

function roomRequest(roomId: string, token: string, route: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-CodePair-Room', roomId);
  return fetch(`${current!.base}${route}`, { ...init, headers });
}

function configRoomId(): string {
  return current!.config.roomId;
}

async function openAuxSocket(route: string, token: string): Promise<{
  socket: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
}> {
  const socket = new WebSocket(`${current!.wsBase}${route}`, ['codepair', token]);
  sockets.push(socket);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { socket, closed };
}

describe('room registry', () => {
  it('creates an independent room with fresh tokens, root and lobby state', async () => {
    const secondRoot = fixture({ 'second.txt': 'second room\n' });
    current = await startTestServer({ files: { 'default.txt': 'default room\n' } });

    const created = await createRoom(secondRoot);
    expect(created.room.id).toMatch(/^[a-z0-9]{1,8}-[a-z0-9]{1,8}$/);
    expect(created.room.id).not.toBe(configRoomId());
    expect(created.room.isDefault).toBe(false);
    expect(created.tokens.owner).not.toBe(current.tokens.owner);
    const roomTokens = [created.tokens.owner, created.tokens.editor, created.tokens.viewer];
    expect(new Set(roomTokens).size).toBe(3);

    const session = await roomRequest(created.room.id, created.tokens.owner, '/api/session');
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as { roomId: string; rootName: string; role: string };
    expect(sessionBody.roomId).toBe(created.room.id);
    expect(sessionBody.rootName).toBe(path.basename(secondRoot));
    expect(sessionBody.role).toBe('owner');

    const tree = await roomRequest(created.room.id, created.tokens.owner, '/api/tree');
    const treeBody = (await tree.json()) as { entries: Array<{ name: string }> };
    expect(treeBody.entries.map((entry) => entry.name)).toContain('second.txt');
    expect(treeBody.entries.map((entry) => entry.name)).not.toContain('default.txt');

    const defaultTree = await current.requestAs('owner', '/api/tree');
    expect(((await defaultTree.json()) as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name)).toEqual(
      ['default.txt'],
    );

    const list = await adminJson<{ rooms: Array<{ id: string; isDefault: boolean; participants: number }> }>(
      '/admin/api/rooms',
    );
    expect(list.status).toBe(200);
    expect(list.body.rooms.map((room) => room.id)).toEqual(
      expect.arrayContaining([configRoomId(), created.room.id]),
    );
    expect(list.body.rooms.find((room) => room.id === configRoomId())?.isDefault).toBe(true);
  });

  it('uses the room selector only as a selector, never as a credential', async () => {
    const secondRoot = fixture({ 'second.txt': 'second room\n' });
    current = await startTestServer({ files: { 'default.txt': 'default room\n' } });
    const created = await createRoom(secondRoot);

    const nonsense = await roomRequest(created.room.id, 'definitely-wrong-token-0123456789', '/api/session');
    const nonsenseText = await nonsense.text();
    expect(nonsense.status).toBe(401);

    const tokenForAWithHeaderB = await roomRequest(created.room.id, current.tokens.owner, '/api/session');
    const mismatchText = await tokenForAWithHeaderB.text();
    expect(tokenForAWithHeaderB.status).toBe(401);
    expect(mismatchText).toBe(nonsenseText);

    // The same token is valid when the selector names its own room.
    expect((await current.requestAs('owner', '/api/session')).status).toBe(200);
  });

  it('rejects a connection id claimed by room A when it is presented to room B', async () => {
    const secondRoot = fixture({ 'second.txt': 'second room\n' });
    current = await startTestServer({ files: { 'default.txt': 'default room\n' } });
    const created = await createRoom(secondRoot);
    const sharedCid = 'shared-connection-0123456789';

    const inA = await current.requestAs('owner', '/api/tree', {
      headers: { 'X-CodePair-Connection': sharedCid },
    });
    expect(inA.status).toBe(200);

    const inB = await roomRequest(created.room.id, created.tokens.owner, '/api/tree', {
      headers: { 'X-CodePair-Connection': sharedCid },
    });
    const inBText = await inB.text();
    expect(inB.status).toBe(403);
    expect(inBText).toContain('ROOM_MISMATCH');

    const fresh = await roomRequest(created.room.id, created.tokens.owner, '/api/tree', {
      headers: { 'X-CodePair-Connection': 'fresh-connection-0123456789' },
    });
    expect(fresh.status).toBe(200);

    const wsStatus = await new Promise<number | undefined>((resolve) => {
      const socket = new WebSocket(
        `${current!.wsBase}/ws/doc?path=second.txt&cid=${sharedCid}&room=${encodeURIComponent(created.room.id)}`,
        ['codepair', created.tokens.owner],
      );
      sockets.push(socket);
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      socket.on('error', () => resolve(undefined));
    });
    expect(wsStatus).toBe(403);
  });

  it('keeps invites and tokens inside their room', async () => {
    const secondRoot = fixture({ 'second.txt': 'second room\n' });
    current = await startTestServer({
      lobby: true,
      files: { 'default.txt': 'default room\n' },
      tokens: { editor: 'editor-token-0123456789ab' },
    });
    const created = await createRoom(secondRoot);

    const inviteA = await adminJson<{ invite: { id: string } }>('/admin/api/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    });
    const inviteB = await adminJson<{ invite: { id: string } }>(`/admin/api/rooms/${created.room.id}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(inviteA.status).toBe(201);
    expect(inviteB.status).toBe(201);

    const wrongRoom = await fetch(`${current.base}/api/invites/${inviteA.body.invite.id}/redeem`, {
      method: 'POST',
      headers: { 'X-CodePair-Room': created.room.id },
    });
    expect(wrongRoom.status).toBe(404);
    expect(await wrongRoom.text()).toContain('INVITE_INVALID');

    const redeemed = await fetch(`${current.base}/api/invites/${inviteB.body.invite.id}/redeem`, {
      method: 'POST',
      headers: { 'X-CodePair-Room': created.room.id },
    });
    expect(redeemed.status).toBe(200);
    const redeemedBody = (await redeemed.json()) as { token: string; role: string };
    expect(redeemedBody.role).toBe('editor');
    expect((await roomRequest(created.room.id, redeemedBody.token, '/api/session')).status).toBe(200);
    expect(
      (
        await fetch(`${current.base}/api/session`, {
          headers: { Authorization: `Bearer ${redeemedBody.token}` },
        })
      ).status,
    ).toBe(401);
  });

  it('switches only the room that was addressed', async () => {
    const secondRoot = fixture({ 'second.txt': 'second room\n' });
    const switchedRoot = fixture({ 'switched.txt': 'switched room\n' });
    current = await startTestServer({ files: { 'default.txt': 'default room\n' } });
    const created = await createRoom(secondRoot);

    const switched = await adminJson<{ changed: boolean; session: { roomId: string; rootPath: string } }>(
      `/admin/api/rooms/${created.room.id}/session/root`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: switchedRoot }),
      },
    );
    expect(switched.status).toBe(200);
    expect(switched.body.changed).toBe(true);
    expect(switched.body.session.roomId).toBe(created.room.id);
    expect(fs.realpathSync(switched.body.session.rootPath)).toBe(fs.realpathSync(switchedRoot));

    const defaultTree = await current.requestAs('owner', '/api/tree');
    expect(((await defaultTree.json()) as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name)).toEqual(
      ['default.txt'],
    );
    const roomTree = await roomRequest(created.room.id, created.tokens.owner, '/api/tree');
    expect(((await roomTree.json()) as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name)).toEqual([
      'switched.txt',
    ]);
  });

  it('deletes a non-default room and tears down its documents, PTYs and sockets', async () => {
    const secondRoot = fixture({ 'second.txt': 'second room\n' });
    current = await startTestServer({
      files: { 'default.txt': 'default room\n' },
      env: { CODE_PAIR_TERMINAL: 'on' },
    });
    const created = await createRoom(secondRoot);
    const room = current.server.sessions.get(created.room.id);
    expect(room).toBeDefined();
    const cid = 'delete-room-connection-0123456789';

    const doc = await openAuxSocket(
      `/ws/doc?path=second.txt&cid=${cid}&room=${encodeURIComponent(created.room.id)}`,
      created.tokens.owner,
    );
    const terminal = await openAuxSocket(
      `/ws/terminal?cid=${cid}&room=${encodeURIComponent(created.room.id)}`,
      created.tokens.owner,
    );
    const signal = await openAuxSocket(
      `/ws/signal?room=${encodeURIComponent(created.room.id)}&cid=${cid}`,
      created.tokens.owner,
    );
    signal.socket.send(JSON.stringify({ type: 'join', name: 'Owner', color: '#3366ff' }));

    const deleted = await current.requestAdmin(`/admin/api/rooms/${created.room.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);

    const [docClose, terminalClose, signalClose] = await Promise.all([doc.closed, terminal.closed, signal.closed]);
    for (const [label, outcome] of [
      ['doc', docClose],
      ['terminal', terminalClose],
      ['signal', signalClose],
    ] as const) {
      expect(outcome.code, `${label} closes with the room code`).toBe(4412);
    }
    expect(current.server.sessions.get(created.room.id)).toBeUndefined();
    expect((await current.requestAs('owner', '/api/session')).status).toBe(200);

    const gone = await adminJson<{ error: { code: string } }>(`/admin/api/rooms/${created.room.id}/state`);
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe('ROOM_NOT_FOUND');

    const protectedDefault = await current.requestAdmin(`/admin/api/rooms/${configRoomId()}`, { method: 'DELETE' });
    expect(protectedDefault.status).toBe(409);
  });
});
