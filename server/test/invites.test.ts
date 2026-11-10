import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  INVITE_FAILURE_TRACKER_CAP,
  INVITE_MAX_LIVE,
  InviteStore,
  inviteNotFound,
  type Invite,
} from '../src/invites/invites.js';
import { startTestServer, type TestRole, type TestServer } from './helpers/testServer.js';

let current: TestServer | undefined;
const fixtures: string[] = [];

const OWNER = 'owner-token-0123456789ab';
const EDITOR = 'editor-token-0123456789ab';
const VIEWER = 'viewer-token-0123456789ab';
const TOKENS = { owner: OWNER, editor: EDITOR, viewer: VIEWER };
const UNKNOWN = 'unknown-invite-id-0123456789';

afterEach(async () => {
  await current?.cleanup();
  current = undefined;
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface JsonResult<T> {
  status: number;
  text: string;
  body: T;
  headers: Headers;
}

interface ErrorBody {
  error: { code: string; message: string };
}

async function readJson<T>(response: Response): Promise<JsonResult<T>> {
  const text = await response.text();
  const body = (text.length > 0 ? JSON.parse(text) : undefined) as T;
  return { status: response.status, text, body, headers: response.headers };
}

async function adminJson<T>(route: string, init: RequestInit = {}): Promise<JsonResult<T>> {
  return readJson<T>(await current!.requestAdmin(route, init));
}

function createInvite(body: { role: string; ttlMinutes?: number | null; maxUses?: number | null }) {
  return adminJson<{ invite: Invite } & ErrorBody>('/admin/api/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function listInvites() {
  return adminJson<{ invites: Invite[] } & ErrorBody>('/admin/api/invites');
}

function revokeInvite(id: string) {
  return adminJson<{ invite: Invite } & ErrorBody>(`/admin/api/invites/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
  });
}

async function redeem(id: string) {
  return readJson<{ token: string; role: string } & ErrorBody>(
    await fetch(`${current!.base}/api/invites/${encodeURIComponent(id)}/redeem`, { method: 'POST' }),
  );
}

function guest(token: string, route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${current!.base}${route}`, { ...init, headers });
}

function lobbyHeaders(connectionId: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-CodePair-Connection': connectionId };
}

function captureInviteError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('Expected the invite operation to fail.');
}

function tokenSource(initial: string | undefined = EDITOR) {
  let value: string | undefined = initial;
  return {
    source: { tokenFor: (): string | undefined => value },
    set(next: string | undefined): void {
      value = next;
    },
  };
}

describe('InviteStore', () => {
  it('creates an editor invite with TTL and max uses, and refuses owner', () => {
    const now = 1_000_000;
    const tokens = tokenSource();
    const store = new InviteStore(tokens.source, { now: () => now });

    const invite = store.create({ role: 'editor', ttlMinutes: 5, maxUses: 2 });
    expect(invite.role).toBe('editor');
    expect(invite.createdAt).toBe(now);
    expect(invite.expiresAt).toBe(now + 5 * 60_000);
    expect(invite.maxUses).toBe(2);
    expect(invite.usedCount).toBe(0);
    expect(invite.revoked).toBe(false);
    expect(invite.id).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(invite.id).not.toContain('=');

    const owner = captureInviteError(() => store.create({ role: 'owner' }));
    expect(owner.status).toBe(400);
    expect(owner.message).toMatch(/owner/i);
  });

  it('redeems a real token, increments usedCount only on success, and stops at maxUses', () => {
    const now = 1_000_000;
    const tokens = tokenSource();
    const store = new InviteStore(tokens.source, { now: () => now });
    const invite = store.create({ role: 'editor', maxUses: 1 });

    expect(store.redeem(invite.id)).toEqual({ token: EDITOR, role: 'editor' });
    expect(store.get(invite.id)?.usedCount).toBe(1);

    const exhausted = captureInviteError(() => store.redeem(invite.id));
    expect(exhausted.status).toBe(404);
    expect(store.get(invite.id)?.usedCount).toBe(1);
  });

  it('expires at the configured instant and fails closed', () => {
    let now = 1_000_000;
    const tokens = tokenSource();
    const store = new InviteStore(tokens.source, { now: () => now });
    const invite = store.create({ role: 'editor', ttlMinutes: 1 });

    now = 1_059_999;
    expect(store.redeem(invite.id).token).toBe(EDITOR);
    now = 1_060_000;

    const expired = captureInviteError(() => store.redeem(invite.id));
    expect(expired.status).toBe(404);
    expect(expired.code).toBe('INVITE_INVALID');
  });

  it('uses one indistinguishable error for revoked and unknown ids', () => {
    const tokens = tokenSource();
    const store = new InviteStore(tokens.source);
    const invite = store.create({ role: 'editor' });
    store.revoke(invite.id);

    const revoked = captureInviteError(() => store.redeem(invite.id));
    const unknown = captureInviteError(() => store.redeem(UNKNOWN));
    const expected = inviteNotFound();

    expect(revoked.status).toBe(404);
    expect(revoked.code).toBe(expected.code);
    expect(revoked.message).toBe(expected.message);
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe(expected.code);
    expect(unknown.message).toBe(expected.message);
  });

  it('caps live invites at 50 without evicting an old one', () => {
    const tokens = tokenSource();
    const store = new InviteStore(tokens.source);
    const created = Array.from({ length: INVITE_MAX_LIVE }, () => store.create({ role: 'editor' }));

    const over = captureInviteError(() => store.create({ role: 'editor' }));
    expect(over.status).toBe(429);
    expect(store.list()).toHaveLength(INVITE_MAX_LIVE);
    expect(store.list().map((invite) => invite.id)).toEqual(created.map((invite) => invite.id));

    store.revoke(created[0]!.id);
    expect(store.create({ role: 'editor' }).role).toBe('editor');
    expect(store.list()).toHaveLength(INVITE_MAX_LIVE);
  });

  it('blocks after 10 failures even for an otherwise valid id, then recovers after 60s', () => {
    let now = 1_000_000;
    const tokens = tokenSource(EDITOR);
    const store = new InviteStore(tokens.source, { now: () => now });
    const invite = store.create({ role: 'editor' });

    tokens.set(undefined);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(captureInviteError(() => store.redeem(invite.id)).status).toBe(404);
    }

    // The invite itself is still live: only the rate limiter is refusing it.
    tokens.set(EDITOR);
    const blocked = captureInviteError(() => store.redeem(invite.id));
    expect(blocked.status).toBe(429);

    now += 60_001;
    expect(store.redeem(invite.id)).toEqual({ token: EDITOR, role: 'editor' });
  });

  it('bounds the per-id failure tracker when more than 1000 distinct ids are hammered', () => {
    const tokens = tokenSource();
    const store = new InviteStore(tokens.source);

    for (let attempt = 0; attempt < 9; attempt += 1) {
      captureInviteError(() => store.redeem('old-id'));
    }
    expect(store.failureCount('old-id')).toBe(9);

    for (let index = 0; index < 1200; index += 1) {
      captureInviteError(() => store.redeem(`unknown-${index}`));
    }

    expect(store.failureTrackerSize()).toBeLessThanOrEqual(INVITE_FAILURE_TRACKER_CAP);
    expect(store.failureTrackerSize()).toBeGreaterThan(0);
    expect(store.failureCount('old-id'), 'the oldest id must have been evicted').toBe(0);
  });

  it('evicts stale failures but keeps a currently blocked id when the tracker is full', () => {
    const tokens = tokenSource();
    const store = new InviteStore(tokens.source);

    // A stale, unblocked id inserted first.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      captureInviteError(() => store.redeem('stale-id'));
    }
    expect(store.failureCount('stale-id')).toBe(9);

    // A different id reaches 10 failures and is now blocked for 60s.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      captureInviteError(() => store.redeem('blocked-id'));
    }
    expect(store.failureCount('blocked-id')).toBe(10);

    // Flood with more distinct ids than the cap.
    for (let index = 0; index < 1200; index += 1) {
      captureInviteError(() => store.redeem(`unknown-${index}`));
    }

    expect(store.failureTrackerSize()).toBeLessThanOrEqual(INVITE_FAILURE_TRACKER_CAP);
    expect(store.failureCount('stale-id')).toBe(0);

    // The cap must not evict the entry that is actively enforcing a block.
    expect(store.failureCount('blocked-id')).toBe(10);
    const stillBlocked = captureInviteError(() => store.redeem('blocked-id'));
    expect(stillBlocked.status).toBe(429);
  });

  it('keeps tracking a new id when every tracked id is currently blocked (soft cap)', () => {
    const tokens = tokenSource();
    const store = new InviteStore(tokens.source);

    // Fill every nominal slot with an id that is actively blocked.
    for (let index = 0; index < INVITE_FAILURE_TRACKER_CAP; index += 1) {
      const id = `blocked-${index}`;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        captureInviteError(() => store.redeem(id));
      }
    }
    expect(store.failureTrackerSize()).toBe(INVITE_FAILURE_TRACKER_CAP);
    expect(store.failureCount('blocked-0')).toBe(10);

    // A new id must not be silently ignored just because every slot is blocked.
    captureInviteError(() => store.redeem('fresh-id'));
    expect(store.failureCount('fresh-id')).toBe(1);
    expect(store.failureTrackerSize()).toBe(INVITE_FAILURE_TRACKER_CAP + 1);

    // Its failures still accumulate toward its own block.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      captureInviteError(() => store.redeem('fresh-id'));
    }
    expect(captureInviteError(() => store.redeem('fresh-id')).status).toBe(429);

    // Existing blocked ids were not sacrificed to make room.
    expect(store.failureCount('blocked-0')).toBe(10);
    expect(captureInviteError(() => store.redeem('blocked-0')).status).toBe(429);
  });
});

