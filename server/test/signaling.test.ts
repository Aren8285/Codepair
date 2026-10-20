import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, waitFor, type TestServer } from './helpers/testServer.js';

let current: TestServer | undefined;
const peers: SignalPeer[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await current?.cleanup();
  current = undefined;
});

interface Waiter {
  predicate: (message: Record<string, unknown>) => boolean;
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class SignalPeer {
  readonly messages: Array<Record<string, unknown>> = [];
  private waiters: Waiter[] = [];
  closedCode: number | undefined;

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index !== -1) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(message);
        return;
      }
      this.messages.push(message);
    });
    socket.on('close', (code) => {
      this.closedCode = code;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`socket closed (${code}) while waiting for a message`));
      }
    });
    socket.on('error', () => undefined);
  }

  static async connect(ctx: TestServer, room = ctx.config.roomId): Promise<SignalPeer> {
    const socket = new WebSocket(
      `${ctx.base.replace('http://', 'ws://')}/ws/signal?room=${encodeURIComponent(room)}`,
      ['codepair', ctx.token],
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('unexpected-response', (_request, response) => reject(new Error(`upgrade rejected: ${response.statusCode}`)));
    });
    const peer = new SignalPeer(socket);
    peers.push(peer);
    return peer;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  next(predicate: (message: Record<string, unknown>) => boolean = () => true, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const index = this.messages.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error('Timed out waiting for a signalling message.'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  seen(predicate: (message: Record<string, unknown>) => boolean): boolean {
    return this.messages.some(predicate);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      this.socket.terminate();
    }
  }
}

async function connectAndJoin(
  ctx: TestServer,
  name = 'Tester',
  color = '#3366ff',
): Promise<{ peer: SignalPeer; self: { id: string; name: string; color: string } }> {
  const peer = await SignalPeer.connect(ctx);
  peer.send({ type: 'join', name, color });
  const joined = (await peer.next((message) => message.type === 'joined')) as {
    self: { id: string; name: string; color: string };
  };
  return { peer, self: joined.self };
}

describe('WebRTC signalling', () => {
  it('rejects upgrades for a different room and for missing tokens', async () => {
    current = await startTestServer();

    const wrongRoom = new WebSocket(
      `${current.base.replace('http://', 'ws://')}/ws/signal?room=other-room`,
      ['codepair', current.token],
    );
    const status = await new Promise<number | undefined>((resolve) => {
      wrongRoom.on('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      wrongRoom.on('error', () => resolve(undefined));
    });
    expect(status).toBe(404);

    const noToken = new WebSocket(`${current.base.replace('http://', 'ws://')}/ws/signal?room=${current.config.roomId}`);
    const unauthorized = await new Promise<number | undefined>((resolve) => {
      noToken.on('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      noToken.on('error', () => resolve(undefined));
    });
    expect(unauthorized).toBe(401);
  });

  it('publishes room membership and relays signals only to the target peer', async () => {
    current = await startTestServer();
    const alice = await connectAndJoin(current, 'Alice', '#112233');
    const bob = await connectAndJoin(current, 'Bob', '#445566');
    const carol = await connectAndJoin(current, 'Carol', '#778899');

    const joinedNotice = await alice.peer.next((message) => message.type === 'peer-joined');
    expect((joinedNotice.peer as { name: string }).name).toBe('Bob');

    alice.peer.send({ type: 'signal', to: bob.self.id, data: { kind: 'offer', sdp: 'v=0 offer' } });
    const offer = await bob.peer.next((message) => message.type === 'signal');
    expect(offer.from).toBe(alice.self.id);
    expect((offer.data as { kind: string }).kind).toBe('offer');

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(carol.peer.seen((message) => message.type === 'signal')).toBe(false);

    bob.peer.send({
      type: 'signal',
      to: alice.self.id,
      data: { kind: 'candidate', candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    const candidate = await alice.peer.next((message) => message.type === 'signal');
    expect((candidate.data as { kind: string }).kind).toBe('candidate');
  });

  it('sanitises display names and colours', async () => {
    current = await startTestServer();
    const peer = await SignalPeer.connect(current);
    peer.send({ type: 'join', name: '  Ana\u0000\u001b[31m  ', color: 'javascript:alert(1)' });
    const joined = (await peer.next((message) => message.type === 'joined')) as {
      self: { name: string; color: string };
    };
    expect(joined.self.name).toBe('Ana[31m');
    expect(joined.self.color).toBe('#7c8cf8');
  });

  it('rejects unknown targets, invalid payloads and messages sent before join', async () => {
    current = await startTestServer();
    const { peer } = await connectAndJoin(current);

    peer.send({ type: 'signal', to: 'not-a-peer', data: { kind: 'offer', sdp: 'v=0' } });
    const unknown = await peer.next((message) => message.type === 'error');
    expect(unknown.code).toBe('UNKNOWN_PEER');

    peer.send({ type: 'signal', to: 'not-a-peer', data: { kind: 'exfiltrate', sdp: 'x' } });
    const bad = await peer.next((message) => message.type === 'error');
    expect(bad.code).toBe('BAD_SIGNAL');

    peer.send({ type: 'signal', to: 'not-a-peer', data: { kind: 'offer', sdp: 'x'.repeat(100_001) } });
    const tooLarge = await peer.next((message) => message.type === 'error');
    expect(tooLarge.code).toBe('BAD_SIGNAL');

    const early = await SignalPeer.connect(current);
    early.send({ type: 'signal', to: 'x', data: { kind: 'offer', sdp: 'v=0' } });
    await waitFor(() => early.closedCode !== undefined, 3000, 'early close');
    expect(early.closedCode).toBe(4402);
  });

  it('closes binary frames and announces departures to the room', async () => {
    current = await startTestServer();
    const alice = await connectAndJoin(current);
    const bob = await connectAndJoin(current);

    bob.peer.send({ type: 'leave' });
    const left = await alice.peer.next((message) => message.type === 'peer-left');
    expect(left.id).toBe(bob.self.id);

    const binary = await connectAndJoin(current);
    binary.peer.socket.send(Buffer.from([0, 1, 2]));
    await waitFor(() => binary.peer.closedCode !== undefined, 3000, 'binary close');
    expect(binary.peer.closedCode).toBe(4401);
  });
});
