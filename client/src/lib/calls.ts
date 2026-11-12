import type { IceServer } from './api';
import { currentConnectionId } from './connection';

export type CallStatus = 'idle' | 'connecting' | 'active' | 'reconnecting' | 'error';

export interface CallPeer {
  id: string;
  name: string;
  color: string;
  mic: boolean;
  cam: boolean;
  screen: boolean;
  handRaised: boolean;
  connection: RTCPeerConnectionState | 'new';
  stream: MediaStream | null;
}

export interface CallSnapshot {
  status: CallStatus;
  selfId: string | null;
  localStream: MediaStream | null;
  previewStream: MediaStream | null;
  micEnabled: boolean;
  camEnabled: boolean;
  screenSharing: boolean;
  /** Host-granted moderation for this live signal socket. */
  moderator: boolean;
  /** Peer the host is featuring, or null. */
  spotlightId: string | null;
  handRaised: boolean;
  /** The local audio track was disabled by a host request, not by this user. */
  mutedByHost: boolean;
  peers: CallPeer[];
  error?: string;
}

export interface CallManagerOptions {
  token: string;
  roomId: string;
  iceServers: IceServer[];
  self: { name: string; color: string };
  onToast?: (kind: 'info' | 'warning' | 'error' | 'success', message: string, detail?: string) => void;
  /** Reports the display surface the browser chose, never the pixels. */
  onScreenShareSurface?: (surface: 'monitor' | 'window' | 'browser' | 'unknown') => void;
}

interface PeerRuntime {
  info: CallPeer;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

interface SignalData {
  kind: 'offer' | 'answer' | 'candidate' | 'bye';
  sdp?: string;
  candidate?: string | null;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

const INITIAL: CallSnapshot = {
  status: 'idle',
  selfId: null,
  localStream: null,
  previewStream: null,
  micEnabled: false,
  camEnabled: false,
  screenSharing: false,
  moderator: false,
  spotlightId: null,
  handRaised: false,
  mutedByHost: false,
  peers: [],
};

/** Closing code for a call-only removal; the tab can immediately rejoin. */
const CALL_REMOVED_CLOSE_CODE = 4430;

/**
 * Mesh WebRTC calls for one room.
 *
 * Signalling runs over the authenticated `/ws/signal` socket (token in the
 * WebSocket subprotocol). Media is strictly peer-to-peer; the server only
 * relays SDP and ICE. Perfect negotiation resolves offer glare: the
 * lexicographically larger peer id is "polite" and rolls back on collision.
 */
export class CallManager {
  private snapshot: CallSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly options: CallManagerOptions;
  private readonly peers = new Map<string, PeerRuntime>();
  private socket: WebSocket | undefined;
  private selfId: string | null = null;
  private localStream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenStream: MediaStream | null = null;
  private reconnectTimer: number | undefined;
  private attempts = 0;
  private destroyed = false;
  private leaving = false;

