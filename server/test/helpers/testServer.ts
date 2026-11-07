import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, type ServerConfig } from '../../src/config.js';
import { createCodepairServer, type CodepairServer } from '../../src/server.js';
import type { Authenticator } from '../../src/security/auth.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export type TestRole = 'owner' | 'editor' | 'viewer';

export interface TestTokens {
  owner: string;
  editor?: string;
  viewer?: string;
}

export interface TestServer {
  server: CodepairServer;
  config: ServerConfig;
  root: string;
  base: string;
  wsUrl: string;
  token: string;
  tokens: TestTokens;
  /** Authenticated request using the token configured for that role. */
  requestAs: (role: TestRole, route: string, init?: RequestInit) => Promise<Response>;
  cleanup: () => Promise<void>;
}

export async function startTestServer(
  options: {
    files?: Record<string, string>;
    args?: string[];
    env?: Record<string, string>;
    root?: string;
    /** Extra role tokens. `owner` overrides the default token when supplied. */
    tokens?: Partial<TestTokens>;
    /**
     * Test seam: replace the token→principal lookup. Used to drive the gates
     * with a principal no role can produce (for example an empty capability set).
     */
    authOverride?: Authenticator;
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

  const tokens: TestTokens = {
    owner: options.tokens?.owner ?? TEST_TOKEN,
    editor: options.tokens?.editor,
    viewer: options.tokens?.viewer,
  };

  const config = parseConfig(
    [
      '--root',
      root,
      ...(options.args ?? []),
      ...(options.tokens?.owner ? ['--token', tokens.owner] : []),
      ...(tokens.editor ? ['--editor-token', tokens.editor] : []),
      ...(tokens.viewer ? ['--viewer-token', tokens.viewer] : []),
    ],
    {
      CODE_PAIR_TOKEN: tokens.owner,
      CODE_PAIR_SAVE_DEBOUNCE_MS: '20',
      CODE_PAIR_TERMINAL: 'off',
      CODE_PAIR_MAX_FILE_BYTES: '1048576',
      ...(options.env ?? {}),
    },
    root,
  );

  const server = await createCodepairServer(
    config,
    options.authOverride ? { authenticate: options.authOverride } : undefined,
  );
  const { port } = await server.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    config,
    root: server.guard.root,
    base: baseUrl,
    wsUrl: `ws://127.0.0.1:${port}/ws/doc`,
    token: tokens.owner,
    tokens,
    requestAs: (role: TestRole, route: string, init: RequestInit = {}) => {
      const token = tokens[role];
      if (!token) throw new Error(`No ${role} token is configured on this test server.`);
      const headers = new Headers(init.headers);
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
      return fetch(`${baseUrl}${route}`, { ...init, headers });
    },
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
