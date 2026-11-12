import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Authenticator } from '../src/security/auth.js';
import { ROLE_CAPABILITIES, makePrincipal } from '../src/security/principal.js';
import { InviteStore } from '../src/invites/invites.js';
import { TestDocClient } from './helpers/docClient.js';
import { TEST_TOKEN, startTestServer, type TestServer } from './helpers/testServer.js';

let current: TestServer | undefined;
const fixtures: string[] = [];

afterEach(async () => {
  await current?.cleanup();
  current = undefined;
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CANDIDATE = TEST_TOKEN;
const CID = 'cid-candidate-000000';

function candidateAuthenticator(): Authenticator {
  const principal = makePrincipal('candidate');
  return (token) => (token === CANDIDATE ? principal : null);
}

function candidateHeaders(connectionId = CID, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${CANDIDATE}`,
    'X-CodePair-Connection': connectionId,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function roomHeaders(roomId: string, token: string, connectionId = CID): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-CodePair-Room': roomId,
    'X-CodePair-Connection': connectionId,
  };
}

async function readJson<T = unknown>(response: Response): Promise<{ status: number; body: T; text: string }> {
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T, text };
}

async function candidateRequest(route: string, init: RequestInit = {}) {
  return fetch(`${current!.base}${route}`, {
    ...init,
    headers: { ...candidateHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });
}

async function join(consent: boolean, connectionId = CID) {
  const response = await candidateRequest('/api/lobby/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Candidate', ...(consent ? { consent: true } : {}) }),
  });
  return readJson<{
    state?: string;
    seat?: string;
    error?: { code: string; message: string };
  }>(response);
}

async function lobby() {
  const response = await current!.requestAdmin('/admin/api/lobby');
  return readJson<{
    pending: Array<{ id: string; tokenRole: string; state: string }>;
    admitted: Array<{ connectionId: string; role: string }>;
  }>(response);
}

async function admit(id: string, role: 'editor' | 'viewer' | 'candidate') {
  const response = await current!.requestAdmin(`/admin/api/lobby/${id}/admit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  return readJson<{ entry?: unknown; error?: { code: string; message: string } }>(response);
}

async function replay(roomId = current!.config.roomId) {
  const response = await current!.requestAdmin(`/admin/api/rooms/${roomId}/replay`);
  return readJson<{
    roomId?: string;
    consent?: Array<{ connectionId: string; acceptedAt: number }>;
    consentManifest?: Array<{ id: string }>;
    events?: Array<{ type: string; connectionId: string; size?: number; path?: string }>;
    updates?: Array<{ path: string; chars: number; insertedChars: number }>;
    snapshots?: Array<{ path: string; content: string }>;
    truncated?: { events: boolean; updates: boolean; snapshots: boolean };
    error?: { code: string; message: string };
  }>(response);
}

async function createInterviewRoom(roomRoot: string) {
  const response = await current!.requestAdmin('/admin/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: roomRoot, profile: 'interview', candidateDir: 'solution' }),
  });
  return readJson<{
    room?: { id: string; profile?: string; candidateDir?: string };
    tokens?: { owner?: string; editor?: string; viewer?: string; candidate?: string };
    error?: { code: string; message: string };
  }>(response);
}

describe('candidate seat and interview policy', () => {
  it('grants the candidate exactly read, write and call access', () => {
    expect([...ROLE_CAPABILITIES.candidate].sort()).toEqual(
      ['call.join', 'fs.read', 'fs.write'].sort(),
    );
    expect(ROLE_CAPABILITIES.candidate).not.toContain('fs.delete');
    expect(ROLE_CAPABILITIES.candidate).not.toContain('term.use');
  });

  it('allows a candidate invite, without changing rotation semantics', () => {
    const store = new InviteStore({
      tokenFor: (role) => (role === ('candidate' as never) ? 'candidate-token-0123456789' : undefined),
    });
    const invite = store.create({ role: 'candidate' as never });
    expect(invite.role).toBe('candidate');
    expect(store.revokeForRole('candidate' as never)).toBe(1);
  });

  it('advertises the consent manifest and disables Monaco suggestions for candidates only', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      authOverride: candidateAuthenticator(),
    });

    const session = await readJson<{
      role: string;
      interview?: {
        monacoSuggestions?: boolean;
        sandboxTerminalAvailable?: boolean;
        consent?: Array<{ id: string; label: string; detail: string }>;
      };
    }>(await candidateRequest('/api/session'));

    expect(session.status).toBe(200);
    expect(session.body.role).toBe('candidate');
    expect(session.body.interview?.monacoSuggestions).toBe(false);
    expect(session.body.interview?.consent?.map((item) => item.id)).toEqual(
      expect.arrayContaining(['paste', 'focus', 'fullscreen', 'screen-share', 'replay']),
    );
    for (const item of session.body.interview?.consent ?? []) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.detail.length).toBeGreaterThan(0);
    }

    await current.cleanup();
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });
    const owner = await readJson<{ interview?: unknown }>(
      await fetch(`${current.base}/api/session`, {
        headers: { Authorization: `Bearer ${current.token}` },
      }),
    );
    expect(owner.status).toBe(200);
    expect(owner.body.interview).toBeUndefined();
  });

  it('creates an interview room with a candidate token, seeded writable folder and existing policy rules', async () => {
    current = await startTestServer({ files: { 'README.md': '# task\n' }, lobby: false });
    const roomRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-interview-room-'));
    fixtures.push(roomRoot);
    fs.writeFileSync(path.join(roomRoot, 'README.md'), '# task\n');

    const created = await createInterviewRoom(roomRoot);
    expect(created.status).toBe(201);
    expect(created.body.room?.profile).toBe('interview');
    expect(created.body.room?.candidateDir).toBe('solution');
    expect(created.body.tokens?.candidate).toBeTruthy();
    expect(fs.existsSync(path.join(roomRoot, 'solution'))).toBe(true);

    const roomId = created.body.room!.id;
    const candidate = created.body.tokens!.candidate!;
    const policy = await readJson<{ rules?: Array<{ pattern: string; access: string }> }>(
      await current.requestAdmin(`/admin/api/rooms/${roomId}/policy`),
    );
    expect(policy.status).toBe(200);
    expect(policy.body.rules).toEqual(
      expect.arrayContaining([
        { pattern: 'solution', access: 'rw' },
        { pattern: 'solution/**', access: 'rw' },
        { pattern: '**', access: 'r' },
      ]),
    );

    const solutionWrite = await fetch(`${current.base}/api/files`, {
      method: 'POST',
      headers: { ...roomHeaders(roomId, candidate), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'solution/main.ts', type: 'file', content: 'export {}\n' }),
    });
    expect(solutionWrite.status, 'the candidate may write under solution/').toBe(201);

    const rootWrite = await fetch(`${current.base}/api/files`, {
      method: 'POST',
      headers: { ...roomHeaders(roomId, candidate), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes.md', type: 'file', content: 'no\n' }),
    });
    expect(rootWrite.status, 'the candidate may not write outside solution/').toBe(403);

    const deletion = await fetch(`${current.base}/api/files?path=solution/main.ts`, {
      method: 'DELETE',
      headers: roomHeaders(roomId, candidate),
    });
    expect(deletion.status, 'the candidate never receives fs.delete').toBe(403);

    // A symlinked candidate directory must not become a Docker bind-mount source
    // that resolves outside the room root.
    const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-interview-escape-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-interview-outside-'));
    fixtures.push(escapeRoot, outside);
    fs.symlinkSync(outside, path.join(escapeRoot, 'solution'), 'dir');
    const escaped = await createInterviewRoom(escapeRoot);
    expect(escaped.status).toBe(400);
    expect(escaped.body.error?.code).toBe('INVALID_CANDIDATE_DIR');
  });
});

