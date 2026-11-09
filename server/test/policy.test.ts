import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildBanner } from '../src/banner.js';
import { ConfigError, TERMINAL_BYPASS_WARNING, parseConfig, terminalBypassesRules } from '../src/config.js';
import {
  AccessPolicy,
  DEFAULT_SECRET_RULES,
  DEFAULT_SECRET_SAMPLES,
  MAX_API_RULES,
  MAX_RULE_PATTERN,
  rulesUnhideDefaults,
  validateRules,
  type Rule,
} from '../src/security/accessPolicy.js';
import { capabilitiesForRole } from '../src/security/principal.js';
import { TestDocClient } from './helpers/docClient.js';
import { startTestServer, waitFor, type TestRole, type TestServer } from './helpers/testServer.js';

let current: TestServer | undefined;
const sockets: WebSocket[] = [];
const clients: TestDocClient[] = [];
const fixtures: string[] = [];

const OWNER = 'owner-token-0123456789ab';
const EDITOR = 'editor-token-0123456789ab';
const VIEWER = 'viewer-token-0123456789ab';

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
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
): Promise<{ status: number; body: T; text: string }> {
  const text = await response.text();
  return { status: response.status, body: (text.length > 0 ? JSON.parse(text) : undefined) as T, text };
}

interface PolicyResponse {
  rules: Rule[];
  defaults?: Rule[];
  confirmUnhide: boolean;
  terminalBypassesRules?: boolean;
  affected?: { closed: number; downgraded: number };
  error?: { code: string; message: string };
}

async function adminJson<T = PolicyResponse>(route: string, init: RequestInit = {}) {
  return readJson<T>(await current!.requestAdmin(route, init));
}

function putRules(rules: unknown, extra: Record<string, unknown> = {}) {
  return adminJson('/admin/api/policy/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules, ...extra }),
  });
}

function getPolicy() {
  return adminJson('/admin/api/policy');
}

async function treeAs(role: TestRole, dir = '') {
  const route = dir ? `/api/tree?path=${encodeURIComponent(dir)}` : '/api/tree';
  return readJson<{ entries: Array<{ name: string; path: string; access?: string }>; truncated: boolean }>(
    await current!.requestAs(role, route),
  );
}

async function fileAs(role: TestRole, file: string) {
  return readJson<{ content?: string; error?: { code: string; message: string } }>(
    await current!.requestAs(role, `/api/file?path=${encodeURIComponent(file)}`),
  );
}

async function searchAs(role: TestRole, query: string) {
  return readJson<{ entries: Array<{ path: string }> }>(
    await current!.requestAs(role, `/api/search?q=${encodeURIComponent(query)}`),
  );
}

function wsOutcome(file: string, token: string): Promise<{ opened: boolean; status?: number }> {
  const ctx = current!;
  return new Promise((resolve) => {
    const socket = new WebSocket(`${ctx.wsUrl}?path=${encodeURIComponent(file)}`, ['codepair', token]);
    sockets.push(socket);
    const timer = setTimeout(() => resolve({ opened: false }), 5000);
    socket.once('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve({ opened: true });
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timer);
      const match = /Unexpected server response: (\d+)/.exec(error.message);
      resolve({ opened: false, status: match ? Number(match[1]) : undefined });
    });
  });
}

function connectDoc(ctx: TestServer, file: string, token = OWNER): Promise<TestDocClient> {
  return TestDocClient.connect({ wsUrl: ctx.wsUrl, token, path: file }).then((client) => {
    clients.push(client);
    return client;
  });
}

interface OpenDocSession {
  flush(): Promise<void>;
}

function openDocSession(ctx: TestServer, file: string): OpenDocSession {
  const hub = ctx.server.sessions.current().documents as unknown as {
    sessions: Map<string, OpenDocSession>;
  };
  const session = hub.sessions.get(file);
  if (!session) throw new Error(`No open document session for ${file}.`);
  return session;
}

/** Hold `flush()` so a policy change is paused between its flush and its install. */
function holdFlush(session: OpenDocSession): {
  entered: Promise<boolean>;
  release: () => void;
  restore: () => void;
} {
  const original = session.flush.bind(session);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markEntered!: () => void;
  const enteredGate = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  session.flush = async () => {
    markEntered();
    await gate;
    await original();
  };
  return {
    entered: Promise.race([enteredGate.then(() => true), sleep(500).then(() => false)]),
    release,
    restore: () => {
      session.flush = original;
    },
  };
}

