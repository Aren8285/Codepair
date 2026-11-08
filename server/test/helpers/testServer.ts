import fs from 'node:fs';
import http from 'node:http';
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
  /** Actual loopback-only admin origin, e.g. `http://127.0.0.1:38291`. */
  adminBase: string;
  adminPort: number;
  adminToken: string;
  /** Authenticated request using the token configured for that role. */
  requestAs: (role: TestRole, route: string, init?: RequestInit) => Promise<Response>;
  /**
   * Admin request with the admin token attached by default. Uses `node:http`
   * rather than fetch so a test can override the `Host` header (undici owns it).
   */
  requestAdmin: (route: string, init?: RequestInit) => Promise<Response>;
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
    /** Interface the guest listener binds to. Defaults to loopback. */
    bindHost?: string;
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
      '--port',
      '0',
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
  const { port, adminPort } = await server.start(0, options.bindHost ?? '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminBase = `http://127.0.0.1:${adminPort}`;
  const adminToken = server.admin.token;

  return {
    server,
    config,
    root: server.guard.root,
    base: baseUrl,
    wsUrl: `ws://127.0.0.1:${port}/ws/doc`,
    token: tokens.owner,
    tokens,
    adminBase,
    adminPort,
    adminToken,
    requestAs: (role: TestRole, route: string, init: RequestInit = {}) => {
      const token = tokens[role];
      if (!token) throw new Error(`No ${role} token is configured on this test server.`);
      const headers = new Headers(init.headers);
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
      return fetch(`${baseUrl}${route}`, { ...init, headers });
    },
    requestAdmin: (route: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${adminToken}`);
      const flat: Record<string, string> = {};
      headers.forEach((value, key) => {
        flat[key] = value;
      });
      const target = new URL(route, adminBase);
      return new Promise<Response>((resolve, reject) => {
        const request = http.request(
          {
            hostname: '127.0.0.1',
            port: adminPort,
            path: `${target.pathname}${target.search}`,
            method: init.method ?? 'GET',
            headers: flat,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              const responseHeaders: Record<string, string> = {};
              for (const [key, value] of Object.entries(response.headers)) {
                if (typeof value === 'string') responseHeaders[key] = value;
                else if (Array.isArray(value)) responseHeaders[key] = value.join(', ');
              }
              resolve(new Response(text, { status: response.statusCode ?? 0, headers: responseHeaders }));
            });
          },
        );
        request.on('error', reject);
        if (typeof init.body === 'string') request.write(init.body);
        request.end();
      });
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