describe('consent gate', () => {
  it('logs nothing and queues nothing before consent', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      lobby: true,
      authOverride: candidateAuthenticator(),
    });

    const joined = await join(false);
    expect(joined.status).toBe(403);
    expect(joined.body.error?.code).toBe('CONSENT_REQUIRED');
    expect((await lobby()).body.pending).toEqual([]);

    const replayBefore = await replay();
    expect(replayBefore.status).toBe(200);
    expect(replayBefore.body.events).toEqual([]);
    expect(replayBefore.body.consent).toEqual([]);

    const flagged = await candidateRequest('/api/integrity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'blur' }] }),
    });
    expect(flagged.status, 'no integrity event can be recorded before consent').not.toBe(202);
    expect((await replay()).body.events).toEqual([]);
  });

  it('starts logging only after consent and admission', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      lobby: true,
      authOverride: candidateAuthenticator(),
    });

    const joined = await join(true);
    expect(joined.status).toBe(200);
    expect(joined.body.state).toBe('waiting');
    const pending = (await lobby()).body.pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tokenRole).toBe('candidate');

    const admitted = await admit(pending[0]!.id, 'candidate');
    expect(admitted.status).toBe(200);

    const event = await candidateRequest('/api/integrity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          { type: 'blur' },
          { type: 'paste', path: 'solution/main.ts', size: 12 },
          { type: 'screen-share-surface', surface: 'monitor' },
        ],
      }),
    });
    expect(event.status).toBe(202);

    const replayed = await replay();
    expect(replayed.status).toBe(200);
    expect(replayed.body.consent).toEqual([
      expect.objectContaining({ connectionId: CID, acceptedAt: expect.any(Number) }),
    ]);
    expect(replayed.body.events?.map((item) => item.type)).toEqual([
      'blur',
      'paste',
      'screen-share-surface',
    ]);
    expect(replayed.body.events?.[1]).toMatchObject({ path: 'solution/main.ts', size: 12 });
  });

  it('caps the event log instead of growing memory without bound', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      lobby: false,
      authOverride: candidateAuthenticator(),
    });
    expect((await join(true)).status).toBe(200);

    for (let batch = 0; batch < 21; batch += 1) {
      const response = await candidateRequest('/api/integrity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          events: Array.from({ length: 100 }, () => ({ type: 'visibility' })),
        }),
      });
      expect(response.status).toBe(202);
    }

    const replayed = await replay();
    expect(replayed.status).toBe(200);
    expect(replayed.body.events).toHaveLength(2000);
    expect(replayed.body.truncated?.events).toBe(true);
  });

  it('refuses to admit a candidate token as an editor', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      lobby: true,
      authOverride: candidateAuthenticator(),
    });
    expect((await join(true)).status).toBe(200);
    const pending = (await lobby()).body.pending;
    expect(pending).toHaveLength(1);

    const escalated = await admit(pending[0]!.id, 'editor');
    expect(escalated.status).toBe(403);
    expect(escalated.body.error?.code).toBe('ROLE_CEILING');
    expect((await lobby()).body.pending[0]?.state).toBe('waiting');
  });
});

