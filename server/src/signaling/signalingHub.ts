import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

const WS_OPEN = 1;
const JOIN_DEADLINE_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_SDP_CHARS = 100_000;
const MAX_CANDIDATE_CHARS = 4_000;
const DEFAULT_MAX_PEERS = 32;
/** Sliding message budget: burst of 120, sustained 40/s — trickle ICE stays well under it. */
const RATE_BURST = 120;
const RATE_REFILL_PER_MS = 40 / 1000;

export interface SignalingHubOptions {
  /** The one room id this session accepts (from config). */
  room: string;
  maxPeers?: number;
  logger?: Pick<Console, 'error' | 'warn'>;
}

interface PeerInfo {
  id: string;
  name: string;
  color: string;
  mic: boolean;
  cam: boolean;
  screen: boolean;
}

interface PeerState {
  readonly socket: WebSocket;
  readonly peer: PeerInfo;
  alive: boolean;
  tokens: number;
  lastRefill: number;
}

type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | {
      kind: 'candidate';
      candidate: string | null;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
      usernameFragment?: string | null;
    }
  | { kind: 'bye' };

/**
 * WebRTC signalling relay.
 *
 * The session token (checked during the HTTP upgrade) authenticates the socket;
 * this hub then scopes every relay to the session's single room. Peer identities
 * are server-assigned — nothing about who you are or who you may talk to is taken
 * on trust from the client. Payloads are structurally validated and re-built field
 * by field, so arbitrary JSON never reaches another browser.
 */
export class SignalingHub {
  private readonly peers = new Map<string, PeerState>();
  private readonly room: string;
  private readonly maxPeers: number;
  private readonly logger: Pick<Console, 'error' | 'warn'>;
  private disposed = false;

  constructor(options: SignalingHubOptions) {
    this.room = options.room;
    this.maxPeers = options.maxPeers ?? DEFAULT_MAX_PEERS;
    this.logger = options.logger ?? console;
  }

