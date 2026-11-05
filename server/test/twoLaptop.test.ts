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

/** Repro for the "two laptops see shifted/duplicated lines" report. */
describe('two laptops on one file', () => {
  it('converges when both type while one reconnects mid-typing (repeated bursts)', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).concat(['']);
    current = await startTestServer({ files: { 'notes.txt': lines.join('\n') } });

    const laptopA = await connect(current, 'notes.txt');
    const laptopB = await connect(current, 'notes.txt');

    const burst = (client: TestDocClient, tag: string, round: number): void => {
      // type on a fixed line region from both sides, like two humans on the same area
      const offset = client.text.toString().indexOf('line 17');
      client.text.insert(offset < 0 ? client.text.length : offset, `[${tag} r${round}] `);
      client.text.insert(client.text.length, `\n${tag}-tail-${round}`);
    };

    for (let round = 0; round < 8; round++) {
      burst(laptopA, 'A', round);
      // laptop B briefly loses connection exactly while typing the same region
      if (round === 3) laptopB.closeSocket();
      burst(laptopB, 'B', round);
      if (round === 3) await laptopB.reconnect();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    await waitFor(
      () => laptopA.text.toString() === laptopB.text.toString(),
      8000,
      'both laptops converge',
    );
    const merged = laptopA.text.toString();

    // no duplicated lines: every tagged edit appears exactly once
    for (let round = 0; round < 8; round++) {
      expect(merged.split(`[A r${round}] `).length - 1).toBe(1);
      expect(merged.split(`[B r${round}] `).length - 1).toBe(1);
    }

    await waitFor(
      () => fs.readFileSync(path.join(current!.root, 'notes.txt'), 'utf8') === merged,
      8000,
      'disk matches converged doc',
    );
  });

  it('converges when a laptop reconnects while the other is still typing over the same region', async () => {
    current = await startTestServer({
      files: { 'notes.txt': Array.from({ length: 25 }, (_, i) => `l${i + 1}`).join('\n') + '\n' },
    });
    const laptopA = await connect(current, 'notes.txt');
    const laptopB = await connect(current, 'notes.txt');
    await waitFor(() => laptopB.text.toString() === laptopA.text.toString(), 3000, 'initial equal');

    // B goes offline and keeps a local doc alive
    laptopB.closeSocket();

    // A types continuously
    const typing = setInterval(() => {
      const offset = laptopA.text.toString().indexOf('l17');
      laptopA.text.insert(offset < 0 ? laptopA.text.length : offset, `a${Math.floor(Math.random() * 90)} `);
    }, 15);

    // B types offline around the same region
    const offset = laptopB.text.toString().indexOf('l17');
    laptopB.text.insert(offset < 0 ? laptopB.text.length : offset, 'b-offline ');
    laptopB.text.delete(0, 2); // edits near the head region too

    // B reconnects mid-A-typing
    await new Promise((resolve) => setTimeout(resolve, 120));
    await laptopB.reconnect();
    clearInterval(typing);

    await waitFor(() => laptopA.text.toString() === laptopB.text.toString(), 8000, 'converge after reconnect');

    // the offline edit is present exactly once
    const merged = laptopA.text.toString();
    expect(merged.split('b-offline ').length - 1).toBe(1);

    await waitFor(
      () => fs.readFileSync(path.join(current!.root, 'notes.txt'), 'utf8') === merged,
      8000,
      'disk final',
    );
  });
});
