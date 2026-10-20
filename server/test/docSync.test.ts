import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, waitFor, type TestServer } from './helpers/testServer.js';
import { TestDocClient } from './helpers/docClient.js';

let current: TestServer | undefined;
const clients: TestDocClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await current?.cleanup();
  current = undefined;
});

function connect(ctx: TestServer, file: string): Promise<TestDocClient> {
  return TestDocClient.connect({ wsUrl: ctx.wsUrl, token: ctx.token, path: file }).then((client) => {
    clients.push(client);
    return client;
  });
}

describe('Yjs collaboration', () => {
  it('converges concurrent edits without losing either side and persists them', async () => {
    current = await startTestServer({ files: { 'notes.md': 'hello\n' } });
    const first = await connect(current, 'notes.md');
    const second = await connect(current, 'notes.md');

    await waitFor(() => first.text.toString() === 'hello\n' && second.text.toString() === 'hello\n', 3000, 'initial sync');

    first.text.insert(0, 'A:');
    second.text.insert(second.text.length, 'B\n');

    await waitFor(
      () => first.text.toString() === second.text.toString() && first.text.toString().includes('A:') && first.text.toString().includes('B'),
      5000,
      'convergence',
    );
    await waitFor(
      () => fs.readFileSync(path.join(current!.root, 'notes.md'), 'utf8') === first.text.toString(),
      5000,
      'persistence',
    );
  });

  it('shares awareness state (names and colours) between clients', async () => {
    current = await startTestServer({ files: { 'presence.txt': '' } });
    const first = await connect(current, 'presence.txt');
    const second = await connect(current, 'presence.txt');

    first.setUser('Ada', '#ff8800');

    await waitFor(() => {
      const states = [...second.awareness.getStates().values()] as Array<{ user?: { name: string; color: string } }>;
      return states.some((state) => state.user?.name === 'Ada' && state.user.color === '#ff8800');
    }, 5000, 'remote awareness');
  });

  it('drops edits from read-only connections and explains why', async () => {
    current = await startTestServer({ files: { 'locked.md': 'original\n' }, args: ['--mode', 'read-only'] });
    const reader = await connect(current, 'locked.md');
    expect(reader.text.toString()).toBe('original\n');

    reader.text.insert(0, 'HACK ');

    await waitFor(
      () => reader.metas.some((meta) => meta.type === 'denied'),
      5000,
      'denied meta',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fs.readFileSync(path.join(current.root, 'locked.md'), 'utf8')).toBe('original\n');
  });

  it('pulls in edits made outside CodePair while the file is open', async () => {
    current = await startTestServer({ files: { 'outside.txt': 'from codepair\n' } });
    const client = await connect(current, 'outside.txt');
    await waitFor(() => client.text.toString() === 'from codepair\n', 3000, 'initial content');

    await fsp.writeFile(path.join(current.root, 'outside.txt'), 'from an external editor\n');

    await waitFor(
      () => client.text.toString() === 'from an external editor\n',
      6000,
      'external edit applied',
    );
    expect(client.metas.some((meta) => meta.type === 'external' && meta.conflict === false)).toBe(true);
  });

  it('keeps local edits and warns when the Host copy also changed', async () => {
    // A long save debounce keeps the local edit out of the file so the Host's
    // write genuinely collides with it, as it would during a slow save.
    current = await startTestServer({
      files: { 'clash.txt': 'base\n' },
      env: { CODE_PAIR_SAVE_DEBOUNCE_MS: '1500' },
    });
    const client = await connect(current, 'clash.txt');
    await waitFor(() => client.text.toString() === 'base\n', 3000, 'initial content');

    client.text.insert(client.text.length, 'local edit\n');
    await fsp.writeFile(path.join(current.root, 'clash.txt'), 'host edit\n');

    await waitFor(
      () => client.metas.some((meta) => meta.type === 'external' && meta.conflict === true),
      6000,
      'conflict notice',
    );
    expect(client.text.toString()).toContain('local edit');
  });

  it('synchronises edits made while disconnected after reconnecting', async () => {
    current = await startTestServer({ files: { 'offline.txt': 'base\n' } });
    const writer = await connect(current, 'offline.txt');

    writer.closeSocket();
    writer.text.insert(0, 'offline-');
    writer.text.insert(writer.text.length, 'tail\n');

    await writer.reconnect();

    const observer = await connect(current, 'offline.txt');
    await waitFor(
      () => observer.text.toString().includes('offline-base\ntail'),
      5000,
      'reconnected state',
    );
    await waitFor(
      () => fs.readFileSync(path.join(current!.root, 'offline.txt'), 'utf8').includes('offline-base'),
      5000,
      'persisted offline edit',
    );
  });
});
