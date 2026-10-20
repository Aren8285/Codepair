import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import WebSocket from 'ws';
import { startTestServer, type TestServer } from './helpers/testServer.js';

let current: TestServer | undefined;

afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

interface TerminalResult {
  closeCode?: number;
  closeReason?: string;
  output: string;
  opened: boolean;
}

/** Open /ws/terminal and collect everything until the socket closes. */
function runTerminal(ctx: TestServer, token: string): Promise<TerminalResult> {
  const url = ctx.wsUrl.replace('/ws/doc', '/ws/terminal');
  return new Promise((resolve) => {
    const result: TerminalResult = { output: '', opened: false };
    const socket = new WebSocket(url, ['codepair', token]);
    const timer = setTimeout(() => {
      socket.close();
    }, 4000);

    socket.on('open', () => {
      result.opened = true;
    });
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(String(data)) as { type?: string; data?: string };
        if (message.type === 'output' && typeof message.data === 'string') result.output += message.data;
      } catch {
        // ignore non-JSON frames
      }
    });
    socket.on('close', (code, reason) => {
      clearTimeout(timer);
      result.closeCode = code;
      result.closeReason = String(reason);
      resolve(result);
    });
    socket.on('error', () => {
      // The close event carries the outcome.
    });
  });
}

describe('terminal authorization', () => {
  it('rejects the terminal in read-only mode', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      args: ['--mode', 'read-only'],
      env: { CODE_PAIR_TERMINAL: 'on' },
    });

    const result = await runTerminal(current, current.token);

    // The upgrade succeeds (the token is valid) but no shell is ever created:
    // the session is closed before any output can arrive.
    expect(result.closeCode).toBe(4403);
    expect(result.closeReason).toMatch(/read-only/i);
    expect(result.output).toBe('');
  });

  it('rejects the terminal when the Host opted out', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      args: ['--no-terminal'],
    });

    const result = await runTerminal(current, current.token);

    expect(result.closeCode).toBe(4403);
    expect(result.closeReason).toMatch(/disabled/i);
  });

  it('refuses an unauthenticated terminal upgrade at the HTTP level', async () => {
    current = await startTestServer({ files: { 'a.txt': 'x\n' }, env: { CODE_PAIR_TERMINAL: 'on' } });
    const port = Number(new URL(current.wsUrl).port);

    const status = await new Promise<number>((resolve, reject) => {
      const request = [
        'GET /ws/terminal HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: codepair, wrong-token-0123456789abcdef',
        '\r\n',
      ].join('\r\n');
      const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('no response'));
      }, 4000);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
      });
      socket.on('close', () => {
        clearTimeout(timer);
        resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1] ?? 0));
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    // Never a 101: no WebSocket is established, so no shell is exposed.
    expect(status).toBe(401);
  });

  it('runs a real PTY when the terminal is enabled', async () => {
    current = await startTestServer({
      files: { 'a.txt': 'x\n' },
      env: { CODE_PAIR_TERMINAL: 'on' },
    });

    const url = current.wsUrl.replace('/ws/doc', '/ws/terminal');
    const socket = new WebSocket(url, ['codepair', current.token]);
    let output = '';
    let ready = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PTY did not respond')), 8000);
      socket.on('open', () => {
        socket.send(JSON.stringify({ type: 'input', data: 'echo codepair-pty-ok\r' }));
      });
      socket.on('message', (data) => {
        try {
          const message = JSON.parse(String(data)) as { type?: string; data?: string };
          if (message.type === 'ready') ready = true;
          if (message.type === 'output' && typeof message.data === 'string') output += message.data;
          if (/codepair-pty-ok/.test(output)) {
            clearTimeout(timer);
            socket.close();
            resolve();
          }
        } catch {
          // ignore
        }
      });
      socket.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(ready).toBe(true);
    expect(output).toMatch(/codepair-pty-ok/);
  });
});