const SECRETS: Record<string, string> = {
  '.env': 'SECRET=1\n',
  'a/.env.local': 'LOCAL=1\n',
  'server.pem': 'pem\n',
  'id_rsa': 'key\n',
  '.aws/credentials': '[default]\n',
  'README.md': '# hi\n',
};

describe('path access policy', () => {
  describe('matcher', () => {
    it('matches case-insensitively', () => {
      const policy = new AccessPolicy([{ pattern: 'Secrets/Notes.md', access: 'hidden' }]);
      expect(policy.resolve('secrets/notes.md')).toBe('hidden');
      expect(policy.resolve('SECRETS/NOTES.MD')).toBe('hidden');
      expect(policy.resolve('.ENV')).toBe('hidden');
      expect(policy.resolve('a/.Env.Local')).toBe('hidden');
    });

    it('matches NFC and NFD spellings of the same name', () => {
      const policy = new AccessPolicy([{ pattern: 'café.md', access: 'hidden' }]);
      expect(policy.resolve('cafe\u0301.md')).toBe('hidden');
    });

    it('normalises dot, doubled and trailing slashes before matching', () => {
      const policy = new AccessPolicy([{ pattern: 'config/notes.md', access: 'hidden' }]);
      for (const candidate of ['config/./notes.md', 'config//notes.md', 'config/notes.md/', './config/notes.md']) {
        expect(policy.resolve(candidate), candidate).toBe('hidden');
      }
    });

    it('matches a basename rule at any depth and anchors rules that contain a slash', () => {
      const policy = new AccessPolicy([
        { pattern: 'scratch.log', access: 'r' },
        { pattern: 'config/*.json', access: 'hidden' },
      ]);
      expect(policy.resolve('scratch.log')).toBe('r');
      expect(policy.resolve('a/b/scratch.log')).toBe('r');
      expect(policy.resolve('config/app.json')).toBe('hidden');
      expect(policy.resolve('src/config/app.json')).toBe('rw');
    });

    it('covers the directory itself with dir/**', () => {
      const policy = new AccessPolicy([{ pattern: 'private/**', access: 'hidden' }]);
      expect(policy.resolve('private')).toBe('hidden');
      expect(policy.resolve('private/deep/file.txt')).toBe('hidden');
      expect(policy.resolve('privateer/file.txt')).toBe('rw');
    });

    it('matches a leading dot with *', () => {
      const policy = new AccessPolicy([{ pattern: '*.tmp', access: 'hidden' }]);
      expect(policy.resolve('.tmp')).toBe('hidden');
      expect(policy.resolve('a/b/report.tmp')).toBe('hidden');
    });

    it('uses the first matching host rule', () => {
      const policy = new AccessPolicy([
        { pattern: 'notes.md', access: 'hidden' },
        { pattern: 'notes.md', access: 'r' },
      ]);
      expect(policy.resolve('notes.md')).toBe('hidden');
    });

    it('keeps the defaults as a floor until the session confirms unhiding', () => {
      const policy = new AccessPolicy();
      policy.setRules([{ pattern: 'docs/**', access: 'r' }]);
      expect(policy.resolve('docs/.env')).toBe('hidden');
      expect(policy.resolve('docs/readme.md')).toBe('r');
      expect(policy.resolve('.ssh/config')).toBe('hidden');

      policy.setRules([{ pattern: 'docs/**', access: 'r' }, { pattern: '.env', access: 'r' }], true);
      expect(policy.resolve('docs/.env')).toBe('r');
      expect(policy.resolve('.env')).toBe('r');
    });

    it('rejects malformed, oversized and overlong rule lists', () => {
      expect(() => validateRules('nope')).toThrow();
      expect(() => validateRules([{ pattern: 'a'.repeat(MAX_RULE_PATTERN + 1), access: 'r' }])).toThrow();
      expect(() => validateRules([{ pattern: 'a\u0000b', access: 'r' }])).toThrow();
      expect(() => validateRules([{ pattern: 'a', access: 'read' }])).toThrow();
      expect(() => validateRules([{ pattern: 'a', access: 'r', extra: true }])).toThrow();
      expect(() =>
        validateRules(Array.from({ length: MAX_API_RULES + 1 }, () => ({ pattern: 'x', access: 'r' }))),
      ).toThrow();
    });

    it('matches correctly and stays fast on a hostile pattern and a 4 kB path', () => {
      const policy = new AccessPolicy([{ pattern: 'a*a*a*a*a*a*a*b', access: 'hidden' }]);
      // Positive controls: a matcher that never matches must not pass this test.
      expect(policy.resolve(`${'a'.repeat(7)}b`)).toBe('hidden');
      expect(policy.resolve(`${'a'.repeat(6)}b`), 'too few a\'s cannot match').toBe('rw');
      expect(policy.resolve(`${'a'.repeat(7)}c`), 'a trailing non-b cannot match').toBe('rw');
      expect(policy.resolve(`${'a'.repeat(64)}b`)).toBe('hidden');

      const started = performance.now();
      expect(policy.resolve(`${'a'.repeat(4096)}b`), 'the long path matches').toBe('hidden');
      expect(policy.resolve(`${'a'.repeat(4096)}c`), 'the long path can also miss').toBe('rw');
      expect(performance.now() - started, 'two 4 kB hostile matches must stay under 50 ms').toBeLessThan(50);
    });

    it('never lets a rule widen an existing capability', () => {
      const viewer = capabilitiesForRole('viewer');
      const editor = capabilitiesForRole('editor');
      const policy = new AccessPolicy([{ pattern: 'src/**', access: 'r' }]);
      expect(policy.effective(viewer, 'src/a.ts')).toEqual({ visible: true, read: true, write: false });
      expect(policy.effective(editor, 'src/a.ts')).toEqual({ visible: true, read: true, write: false });
      expect(policy.effective(editor, 'docs/a.ts')).toEqual({ visible: true, read: true, write: true });
      policy.setRules([{ pattern: 'src/**', access: 'rw' }]);
      expect(policy.effective(viewer, 'src/a.ts')).toEqual({ visible: true, read: true, write: false });
    });

    it('detects rules that would unhide a built-in secret', () => {
      expect(rulesUnhideDefaults([{ pattern: '**', access: 'rw' }])).toBe(true);
      expect(rulesUnhideDefaults([{ pattern: '.env', access: 'r' }])).toBe(true);
      expect(rulesUnhideDefaults([{ pattern: 'docs/**', access: 'r' }])).toBe(false);
      expect(rulesUnhideDefaults([{ pattern: '.env', access: 'hidden' }])).toBe(false);
    });

    it('ships the documented built-in secret list and samples', () => {
      expect(DEFAULT_SECRET_RULES.map((rule) => rule.pattern)).toEqual([
        '.env',
        '.env.*',
        '*.pem',
        '*.key',
        '*.p12',
        '*.pfx',
        'id_rsa*',
        'id_ed25519*',
        'id_ecdsa*',
        '.npmrc',
        '.netrc',
        '.pypirc',
        '.aws/**',
        '.ssh/**',
        '.gnupg/**',
        '.git/config',
        '*.kdbx',
        'credentials.json',
        '.docker/config.json',
      ]);
      expect(DEFAULT_SECRET_RULES.every((rule) => rule.access === 'hidden')).toBe(true);
      for (const sample of ['.env', 'a/.env.local', 'server.pem', '.aws/credentials', '.ssh/config']) {
        expect(DEFAULT_SECRET_SAMPLES, sample).toContain(sample);
      }
    });
  });

  describe('startup rules', () => {
    const base = ['--root', '/tmp', '--token', OWNER];

    it('parses repeatable --rule flags', () => {
      const config = parseConfig([...base, '--rule', 'docs/**=r', '--rule', 'notes.md=hidden']);
      expect(config.rules).toEqual([
        { pattern: 'docs/**', access: 'r' },
        { pattern: 'notes.md', access: 'hidden' },
      ]);
      expect(config.confirmUnhide).toBe(false);
    });

    it('refuses an invalid rule at startup', () => {
      expect(() => parseConfig([...base, '--rule', 'no-access'])).toThrow(ConfigError);
      expect(() => parseConfig([...base, '--rule', 'a.txt=write'])).toThrow(ConfigError);
      expect(() => parseConfig([...base, '--rule', `a=${'x'.repeat(300)}`])).toThrow(ConfigError);
    });

    it('refuses to lift a secret default without --confirm-unhide', () => {
      expect(() => parseConfig([...base, '--rule', '.env=r'])).toThrow(ConfigError);
      expect(() => parseConfig([...base, '--rule', `.env=${'a'.repeat(300)}`])).toThrow(ConfigError);
      const confirmed = parseConfig([...base, '--rule', '.env=r', '--confirm-unhide']);
      expect(confirmed.confirmUnhide).toBe(true);
      expect(confirmed.rules).toEqual([{ pattern: '.env', access: 'r' }]);
    });

    it('warns in the startup banner only when a shell bypasses the rules', () => {
      const info = { root: '/tmp', port: 7420, adminPort: 7421, adminToken: 'token', roomId: 'abcd-1234' };
      const withShell = parseConfig([...base], { CODE_PAIR_TERMINAL: 'on' }, '/tmp');
      expect(buildBanner(withShell, info)).toContain(TERMINAL_BYPASS_WARNING);

      const disabled = parseConfig([...base, '--no-terminal'], {}, '/tmp');
      expect(buildBanner(disabled, info)).not.toContain(TERMINAL_BYPASS_WARNING);
    });

    it('reports whether a shell bypasses the path rules', () => {
      const without = parseConfig([...base], { CODE_PAIR_TERMINAL: 'off' }, '/tmp');
      expect(terminalBypassesRules(without)).toBe(false);
      const withShell = parseConfig([...base], { CODE_PAIR_TERMINAL: 'on' }, '/tmp');
      expect(terminalBypassesRules(withShell)).toBe(true);
      expect(TERMINAL_BYPASS_WARNING).toBe(
        'Terminal access bypasses path rules; hidden files are readable from a shell.',
      );
    });
  });

  describe('default secrets', () => {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      it(`hides built-in secrets from ${role} on tree, search, file and the document socket`, async () => {
        current = await startTestServer({ files: SECRETS, tokens: { owner: OWNER, editor: EDITOR, viewer: VIEWER } });

        const root = await treeAs(role);
        expect(root.status).toBe(200);
        const names = root.body.entries.map((entry) => entry.name);
        for (const hidden of ['.env', '.aws', 'server.pem', 'id_rsa']) {
          expect(names, hidden).not.toContain(hidden);
        }
        expect(names).toContain('README.md');

        for (const [query, hiddenPath] of [
          ['env', '.env'],
          ['credentials', '.aws/credentials'],
          ['pem', 'server.pem'],
        ] as const) {
          const found = await searchAs(role, query);
          expect(found.body.entries.map((entry) => entry.path), hiddenPath).not.toContain(hiddenPath);
        }

        for (const file of ['.env', 'a/.env.local', 'server.pem', 'id_rsa', '.aws/credentials']) {
          const response = await fileAs(role, file);
          expect(response.status, file).toBe(404);
          expect(response.body.error!.code, file).toBe('NOT_FOUND');
        }

        const token = current.tokens[role]!;
        for (const file of ['.env', '.aws/credentials']) {
          const outcome = await wsOutcome(file, token);
          expect(outcome.opened, file).toBe(false);
          expect(outcome.status, file).toBe(404);
        }
      });
    }

    it('keeps a default secret hidden under a docs/** rule for every role', async () => {
      current = await startTestServer({
        files: { 'docs/.env': 'SECRET=1\n', 'docs/readme.md': '# docs\n', 'docs/sub/.env.local': 'x\n' },
        tokens: { owner: OWNER, editor: EDITOR, viewer: VIEWER },
      });
      const put = await putRules([{ pattern: 'docs/**', access: 'r' }]);
      expect(put.status).toBe(200);

      const viewerTree = await treeAs('viewer', 'docs');
      expect(viewerTree.status).toBe(200);
      const names = viewerTree.body.entries.map((entry) => entry.name).sort();
      expect(names).toEqual(['readme.md', 'sub']);
      expect(viewerTree.body.entries.every((entry) => entry.access === 'r')).toBe(true);
      expect(
        (await treeAs('viewer', 'docs/sub')).body.entries,
        'a directory containing only hidden entries is empty',
      ).toEqual([]);

      expect((await searchAs('viewer', 'env')).body.entries.map((entry) => entry.path)).toEqual([]);

      for (const file of ['docs/.env', 'docs/sub/.env.local']) {
        expect((await fileAs('viewer', file)).status, file).toBe(404);
      }

      const outcome = await wsOutcome('docs/.env', VIEWER);
      expect(outcome.opened).toBe(false);
      expect(outcome.status).toBe(404);
    });

    it('returns the same 404 body for a hidden file as for a missing one', async () => {
      current = await startTestServer({ files: { '.env': 'SECRET=1\n', 'README.md': '# hi\n' } });
      const hidden = await fileAs('owner', '.env');
      const missing = await fileAs('owner', 'does-not-exist.md');
      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(hidden.text).toBe(missing.text);
    });

    it('hides a visible-named symlink that points at a secret', async () => {
      current = await startTestServer({ files: { '.env': 'SECRET=1\n', 'README.md': '# hi\n' } });
      fs.symlinkSync(path.join(current.root, '.env'), path.join(current.root, 'notes.txt'));
      fs.symlinkSync(path.join(current.root, 'README.md'), path.join(current.root, 'readme-link.txt'));

      const root = await treeAs('owner');
      const names = root.body.entries.map((entry) => entry.name);
      expect(names).not.toContain('notes.txt');
      expect(names).toContain('readme-link.txt');
      expect((await fileAs('owner', 'notes.txt')).status).toBe(404);
      expect((await wsOutcome('notes.txt', current.token)).opened).toBe(false);
    });

    it('refuses to create, rename or delete a hidden path and leaves the disk untouched', async () => {
      current = await startTestServer({ files: { 'x.txt': 'x\n' } });

      const post = async (body: unknown) =>
        readJson<{ error?: { code: string } }>(
          await current!.requestAs('owner', '/api/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );
      const rename = async (from: string, to: string) =>
        readJson<{ error?: { code: string } }>(
          await current!.requestAs('owner', '/api/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to }),
          }),
        );
      const remove = async (target: string) =>
        readJson<{ error?: { code: string } }>(
          await current!.requestAs('owner', `/api/files?path=${encodeURIComponent(target)}`, { method: 'DELETE' }),
        );

      const attempts = [
        await post({ path: '.env', type: 'file' }),
        await post({ path: '.env.new', type: 'file' }),
        await rename('x.txt', '.env'),
        await rename('.env', 'y.txt'),
        await remove('.env'),
        await remove('.env.missing'),
      ];

      for (const attempt of attempts) {
        expect(attempt.status, attempt.text).toBe(403);
        expect(attempt.body.error?.code).toBe('FORBIDDEN');
        expect(attempt.text).toBe(attempts[0]!.text);
      }
      expect(fs.existsSync(path.join(current.root, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(current.root, 'x.txt'))).toBe(true);
      expect(fs.existsSync(path.join(current.root, 'y.txt'))).toBe(false);
    });

    it('refuses mutations that reach a hidden directory through a symlinked ancestor', async () => {
      current = await startTestServer({ files: { 'x.txt': 'x\n' } });
      fs.mkdirSync(path.join(current.root, '.ssh'), { recursive: true });
      fs.symlinkSync(path.join(current.root, '.ssh'), path.join(current.root, 'link'), 'dir');

      const create = await readJson(
        await current.requestAs('owner', '/api/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'link/authorized_keys', type: 'file' }),
        }),
      );
      const move = await readJson(
        await current.requestAs('owner', '/api/files/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'x.txt', to: 'link/x' }),
        }),
      );

      expect(create.status, create.text).toBe(403);
      expect(move.status, move.text).toBe(403);
      expect(fs.existsSync(path.join(current.root, '.ssh', 'authorized_keys'))).toBe(false);
      expect(fs.existsSync(path.join(current.root, 'x.txt'))).toBe(true);
    });
  });

  describe('read-only rules', () => {
    it('narrows an editor to read-only inside a src/** r rule', async () => {
      current = await startTestServer({
        files: { 'src/a.ts': 'export const a = 1;\n' },
        tokens: { owner: OWNER, editor: EDITOR },
      });
      expect((await putRules([{ pattern: 'src/**', access: 'r' }])).status).toBe(200);

      const srcTree = await treeAs('editor', 'src');
      expect(srcTree.body.entries[0]!.access).toBe('r');
      expect((await fileAs('editor', 'src/a.ts')).status).toBe(200);

      const create = await readJson(
        await current.requestAs('editor', '/api/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'src/b.ts', type: 'file' }),
        }),
      );
      const move = await readJson(
        await current.requestAs('editor', '/api/files/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'src/a.ts', to: 'src/c.ts' }),
        }),
      );
      const remove = await readJson(
        await current.requestAs('editor', '/api/files?path=src%2Fa.ts', { method: 'DELETE' }),
      );
      expect(create.status).toBe(403);
      expect(move.status).toBe(403);
      expect(remove.status).toBe(403);

      const editor = await connectDoc(current, 'src/a.ts', EDITOR);
      const owner = await connectDoc(current, 'src/a.ts', OWNER);
      await waitFor(() => editor.text.toString().includes('export const a'), 3000, 'initial content');

      editor.text.insert(0, 'HACK ');
      await waitFor(() => editor.metas.some((meta) => meta.type === 'denied'), 5000, 'denied');
      await sleep(200);
      expect(fs.readFileSync(path.join(current.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(owner.text.toString()).not.toContain('HACK');
    });

    it('refuses a directory rename that would change a descendant decision', async () => {
      current = await startTestServer({ files: { 'docs/sub/b.md': 'b\n', 'plain/c.md': 'c\n' } });
      expect((await putRules([{ pattern: 'docs/sub/**', access: 'hidden' }])).status).toBe(200);

      const blocked = await readJson(
        await current.requestAs('owner', '/api/files/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'docs', to: 'archive' }),
        }),
      );
      expect(blocked.status, blocked.text).toBe(403);
      expect(fs.existsSync(path.join(current.root, 'docs', 'sub', 'b.md'))).toBe(true);

      const allowed = await readJson(
        await current.requestAs('owner', '/api/files/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'plain', to: 'plain2' }),
        }),
      );
      expect(allowed.status, allowed.text).toBe(200);
    });

    it('counts only visible entries toward the tree cap', async () => {
      const files: Record<string, string> = { '.env': 'SECRET=1\n' };
      for (let index = 0; index < 4000; index += 1) files[`f${index}.txt`] = '';
      current = await startTestServer({ files });
      const root = await treeAs('owner');
      expect(root.body.entries.length, 'hidden entries do not consume the cap').toBe(4000);
      expect(root.body.truncated).toBe(false);
    });
  });

  describe('admin policy API', () => {
    it('replaces the rule list atomically and rejects invalid lists', async () => {
      current = await startTestServer({ files: { 'notes.md': 'n\n' } });
      const good = await putRules([{ pattern: 'notes.md', access: 'r' }]);
      expect(good.status).toBe(200);
      expect(good.body.rules).toEqual([{ pattern: 'notes.md', access: 'r' }]);
      expect(good.body.affected).toEqual({ closed: 0, downgraded: 0 });

      const unhide = await putRules([{ pattern: '.env', access: 'r' }]);
      expect(unhide.status).toBe(400);
      expect(unhide.body.error!.code).toBe('UNHIDE_SECRET');

      expect((await putRules([{ pattern: 'a', access: 'read' }])).status).toBe(400);
      expect((await putRules([{ pattern: 'a', access: 'r', extra: true }])).status).toBe(400);
      expect(
        (
          await putRules(
            Array.from({ length: MAX_API_RULES + 1 }, (_, index) => ({ pattern: `file-${index}`, access: 'r' })),
          )
        ).status,
      ).toBe(400);

      const after = await getPolicy();
      expect(after.body.rules, 'a rejected list changes nothing').toEqual([{ pattern: 'notes.md', access: 'r' }]);
    });

    it('rejects a guest token on the policy routes', async () => {
      current = await startTestServer({ files: { 'notes.md': 'n\n' } });
      const get = await readJson(
        await current.requestAdmin('/admin/api/policy', { headers: { Authorization: `Bearer ${OWNER}` } }),
      );
      expect(get.status).toBe(401);
      const put = await readJson(
        await current.requestAdmin('/admin/api/policy/rules', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ rules: [] }),
        }),
      );
      expect(put.status).toBe(401);
    });

    it('hides the defaults again when a later PUT omits the confirmation', async () => {
      current = await startTestServer({ files: { '.env': 'SECRET=1\n' } });
      const confirmed = await putRules([{ pattern: '.env', access: 'r' }], { confirmUnhide: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.confirmUnhide).toBe(true);
      expect((await fileAs('owner', '.env')).status).toBe(200);

      const relaxed = await putRules([{ pattern: 'docs/**', access: 'r' }]);
      expect(relaxed.status).toBe(200);
      expect(relaxed.body.confirmUnhide, 'the PUT echoes the session confirmation').toBe(false);
      expect((await fileAs('owner', '.env')).status).toBe(404);
      const policy = await getPolicy();
      expect(policy.body.rules).toEqual([{ pattern: 'docs/**', access: 'r' }]);
      expect(policy.body.confirmUnhide, 'the GET echoes the session confirmation').toBe(false);
    });

    it('starts a switched-to root unconfirmed, so a secret default is hidden again', async () => {
      current = await startTestServer({
        files: { '.env': 'SECRET=1\n' },
        tokens: { owner: OWNER, viewer: VIEWER },
      });
      const confirmed = await putRules([{ pattern: '.env', access: 'r' }], { confirmUnhide: true });
      expect(confirmed.status).toBe(200);
      expect((await fileAs('viewer', '.env')).status).toBe(200);

      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-policy-root-'));
      fixtures.push(other);
      fs.writeFileSync(path.join(other, '.env'), 'SECRET=2\n');
      const switched = await readJson(
        await current.requestAdmin('/admin/api/session/root', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: other }),
        }),
      );
      expect(switched.status).toBe(200);

      const policy = await getPolicy();
      expect(policy.body.rules, 'host rules do not follow the session').toEqual([]);
      expect(policy.body.confirmUnhide, 'confirmation does not follow the session').toBe(false);
      expect(
        (await fileAs('viewer', '.env')).status,
        'the new session hides the default again',
      ).toBe(404);
    });

    it('reports terminalBypassesRules with and without a terminal', async () => {
      current = await startTestServer({ files: { 'a.txt': 'x\n' }, env: { CODE_PAIR_TERMINAL: 'on' } });
      const enabled = await adminJson<PolicyResponse & { terminalBypassesRules: boolean }>('/admin/api/state');
      expect(enabled.body.terminalBypassesRules).toBe(true);

      await current.cleanup();
      current = await startTestServer({ files: { 'a.txt': 'x\n' } });
      const disabled = await adminJson<PolicyResponse & { terminalBypassesRules: boolean }>('/admin/api/state');
      expect(disabled.body.terminalBypassesRules).toBe(false);
    });
  });

  describe('live policy changes', () => {
    it('closes an open document with 4403 when a rule hides it', async () => {
      current = await startTestServer({ files: { 'secret.txt': 'shh\n' } });
      const socket = new WebSocket(`${current.wsUrl}?path=secret.txt`, ['codepair', current.token]);
      sockets.push(socket);
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
      );
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });

      expect((await putRules([{ pattern: 'secret.txt', access: 'hidden' }])).status).toBe(200);
      const outcome = await Promise.race([closed, sleep(1000).then(() => null)]);
      expect(outcome, 'a hidden document is closed with 4403').toEqual({
        code: 4403,
        reason: 'The host removed access to this file.',
      });
    });

    it('flushes pending edits before a read-only rule applies', async () => {
      current = await startTestServer({
        files: { 'notes.md': 'base\n' },
        tokens: { owner: OWNER, editor: EDITOR },
        env: { CODE_PAIR_SAVE_DEBOUNCE_MS: '1500' },
      });
      const editor = await connectDoc(current, 'notes.md', EDITOR);
      await waitFor(() => editor.text.toString() === 'base\n', 3000, 'initial content');

      editor.text.insert(0, 'first-');
      const live = openDocSession(current, 'notes.md') as unknown as { text: { toString(): string } };
      await waitFor(() => live.text.toString().includes('first-'), 3000, 'server received the edit');
      const put = await putRules([{ pattern: 'notes.md', access: 'r' }]);
      expect(put.status).toBe(200);
      expect(
        fs.readFileSync(path.join(current.root, 'notes.md'), 'utf8'),
        'the pending edit is saved before the rule applies',
      ).toContain('first-');

      editor.text.insert(0, 'second-');
      await waitFor(() => editor.metas.some((meta) => meta.type === 'denied'), 5000, 'denied');
      await sleep(300);
      expect(fs.readFileSync(path.join(current.root, 'notes.md'), 'utf8')).not.toContain('second-');
    });

    it('holds frames during a rule change and replays them when access is unchanged', async () => {
      current = await startTestServer({
        files: { 'other.md': 'base\n', 'notes.md': 'base\n' },
        tokens: { owner: OWNER, editor: EDITOR },
      });
      const editor = await connectDoc(current, 'other.md', EDITOR);
      const observer = await connectDoc(current, 'other.md', OWNER);
      await waitFor(
        () => editor.text.toString() === 'base\n' && observer.text.toString() === 'base\n',
        3000,
        'initial content',
      );

      const barrier = holdFlush(openDocSession(current, 'other.md'));
      try {
        const put = putRules([{ pattern: 'notes.md', access: 'r' }]);
        expect(
          await barrier.entered,
          'applyPolicy must flush open documents before installing the new rules',
        ).toBe(true);
        editor.text.insert(0, 'queued-');
        await sleep(100);
        expect(observer.text.toString(), 'frames are held, not applied, during the swap').toBe('base\n');
        barrier.release();
        expect((await put).status).toBe(200);
      } finally {
        barrier.release();
        barrier.restore();
      }

      await waitFor(() => observer.text.toString().includes('queued-'), 5000, 'replayed frame');
      await waitFor(
        () => fs.readFileSync(path.join(current!.root, 'other.md'), 'utf8').includes('queued-'),
        5000,
        'saved',
      );
      expect(
        editor.metas.filter((meta) => meta.type === 'denied'),
        'a frame for an unaffected file is never denied',
      ).toEqual([]);
      expect(observer.metas.filter((meta) => meta.type === 'denied')).toEqual([]);
      expect(observer.text.toString(), 'the replayed edit reaches the second client').toContain('queued-');
      expect(
        fs.readFileSync(path.join(current.root, 'other.md'), 'utf8'),
        'the replayed edit reaches disk',
      ).toContain('queued-');
    });

    it('drops an affected frame replayed after a downgrade and keeps the pre-change save', async () => {
      current = await startTestServer({
        files: { 'notes.md': 'base\n' },
        tokens: { owner: OWNER, editor: EDITOR },
      });
      const editor = await connectDoc(current, 'notes.md', EDITOR);
      const observer = await connectDoc(current, 'notes.md', OWNER);
      await waitFor(() => editor.text.toString() === 'base\n', 3000, 'initial content');

      editor.text.insert(0, 'kept-');
      await waitFor(
        () => fs.readFileSync(path.join(current!.root, 'notes.md'), 'utf8').includes('kept-'),
        5000,
        'first save',
      );

      const barrier = holdFlush(openDocSession(current, 'notes.md'));
      try {
        const put = putRules([{ pattern: 'notes.md', access: 'r' }]);
        expect(await barrier.entered, 'applyPolicy flushes before installing rules').toBe(true);
        editor.text.insert(0, 'dropped-');
        await sleep(100);
        barrier.release();
        expect((await put).status).toBe(200);
      } finally {
        barrier.release();
        barrier.restore();
      }

      await waitFor(() => editor.metas.some((meta) => meta.type === 'denied'), 5000, 'denied after replay');
      await sleep(200);
      expect(
        editor.metas.filter((meta) => meta.type === 'denied').length,
        'the replayed frame is denied',
      ).toBeGreaterThan(0);
      expect(observer.text.toString(), 'the pre-change edit still reached the second client').toContain('kept-');
      const disk = fs.readFileSync(path.join(current.root, 'notes.md'), 'utf8');
      expect(disk).toContain('kept-');
      expect(disk, 'a frame the new access forbids never reaches disk').not.toContain('dropped-');
      expect(observer.text.toString()).not.toContain('dropped-');
    });
  });
});
