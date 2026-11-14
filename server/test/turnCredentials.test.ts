import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBanner } from '../src/banner.js';
import { ConfigError, parseConfig, type IceServerConfig } from '../src/config.js';
import { createCodepairServer } from '../src/server.js';
import { mintTurnCredential } from '../src/webrtc/turnCredentials.js';
import { startTestServer, TEST_TOKEN, type TestServer } from './helpers/testServer.js';

const SECRET = 'test-turn-secret-0123456789';
// Independently computed with:
// printf '1700000060:test-label' | openssl dgst -sha1 -hmac 'test-turn-secret-0123456789' -binary | base64
const FIXED_CREDENTIAL = 'kC4mUTSwN1tp/2+GMpkVnvOiKsI=';
const TURN_URLS = ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'];

let current: TestServer | undefined;

afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

interface SessionBody {
  rtc: { iceServers: IceServerConfig[] };
}

async function sessionBody(ctx: TestServer, token = ctx.token): Promise<SessionBody> {
  const response = await fetch(`${ctx.base}/api/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SessionBody;
}

function turnEntry(servers: IceServerConfig[]): IceServerConfig | undefined {
  return servers.find(
    (server) =>
      Array.isArray(server.urls) &&
      server.urls.includes(TURN_URLS[0]!) &&
      server.urls.includes(TURN_URLS[1]!),
  );
}

function turnEnv(secret = SECRET): Record<string, string> {
  return {
    CODE_PAIR_TURN_SECRET: secret,
    CODE_PAIR_TURN_URLS: TURN_URLS.join(','),
  };
}

/** Collect the first sync frame(s) from a websocket, then close it. */
function collectWebSocket(ctx: TestServer, route: string): Promise<string> {
  return new Promise((resolve) => {
    const frames: string[] = [];
    const socket = new WebSocket(`${ctx.wsBase}${route}`, ['codepair', ctx.token]);
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(frames.join('\n'));
    };
    const timer = setTimeout(finish, 200);
    socket.on('message', (data) => frames.push(String(data)));
    socket.on('error', finish);
    socket.on('close', finish);
  });
}

describe('TURN credential minting', () => {
  it('matches coturn REST credentials against a hand-computed HMAC value', () => {
    const result = mintTurnCredential(SECRET, 60, () => 1_700_000_000_000, 'test-label');

    expect(result).toEqual({
      username: '1700000060:test-label',
      credential: FIXED_CREDENTIAL,
      ttl: 60,
    });
  });

  it('computes expiry as now + ttl with an injectable clock', () => {
    const early = mintTurnCredential(SECRET, 60, () => 0, 'same-label');
    const later = mintTurnCredential(SECRET, 60, () => 61_000, 'same-label');

    expect(early.username).toBe('60:same-label');
    expect(later.username).toBe('121:same-label');
    // Expiry enforcement belongs to coturn; this daemon only stamps the expiry
    // and signs it. The test proves the stamp follows the injected clock.
    expect(later.username).not.toBe(early.username);
  });

  it('uses a 3600-second default TTL', () => {
    const result = mintTurnCredential(SECRET, undefined, () => 0, 'default-label');

    expect(result.ttl).toBe(3600);
    expect(result.username).toBe('3600:default-label');
  });
});

describe('TURN configuration and /api/session', () => {
  it('leaves the default STUN-only iceServers exactly unchanged without a secret', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' } });

    const session = await sessionBody(current);

    expect(session.rtc.iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('adds a fresh minted TURN entry for each session request', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, env: turnEnv() });

    const first = turnEntry((await sessionBody(current)).rtc.iceServers);
    const second = turnEntry((await sessionBody(current)).rtc.iceServers);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.urls).toEqual(TURN_URLS);
    expect(first?.username).toMatch(/^\d+:[A-Za-z0-9_-]+$/);
    expect(first?.credential).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(second?.username).not.toBe(first?.username);
    expect(second?.credential).not.toBe(first?.credential);
  });

  it('keeps hand-supplied --ice-servers and adds the minted TURN entry', async () => {
    const manual: IceServerConfig = {
      urls: ['stun:manual.example.com:3478'],
      username: 'manual-user',
      credential: 'manual-credential',
    };
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      env: {
        ...turnEnv(),
        CODE_PAIR_ICE_SERVERS: JSON.stringify([manual]),
      },
    });

    const servers = (await sessionBody(current)).rtc.iceServers;

    expect(servers).toContainEqual(manual);
    expect(turnEntry(servers)).toBeDefined();
  });

  it('never exposes the raw TURN secret in HTTP/WS responses, headers, console output or the banner', async () => {
    const marker = 'TURN_SECRET_MARKER_7d2f9c';
    const captured: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const spies = [
      stdout,
      stderr,
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      }),
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      }),
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      }),
    ];
    const bodies: string[] = [];

    try {
      current = await startTestServer({ files: { 'a.txt': 'x\n' }, env: turnEnv(marker) });

      const session = await sessionBody(current);
      bodies.push(JSON.stringify(session));
      expect(turnEntry(session.rtc.iceServers), 'the minted entry must exist for this check to mean anything').toBeDefined();

      for (const route of ['/admin/api/state', '/admin/api/tokens', '/admin/api/lobby', '/admin/api/policy']) {
        const response = await current.requestAdmin(route);
        bodies.push(response.headers.toString());
        bodies.push(await response.text());
      }

      const anonymous = await fetch(`${current.base}/api/session`);
      bodies.push(anonymous.headers.toString());
      bodies.push(await anonymous.text());

      bodies.push(await collectWebSocket(current, '/ws/doc?path=a.txt'));
      bodies.push(
        await collectWebSocket(
          current,
          `/ws/signal?room=${encodeURIComponent(current.config.roomId)}`,
        ),
      );

      const config = parseConfig(
        ['--root', current.root, '--token', TEST_TOKEN, '--turn-secret', marker, '--turn-urls', TURN_URLS.join(',')],
        {},
      );
      bodies.push(
        buildBanner(config, {
          root: current.root,
          port: 7420,
          adminPort: 7421,
          adminToken: current.adminToken,
        }),
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(captured.join('\n')).not.toContain(marker);
    expect(bodies.join('\n')).not.toContain(marker);
  });

  it('parses the TURN TTL flag', () => {
    const config = parseConfig(
      [
        '--root',
        '/tmp',
        '--token',
        TEST_TOKEN,
        '--turn-secret',
        SECRET,
        '--turn-urls',
        TURN_URLS.join(','),
        '--turn-credential-ttl',
        '90',
      ],
      {},
    );

    expect(config.turnCredentialTtl).toBe(90);
    expect(config.turnUrls).toEqual(TURN_URLS);
  });

  it('fails loudly at config parsing and server construction when a secret lacks usable URLs', async () => {
    const missing = (): void => {
      parseConfig(['--root', '/tmp', '--token', TEST_TOKEN, '--turn-secret', SECRET], {});
    };
    const malformed = (): void => {
      parseConfig(
        ['--root', '/tmp', '--token', TEST_TOKEN, '--turn-secret', SECRET, '--turn-urls', 'not-a-turn-url'],
        {},
      );
    };

    expect(missing).toThrow(ConfigError);
    expect(malformed).toThrow(ConfigError);
    try {
      missing();
    } catch (error) {
      expect(String(error instanceof Error ? error.message : error)).not.toContain(SECRET);
    }

    // A caller that builds ServerConfig directly cannot bypass the startup check.
    const direct = parseConfig(
      ['--root', '/tmp', '--token', TEST_TOKEN, '--turn-secret', SECRET, '--turn-urls', TURN_URLS.join(',')],
      {},
    );
    direct.turnUrls = [];
    await expect(createCodepairServer(direct)).rejects.toThrow(ConfigError);
  });

  it('rejects an out-of-range TURN TTL at startup', () => {
    const base = ['--root', '/tmp', '--token', TEST_TOKEN];

    expect(() => parseConfig([...base, '--turn-credential-ttl', '0'], {})).toThrow(ConfigError);
    expect(() => parseConfig([...base, '--turn-credential-ttl', '86401'], {})).toThrow(ConfigError);
    expect(() => parseConfig([...base, '--turn-credential-ttl', 'nope'], {})).toThrow(ConfigError);
  });
});