describe('session replay data', () => {
  it('is admin-gated and exposes timestamped events, typed-vs-paste update sizes and snapshots', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'start\n' },
      lobby: false,
      authOverride: candidateAuthenticator(),
    });
    expect((await join(true)).status).toBe(200);

    const client = await TestDocClient.connect({
      wsUrl: current.wsUrl,
      token: CANDIDATE,
      path: 'a.txt',
      connectionId: CID,
    });
    try {
      client.text.insert(client.text.length, 'typed\n');
      client.text.insert(client.text.length, 'x'.repeat(500));
      await new Promise((resolve) => setTimeout(resolve, 300));

      const unauthenticated = await fetch(
        `${current.adminBase}/admin/api/rooms/${current.config.roomId}/replay`,
      );
      expect(unauthenticated.status, 'replay is never public').toBe(401);

      const replayed = await replay();
      expect(replayed.status).toBe(200);
      expect(replayed.body.consentManifest?.map((item) => item.id)).toContain('replay');
      expect(replayed.body.updates?.length).toBeGreaterThan(0);
      expect(
        replayed.body.updates?.some((update) => update.path === 'a.txt' && update.insertedChars >= 500),
        'a paste-shaped update is distinguishable from a small typed edit',
      ).toBe(true);
      expect(replayed.body.snapshots?.some((snapshot) => snapshot.content.includes('typed'))).toBe(true);
    } finally {
      client.destroy();
    }

    // Re-run with the normal authenticator: the candidate override above makes
    // every accepted token a candidate, so it cannot prove the role guard.
    await current.cleanup();
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, lobby: false });
    const ownerAttempt = await fetch(`${current.base}/api/integrity`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${current.token}`,
        'X-CodePair-Connection': 'owner-integrity-0001',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ events: [{ type: 'blur' }] }),
    });
    expect(ownerAttempt.status, 'integrity signals are candidate-only').toBe(403);
    const ownerError = (await ownerAttempt.json()) as { error?: { code: string } };
    expect(ownerError.error?.code).toBe('INTERVIEW_ONLY');
  });
});