  /** Validate the room at upgrade time so unauthenticated paths fail fast. */
  acceptsRoom(room: string | null): boolean {
    return room === this.room;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  handle(socket: WebSocket): void {
    if (this.disposed) {
      socket.close(1001, 'Server is shutting down.');
      return;
    }

    let peer: PeerState | undefined;
    let joined = false;

    const joinDeadline = setTimeout(() => {
      if (!joined) socket.close(4402, 'Join message required.');
    }, JOIN_DEADLINE_MS);
    joinDeadline.unref?.();

    const heartbeat = setInterval(() => {
      if (!peer) return;
      if (!peer.alive) {
        socket.terminate();
        return;
      }
      peer.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    socket.on('pong', () => {
      if (peer) peer.alive = true;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(4401, 'Binary frames are not accepted.');
        return;
      }
      // The budget starts once joined; before that the join deadline bounds
      // what an unauthenticated flood can cost.
      if (peer && !rateCheck(peer)) {
        socket.close(4429, 'Too many signalling messages.');
        return;
      }

      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        sendJson(socket, { type: 'error', code: 'BAD_JSON', message: 'Malformed JSON.' });
        return;
      }
      if (!isRecord(message) || typeof message.type !== 'string') {
        sendJson(socket, { type: 'error', code: 'BAD_MESSAGE', message: 'Expected a message object.' });
        return;
      }

      if (!joined) {
        if (message.type !== 'join') {
          socket.close(4402, 'Send a join message first.');
          return;
        }
        peer = this.join(socket, message);
        if (!peer) return;
        joined = true;
        clearTimeout(joinDeadline);
        return;
      }

      const currentPeer = peer;
      if (!currentPeer) {
        socket.close(4402, 'Join message required.');
        return;
      }

      switch (message.type) {
        case 'signal': {
          const targetId = typeof message.to === 'string' ? message.to : '';
          const data = sanitizeSignalData(message.data);
          if (!data) {
            sendJson(socket, { type: 'error', code: 'BAD_SIGNAL', message: 'Invalid signalling payload.' });
            return;
          }
          const target = targetId ? this.peers.get(targetId) : undefined;
          if (!target || target.peer.id === currentPeer.peer.id) {
            sendJson(socket, { type: 'error', code: 'UNKNOWN_PEER', message: 'That participant is not in this room.' });
            return;
          }
          sendJson(target.socket, { type: 'signal', from: currentPeer.peer.id, data });
          return;
        }
        case 'state': {
          currentPeer.peer.mic = message.mic === true;
          currentPeer.peer.cam = message.cam === true;
          currentPeer.peer.screen = message.screen === true;
          for (const other of this.peers.values()) {
            if (other === currentPeer) continue;
            sendJson(other.socket, {
              type: 'peer-state',
              id: currentPeer.peer.id,
              mic: currentPeer.peer.mic,
              cam: currentPeer.peer.cam,
              screen: currentPeer.peer.screen,
            });
          }
          return;
        }
        case 'leave':
          this.leave(currentPeer);
          peer = undefined;
          socket.close(1000, 'Left the call.');
          return;
        case 'ping':
          sendJson(socket, { type: 'pong' });
          return;
        default:
          sendJson(socket, { type: 'error', code: 'BAD_MESSAGE', message: 'Unknown message type.' });
      }
    });

    socket.on('error', () => {
      // close performs cleanup
    });
    socket.on('close', () => {
      clearTimeout(joinDeadline);
      clearInterval(heartbeat);
      if (peer) {
        this.leave(peer);
        peer = undefined;
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const state of [...this.peers.values()]) {
      try {
        state.socket.close(1001, 'Server is shutting down.');
      } catch {
        state.socket.terminate();
      }
    }
    this.peers.clear();
  }

  private join(socket: WebSocket, message: Record<string, unknown>): PeerState | undefined {
    if (this.peers.size >= this.maxPeers) {
      sendJson(socket, { type: 'error', code: 'ROOM_FULL', message: 'This room is full.' });
      socket.close(4405, 'Room is full.');
      return undefined;
    }

    const peer: PeerInfo = {
      id: randomUUID(),
      name: sanitizeName(message.name),
      color: sanitizeColor(message.color),
      mic: message.mic === true,
      cam: message.cam === true,
      screen: message.screen === true,
    };
    const now = Date.now();
    const state: PeerState = {
      socket,
      peer,
      alive: true,
      tokens: RATE_BURST,
      lastRefill: now,
    };
    this.peers.set(peer.id, state);

    const existing = [...this.peers.values()].filter((other) => other !== state);
    sendJson(socket, { type: 'joined', self: peer, peers: existing.map((other) => other.peer) });
    for (const other of existing) sendJson(other.socket, { type: 'peer-joined', peer });
    return state;
  }

  private leave(state: PeerState): void {
    if (!this.peers.has(state.peer.id)) return;
    this.peers.delete(state.peer.id);
    for (const other of this.peers.values()) {
      sendJson(other.socket, { type: 'peer-left', id: state.peer.id });
    }
  }
}

function rateCheck(peer: PeerState | undefined): boolean {
  if (!peer) return false;
  const now = Date.now();
  peer.tokens = Math.min(RATE_BURST, peer.tokens + (now - peer.lastRefill) * RATE_REFILL_PER_MS);
  peer.lastRefill = now;
  peer.tokens -= 1;
  return peer.tokens >= 0;
}

/** Rebuild the payload from validated fields only — never relay raw client JSON. */
function sanitizeSignalData(raw: unknown): SignalPayload | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case 'offer':
    case 'answer': {
      if (typeof raw.sdp !== 'string' || raw.sdp.length === 0 || raw.sdp.length > MAX_SDP_CHARS) return undefined;
      return { kind: raw.kind, sdp: raw.sdp };
    }
    case 'candidate': {
      const candidate = raw.candidate;
      if (candidate !== null && (typeof candidate !== 'string' || candidate.length > MAX_CANDIDATE_CHARS)) {
        return undefined;
      }
      const payload: SignalPayload = { kind: 'candidate', candidate: candidate as string | null };
      if (raw.sdpMid !== undefined && raw.sdpMid !== null) {
        if (typeof raw.sdpMid !== 'string' || raw.sdpMid.length > 128) return undefined;
        payload.sdpMid = raw.sdpMid;
      } else if (raw.sdpMid === null) {
        payload.sdpMid = null;
      }
      if (raw.sdpMLineIndex !== undefined && raw.sdpMLineIndex !== null) {
        if (
          typeof raw.sdpMLineIndex !== 'number' ||
          !Number.isInteger(raw.sdpMLineIndex) ||
          raw.sdpMLineIndex < 0 ||
          raw.sdpMLineIndex > 255
        ) {
          return undefined;
        }
        payload.sdpMLineIndex = raw.sdpMLineIndex;
      } else if (raw.sdpMLineIndex === null) {
        payload.sdpMLineIndex = null;
      }
      if (raw.usernameFragment !== undefined && raw.usernameFragment !== null) {
        if (typeof raw.usernameFragment !== 'string' || raw.usernameFragment.length > 256) return undefined;
        payload.usernameFragment = raw.usernameFragment;
      }
      return payload;
    }
    case 'bye':
      return { kind: 'bye' };
    default:
      return undefined;
  }
}

function sanitizeName(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'Guest';
}

function sanitizeColor(raw: unknown): string {
  if (typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  return '#7c8cf8';
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WS_OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // The close handler performs cleanup.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