describe('invite HTTP API', () => {
  it('refuses to create an owner invite', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const created = await createInvite({ role: 'owner' });

    expect(created.status).toBe(400);
    expect(created.body.error.message).toMatch(/owner/i);
  });

  it('redeems a real editor token and still goes through the lobby', async () => {
    current = await startTestServer({ lobby: true, files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const created = await createInvite({ role: 'editor', ttlMinutes: 5, maxUses: 2 });
    expect(created.status).toBe(201);

    const redeemed = await redeem(created.body.invite.id);
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toEqual({ token: EDITOR, role: 'editor' });

    const session = await guest(EDITOR, '/api/session');
    expect(session.status).toBe(200);
    expect(((await session.json()) as { role: string }).role).toBe('editor');

    const connectionId = 'cid-invite-editor-0001';
    const joined = await guest(EDITOR, '/api/lobby/join', {
      method: 'POST',
      headers: lobbyHeaders(connectionId),
      body: JSON.stringify({ displayName: 'Invited' }),
    });
    expect(joined.status).toBe(200);
    expect(((await joined.json()) as { state: string }).state).toBe('waiting');

    const beforeAdmit = await guest(EDITOR, '/api/tree', { headers: lobbyHeaders(connectionId) });
    expect(beforeAdmit.status).toBe(403);

    const snapshot = await adminJson<{ pending: Array<{ id: string }> }>('/admin/api/lobby');
    const entry = snapshot.body.pending.find((item) => item.id);
    expect(entry).toBeDefined();
    const admitted = await adminJson('/admin/api/lobby/' + encodeURIComponent(entry!.id) + '/admit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(admitted.status).toBe(200);

    const afterAdmit = await guest(EDITOR, '/api/tree', { headers: lobbyHeaders(connectionId) });
    expect(afterAdmit.status).toBe(200);

    const listed = await listInvites();
    expect(listed.body.invites[0]?.usedCount).toBe(1);
  });

  it('returns the same 404 body for expired, exhausted, revoked and unknown invites', async () => {
    let now = 1_000_000;
    current = await startTestServer({
      lobby: true,
      files: { 'a.txt': 'x\n' },
      tokens: TOKENS,
      inviteNow: () => now,
    });

    const expired = await createInvite({ role: 'editor', ttlMinutes: 1 });
    now += 61_000;

    const exhausted = await createInvite({ role: 'editor', maxUses: 1 });
    expect((await redeem(exhausted.body.invite.id)).status).toBe(200);

    const revoked = await createInvite({ role: 'viewer' });
    expect((await revokeInvite(revoked.body.invite.id)).status).toBe(200);

    const results = await Promise.all([
      redeem(expired.body.invite.id),
      redeem(exhausted.body.invite.id),
      redeem(revoked.body.invite.id),
      redeem(UNKNOWN),
    ]);

    for (const result of results) {
      expect(result.status).toBe(404);
      expect(result.body.error.code).toBe('INVITE_INVALID');
      expect(result.headers.get('cache-control')).toBe('no-store');
    }
    expect(results.map((result) => result.text)).toEqual(Array(4).fill(results[0]!.text));
  });

  it('returns 429 for the 51st live invite and leaves the first 50 untouched', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const ids: string[] = [];
    for (let index = 0; index < INVITE_MAX_LIVE; index += 1) {
      const created = await createInvite({ role: 'editor' });
      expect(created.status).toBe(201);
      ids.push(created.body.invite.id);
    }

    const over = await createInvite({ role: 'editor' });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('INVITE_LIMIT');

    const listed = await listInvites();
    expect(listed.body.invites.map((invite) => invite.id)).toEqual(ids);
  });

  it('rate-limits redeem attempts through the route as well as the store', async () => {
    let now = 1_000_000;
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      tokens: TOKENS,
      inviteNow: () => now,
    });
    const created = await createInvite({ role: 'editor' });
    await revokeInvite(created.body.invite.id);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await redeem(created.body.invite.id)).status).toBe(404);
    }
    expect((await redeem(created.body.invite.id)).status).toBe(429);

    now += 60_001;
    expect((await redeem(created.body.invite.id)).status).toBe(404);
  });

  it('resets invites when the Host switches root', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, tokens: TOKENS });
    const created = await createInvite({ role: 'editor' });
    expect(created.status).toBe(201);

    const nextRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-invite-root-'));
    fixtures.push(nextRoot);
    fs.writeFileSync(path.join(nextRoot, 'b.txt'), 'y\n');
    const switched = await adminJson('/admin/api/session/root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: nextRoot }),
    });
    expect(switched.status).toBe(200);

    expect((await listInvites()).body.invites).toEqual([]);
    expect((await redeem(created.body.invite.id)).status).toBe(404);
  });
});
