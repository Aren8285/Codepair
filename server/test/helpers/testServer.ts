import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, type ServerConfig } from '../../src/config.js';
import { createCodepairServer, type CodepairServer } from '../../src/server.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export interface TestServer {
  server: CodepairServer;
  config: ServerConfig;
  root: string;
  base: string;
  wsUrl: string;
  token: string;
  cleanup: () => Promise<void>;
}

export async function startTestServer(
  options: {
    files?: Record<string, string>;
    args?: string[];
    env?: Record<string, string>;
    root?: string;
  } = {},
): Promise<TestServer> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-test-'));
  const root = options.root ?? path.join(base, 'project');
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  const config = parseConfig(
    ['--root', root, ...(options.args ?? [])],
    {
      CODE_PAIR_TOKEN: TEST_TOKEN,
      CODE_PAIR_SAVE_DEBOUNCE_MS: '20',
      CODE_PAIR_TERMINAL: 'off',
      CODE_PAIR_MAX_FILE_BYTES: '1048576',
      ...(options.env ?? {}),
    },
    root,
  );

  const server = await createCodepairServer(config);
  const { port } = await server.start(0, '127.0.0.1');

  return {
    server,
    config,
    root: server.guard.root,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws/doc`,
    token: TEST_TOKEN,
    cleanup: async () => {
      await server.close();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(
  probe: () => T | undefined | false,
  timeoutMs = 5000,
  label = 'condition',
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