  constructor(options: CallManagerOptions) {
    this.options = options;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CallSnapshot => this.snapshot;

  async join(withVideo: boolean): Promise<void> {
    if (this.snapshot.status !== 'idle' && this.snapshot.status !== 'error') return;
    this.destroyed = false;
    this.leaving = false;
    this.attempts = 0;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException(
          'Your browser blocked camera/microphone access because this page was loaded over plain HTTP. ' +
          'Use the HTTPS link printed by the server, or open via localhost.',
          'NotAllowedError',
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
      this.localStream = stream;
      this.audioTrack = stream.getAudioTracks()[0] ?? null;
      this.cameraTrack = stream.getVideoTracks()[0] ?? null;
      this.replaceSnapshot({
        status: 'connecting',
        localStream: stream,
        previewStream: stream,
        micEnabled: Boolean(this.audioTrack?.enabled),
        camEnabled: Boolean(this.cameraTrack?.enabled),
        screenSharing: false,
        moderator: false,
        spotlightId: null,
        handRaised: false,
        mutedByHost: false,
        error: undefined,
      });
      this.connectSocket();
    } catch (error) {
      const message = describeMediaError(error);
      this.options.onToast?.('error', 'Could not start the call', message);
      this.replaceSnapshot({ status: 'error', error: message, peers: [] });
      this.stopLocalMedia();
    }
  }

  leave(): void {
    this.leaving = true;
    this.sendToSocket({ type: 'leave' });
    this.closeSocket();
    this.closeAllPeers();
    this.stopScreenTracks();
    this.stopLocalMedia();
    this.selfId = null;
    this.replaceSnapshot({ ...INITIAL, status: 'idle' });
  }

  destroy(): void {
    this.leave();
    this.destroyed = true;
    this.listeners.clear();
  }

  toggleMic(): void {
    if (!this.audioTrack) {
      void this.acquireAudio();
      return;
    }
    this.audioTrack.enabled = !this.audioTrack.enabled;
    this.replaceSnapshot({
      micEnabled: this.audioTrack.enabled,
      mutedByHost: this.audioTrack.enabled ? false : this.snapshot.mutedByHost,
    });
    this.broadcastState();
  }

  toggleHand(): void {
    const raised = !this.snapshot.handRaised;
    this.replaceSnapshot({ handRaised: raised });
    this.sendToSocket({ type: 'hand-raise', raised });
  }

  /** Moderator action: ask one participant's client to mute its own track. */
  requestMute(peerId: string): void {
    if (!this.snapshot.moderator) return;
    this.sendToSocket({ type: 'mute-request', to: peerId });
  }

  /** Moderator action: feature one participant, or clear with null. */
  spotlight(peerId: string | null): void {
    if (!this.snapshot.moderator) return;
    this.sendToSocket({ type: 'spotlight', to: peerId });
  }

  /** Moderator action: close only that participant's call socket. */
  removeFromCall(peerId: string): void {
    if (!this.snapshot.moderator) return;
    this.sendToSocket({ type: 'kick-from-call', to: peerId });
  }

  async toggleCamera(): Promise<void> {
    if (!this.cameraTrack) {
      await this.acquireCamera();
      return;
    }
    this.cameraTrack.enabled = !this.cameraTrack.enabled;
    this.replaceSnapshot({ camEnabled: this.cameraTrack.enabled });
    this.broadcastState();
  }

  async startScreenShare(): Promise<void> {
    if (this.snapshot.screenSharing) return;
    if (this.snapshot.status !== 'active') {
      this.options.onToast?.('warning', 'Join the call first', 'Screen sharing needs an active call connection.');
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.options.onToast?.('warning', 'Screen sharing is unavailable', 'This browser or device does not support display capture (most phones do not).');
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = display.getVideoTracks()[0];
      if (!track) {
        this.options.onToast?.('warning', 'No screen selected');
        return;
      }
      this.screenStream = display;
      const settings = track.getSettings() as { displaySurface?: string };
      const surface =
        settings.displaySurface === 'monitor' ||
        settings.displaySurface === 'window' ||
        settings.displaySurface === 'browser'
          ? settings.displaySurface
          : 'unknown';
      this.options.onScreenShareSurface?.(surface);
      track.addEventListener('ended', () => this.stopScreenShare());
      for (const runtime of this.peers.values()) {
        await this.attachVideoTrack(runtime, track, display);
      }
      this.replaceSnapshot({ screenSharing: true, previewStream: display });
      this.broadcastState();
    } catch (error) {
      if ((error as DOMException)?.name === 'NotAllowedError') {
        this.options.onToast?.('info', 'Screen sharing cancelled');
        return;
      }
      this.options.onToast?.('error', 'Could not share the screen', describeMediaError(error));
    }
  }

  stopScreenShare(): void {
    if (!this.snapshot.screenSharing) return;
    const screen = this.screenStream;
    this.screenStream = null;
    screen?.getTracks().forEach((track) => track.stop());
    for (const runtime of this.peers.values()) {
      const sender = runtime.pc.getSenders().find((candidate) => candidate.track?.kind === 'video');
      if (!sender) continue;
      void sender.replaceTrack(this.cameraTrack ?? null).catch(() => undefined);
    }
    this.replaceSnapshot({ screenSharing: false, previewStream: this.localStream });
    this.broadcastState();
  }

  private connectSocket(): void {
    if (this.destroyed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/signal?room=${encodeURIComponent(this.options.roomId)}&cid=${encodeURIComponent(currentConnectionId())}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, ['codepair', this.options.token]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.sendToSocket({
        type: 'join',
        name: this.options.self.name,
        color: this.options.self.color,
        mic: this.snapshot.micEnabled,
        cam: this.snapshot.camEnabled,
        screen: this.snapshot.screenSharing,
      });
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      void this.handleMessage(message);
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.destroyed || this.leaving) return;
      if (event.code === CALL_REMOVED_CLOSE_CODE) {
        // Call-only removal: stop media and let this tab start a fresh call. The
        // document and terminal sockets are deliberately untouched.
        this.closeAllPeers();
        this.stopScreenTracks();
        this.stopLocalMedia();
        this.selfId = null;
        this.replaceSnapshot({ ...INITIAL, status: 'idle' });
        this.options.onToast?.(
          'warning',
          'Removed from the call',
          'The host removed you from this call. You can rejoin any time.',
        );
        return;
      }
      this.clearCallState();
      this.replaceSnapshot({ status: 'reconnecting', peers: [], moderator: false, spotlightId: null });
      this.scheduleReconnect();
    };
  }

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    switch (message.type) {
      case 'joined': {
        const self = message.self as { id?: string; handRaised?: boolean } | undefined;
        this.selfId = self?.id ?? null;
        const peers = (message.peers as Array<Record<string, unknown>> | undefined) ?? [];
        for (const peer of peers) this.ensurePeer(peer);
        this.replaceSnapshot({
          status: 'active',
          selfId: this.selfId,
          moderator: message.moderator === true,
          spotlightId: typeof message.spotlight === 'string' ? message.spotlight : null,
          handRaised: self?.handRaised === true,
        });
        return;
      }
      case 'peer-joined': {
        const peer = message.peer as Record<string, unknown> | undefined;
        if (peer) this.ensurePeer(peer);
        return;
      }
      case 'peer-left': {
        const id = typeof message.id === 'string' ? message.id : '';
        this.removePeer(id);
        return;
      }
      case 'peer-state': {
        const id = typeof message.id === 'string' ? message.id : '';
        const runtime = this.peers.get(id);
        if (!runtime) return;
        runtime.info.mic = message.mic === true;
        runtime.info.cam = message.cam === true;
        runtime.info.screen = message.screen === true;
        this.publishPeers();
        return;
      }
      case 'spotlight': {
        this.replaceSnapshot({
          spotlightId: typeof message.peerId === 'string' ? message.peerId : null,
        });
        return;
      }
      case 'hand-raise': {
        const from = typeof message.from === 'string' ? message.from : '';
        const raised = message.raised === true;
        const runtime = this.peers.get(from);
        if (runtime) {
          runtime.info.handRaised = raised;
          this.publishPeers();
        }
        if (from === this.selfId) this.replaceSnapshot({ handRaised: raised });
        return;
      }
      case 'moderator': {
        if (message.granted === true) {
          this.replaceSnapshot({ moderator: true });
          this.options.onToast?.(
            'info',
            'You can moderate this call',
            'Mute requests ask each participant to turn their own microphone off.',
          );
        }
        return;
      }
      case 'mute-request': {
        this.honorMuteRequest();
        return;
      }
      case 'signal': {
        const from = typeof message.from === 'string' ? message.from : '';
        const runtime = this.peers.get(from);
        if (!runtime) return;
        await this.handleSignal(runtime, message.data as SignalData);
        return;
      }
      case 'error': {
        const text = typeof message.message === 'string' ? message.message : 'Call signalling error.';
        this.options.onToast?.('warning', 'Call error', text);
        return;
      }
      default:
        return;
    }
  }

