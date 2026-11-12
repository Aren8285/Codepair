import { afterEach, describe, expect, it } from 'vitest';
import type { IPty } from 'node-pty';
import WebSocket from 'ws';
import type { Authenticator } from '../src/security/auth.js';
import { makePrincipal } from '../src/security/principal.js';
import type { TerminalSpawn } from '../src/terminal/terminalService.js';
import { TEST_TOKEN, startTestServer, type TestServer } from './helpers/testServer.js';

let current: TestServer | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await current?.cleanup();
  current = undefined;
});

const CANDIDATE = TEST_TOKEN;

function candidateAuthenticator(): Authenticator {
  const principal = makePrincipal('candidate');
  return (token) => (token === CANDIDATE ? principal : null);
}

function fakePty(): IPty {
  const disposable = { dispose() {} };
  return {
    pid: 4242,
    process: 'docker',
    onData: () => disposable,
    onExit: () => disposable,
    on: () => disposable,
    write: () => {},
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    clear: () => {},
  } as unknown as IPty;
}

interface TerminalObservation {
  opened: boolean;
  ready: boolean;
  output: string;
  closeCode?: number;
  closeReason?: string;
  timedOut: boolean;
}

/**
 * Open /ws/terminal, collect frames until `ready` or close, then close the
 * socket. A sandbox spawn stub never emits data, so `ready` is the signal that
 * the terminal path was reached without relying on a shell prompt.
 */
function observeTerminal(ctx: TestServer, token: string): Promise<TerminalObservation> {
  const url = ctx.wsUrl.replace('/ws/doc', '/ws/terminal');
  return new Promise((resolve) => {
    const result: TerminalObservation = { opened: false, ready: false, output: '', timedOut: false };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      finish();
    }, 2500);
    const socket = new WebSocket(url, ['codepair', token]);
    sockets.push(socket);
    socket.on('open', () => {
      result.opened = true;
    });
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(String(data)) as { type?: string; data?: string };
        if (message.type === 'ready') {
          result.ready = true;
          // The real terminal stays open; close it after recording the outcome.
          setTimeout(() => {
            try {
              socket.close();
            } catch {
              // Already closed.
            }
          }, 30);
        }
        if (message.type === 'output' && typeof message.data === 'string') result.output += message.data;
      } catch {
        // ignore non-JSON frames
      }
    });
    socket.on('close', (code, reason) => {
      result.closeCode = code;
      result.closeReason = String(reason);
      finish();
    });
    socket.on('error', () => {
      // The close event carries the outcome.
    });
  });
}

// Non-candidate terminal behavior stays covered by the unchanged
// terminal.test.ts suite; these tests exercise only the candidate branch.
describe('candidate interview terminal sandbox', () => {
  it('passes the real sandbox flags when Docker is available', async () => {
    const sandboxCalls: Array<{ file: string; args: string[] }> = [];
    let hostCalls = 0;

    const sandboxSpawn = ((file: string, args: string[]) => {
      sandboxCalls.push({ file, args });
      return fakePty();
    }) as unknown as TerminalSpawn;

    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      authOverride: candidateAuthenticator(),
      env: { CODE_PAIR_TERMINAL: 'on' },
      args: ['--interview-sandbox', '--interview-sandbox-image', 'codepair-sandbox-test'],
      sandboxProbe: async () => ({ available: true, image: 'codepair-sandbox-test' }),
      sandboxSpawn,
      terminalSpawn: (() => {
        hostCalls += 1;
        throw new Error('the host PTY must never be used for a candidate');
      }) as unknown as TerminalSpawn,
    });

    const result = await observeTerminal(current, CANDIDATE);
    expect(result.ready, 'a candidate should receive a sandboxed terminal').toBe(true);
    expect(result.opened).toBe(true);

    expect(sandboxCalls, 'exactly one Docker process is spawned').toHaveLength(1);
    expect(sandboxCalls[0]?.file).toBe('docker');
    const args = sandboxCalls[0]?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        'run',
        '--rm',
        '--network',
        'none',
        '--cpus',
        '1',
        '--memory',
        '512m',
        '--pids-limit',
        '128',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--workdir',
        '/workspace',
        'codepair-sandbox-test',
        '--volume',
        `${current.root}:/workspace:ro`,
        '--volume',
        `${current.root}/solution:/workspace/solution:rw`,
      ]),
    );
    expect(args.join(' ')).toMatch(/--user\s+(?!0(?::|\s|$))/);
    expect(args).not.toContain('--privileged');
    expect(hostCalls, 'the host PTY is never touched').toBe(0);
  });

  it('fails closed with 4403 and zero host PTY spawns when Docker is unavailable', async () => {
    let hostCalls = 0;
    let sandboxCalls = 0;

    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      authOverride: candidateAuthenticator(),
      env: { CODE_PAIR_TERMINAL: 'on' },
      args: ['--interview-sandbox'],
      sandboxProbe: async () => ({
        available: false,
        image: 'node:22-bookworm-slim',
        reason: 'docker is not installed',
      }),
      sandboxSpawn: (() => {
        sandboxCalls += 1;
        throw new Error('no Docker process may be spawned when the sandbox is unavailable');
      }) as unknown as TerminalSpawn,
      terminalSpawn: (() => {
        hostCalls += 1;
        throw new Error('the host PTY must never be a fallback for a candidate');
      }) as unknown as TerminalSpawn,
    });

    const result = await observeTerminal(current, CANDIDATE);
    expect(result.ready, 'no terminal may open without a working sandbox').toBe(false);
    expect(result.closeCode).toBe(4403);
    expect(result.closeReason).toMatch(/sandbox/i);
    expect(result.closeReason).not.toMatch(/read-only/i);
    expect(result.output).toBe('');
    expect(hostCalls, 'a candidate terminal must never fall back to the host shell').toBe(0);
    expect(sandboxCalls, 'no Docker process is attempted when unavailable').toBe(0);
  });

});