  private ensurePeer(raw: Record<string, unknown>): PeerRuntime | undefined {
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id || id === this.selfId) return undefined;
    const existing = this.peers.get(id);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers as RTCIceServer[] });
    const info: CallPeer = {
      id,
      name: typeof raw.name === 'string' ? raw.name : 'Guest',
      color: typeof raw.color === 'string' ? raw.color : '#7c8cf8',
      mic: raw.mic !== false,
      cam: raw.cam !== false,
      screen: raw.screen === true,
      handRaised: raw.handRaised === true,
      connection: 'new',
      stream: null,
    };
    const runtime: PeerRuntime = {
      info,
      pc,
      polite: this.selfId !== null && this.selfId > id,
      makingOffer: false,
      ignoreOffer: false,
    };
    this.peers.set(id, runtime);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    pc.onnegotiationneeded = () => {
      void (async () => {
        if (runtime.makingOffer) return;
        try {
          runtime.makingOffer = true;
          await pc.setLocalDescription();
          if (pc.localDescription?.sdp) {
            this.sendSignal(id, { kind: 'offer', sdp: pc.localDescription.sdp });
          }
        } catch (error) {
          console.warn('[codepair] negotiation failed:', error);
        } finally {
          runtime.makingOffer = false;
        }
      })();
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.sendSignal(id, {
        kind: 'candidate',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      });
    };

    pc.ontrack = (event) => {
      const stream = runtime.info.stream ?? new MediaStream();
      stream.addTrack(event.track);
      runtime.info.stream = stream;
      this.publishPeers();
    };

    pc.onconnectionstatechange = () => {
      runtime.info.connection = pc.connectionState;
      if (pc.connectionState === 'failed') {
        this.options.onToast?.('warning', `Connection to ${runtime.info.name} failed`, 'A TURN server may be required on restrictive networks.');
        if (!runtime.polite) pc.restartIce();
      }
      this.publishPeers();
    };

    this.publishPeers();
    return runtime;
  }

  private async handleSignal(runtime: PeerRuntime, data: SignalData): Promise<void> {
    if (!data || typeof data.kind !== 'string') return;
    const { pc } = runtime;
    if (data.kind === 'bye') {
      this.removePeer(runtime.info.id);
      return;
    }

    if (data.kind === 'offer' || data.kind === 'answer') {
      if (!data.sdp) return;
      const offerCollision = data.kind === 'offer' && (runtime.makingOffer || pc.signalingState !== 'stable');
      runtime.ignoreOffer = !runtime.polite && offerCollision;
      if (runtime.ignoreOffer) return;
      try {
        await pc.setRemoteDescription({ type: data.kind, sdp: data.sdp });
        if (data.kind === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription?.sdp) {
            this.sendSignal(runtime.info.id, { kind: 'answer', sdp: pc.localDescription.sdp });
          }
        }
      } catch (error) {
        console.warn('[codepair] remote description failed:', error);
      }
      return;
    }

    if (data.kind === 'candidate' && data.candidate) {
      try {
        await pc.addIceCandidate({
          candidate: data.candidate,
          sdpMid: data.sdpMid ?? null,
          sdpMLineIndex: data.sdpMLineIndex ?? null,
        });
      } catch (error) {
        if (!runtime.ignoreOffer) console.warn('[codepair] ICE candidate failed:', error);
      }
    }
  }

  private async attachVideoTrack(runtime: PeerRuntime, track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    const sender = runtime.pc.getSenders().find((candidate) => candidate.track?.kind === 'video');
    if (sender) {
      await sender.replaceTrack(track);
      return;
    }
    runtime.pc.addTrack(track, stream);
  }

  private async acquireCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.options.onToast?.('error', 'Camera unavailable', 'Secure context (HTTPS) is required for camera access on this network.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      this.cameraTrack = track;
      this.localStream?.addTrack(track);
      for (const runtime of this.peers.values()) {
        await runtime.pc.addTrack(track, this.localStream ?? stream);
      }
      this.replaceSnapshot({ camEnabled: true, previewStream: this.screenStream ?? this.localStream });
      this.broadcastState();
    } catch (error) {
      this.options.onToast?.('error', 'Camera unavailable', describeMediaError(error));
    }
  }

  private async acquireAudio(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.options.onToast?.('error', 'Microphone unavailable', 'Secure context (HTTPS) is required for microphone access on this network.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];
      if (!track) return;
      this.audioTrack = track;
      this.localStream?.addTrack(track);
      for (const runtime of this.peers.values()) {
        await runtime.pc.addTrack(track, this.localStream ?? stream);
      }
      this.replaceSnapshot({ micEnabled: true, mutedByHost: false });
      this.broadcastState();
    } catch (error) {
      this.options.onToast?.('error', 'Microphone unavailable', describeMediaError(error));
    }
  }

  private honorMuteRequest(): void {
    if (this.audioTrack?.enabled) this.audioTrack.enabled = false;
    const micEnabled = this.audioTrack?.enabled === true;
    this.replaceSnapshot({ micEnabled, mutedByHost: true });
    this.broadcastState();
    // Only now, after the local track is actually disabled, may the UI say the
    // host muted this participant. Muting is otherwise advisory.
    this.options.onToast?.(
      'warning',
      'Muted by host',
      'Your microphone was turned off in this browser. You can unmute yourself at any time.',
    );
  }

  private broadcastState(): void {
    this.sendToSocket({
      type: 'state',
      mic: this.snapshot.micEnabled,
      cam: this.snapshot.camEnabled,
      screen: this.snapshot.screenSharing,
    });
  }

  private sendSignal(to: string, data: SignalData): void {
    this.sendToSocket({ type: 'signal', to, data });
  }

  private sendToSocket(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // The close handler drives recovery.
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.leaving) return;
    this.attempts += 1;
    const delay = Math.min(8_000, 500 * 2 ** Math.min(this.attempts - 1, 4));
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.destroyed) return;
      this.connectSocket();
    }, delay);
  }

  private closeSocket(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000, 'Leaving the call.');
    } catch {
      // ignore
    }
  }

  private clearCallState(): void {
    this.selfId = null;
    this.snapshot = {
      ...this.snapshot,
      moderator: false,
      spotlightId: null,
      handRaised: false,
      mutedByHost: false,
    };
  }

  private closeAllPeers(): void {
    for (const runtime of this.peers.values()) {
      runtime.pc.onnegotiationneeded = null;
      runtime.pc.onicecandidate = null;
      runtime.pc.ontrack = null;
      runtime.pc.onconnectionstatechange = null;
      runtime.pc.close();
    }
    this.peers.clear();
    this.publishPeers();
  }

  private removePeer(id: string): void {
    const runtime = this.peers.get(id);
    if (!runtime) return;
    runtime.pc.close();
    this.peers.delete(id);
    this.publishPeers();
  }

  private stopLocalMedia(): void {
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.audioTrack = null;
    this.cameraTrack = null;
  }

  private stopScreenTracks(): void {
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
  }

  private publishPeers(): void {
    this.replaceSnapshot({
      peers: [...this.peers.values()]
        .map((runtime) => runtime.info)
        .sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

  private replaceSnapshot(partial: Partial<CallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) listener();
  }
}

export function describeMediaError(error: unknown): string {
  const name = (error as DOMException | undefined)?.name;
  switch (name) {
    case 'NotAllowedError':
      return 'Camera or microphone permission was denied. Allow access in the browser and try again.';
    case 'NotFoundError':
      return 'No camera or microphone was found on this device.';
    case 'NotReadableError':
      return 'The camera or microphone is already in use by another app.';
    case 'OverconstrainedError':
      return 'The requested media settings are not supported by this device.';
    default:
      return error instanceof Error ? error.message : 'Media access failed.';
  }
}
