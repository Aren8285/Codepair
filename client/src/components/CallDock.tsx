import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import type { CallManager, CallPeer } from '../lib/calls';
import { Icon } from './Icon';

interface CallDockProps {
  manager: CallManager;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export function CallDock({ manager, open, onOpenChange }: CallDockProps) {
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number; width: number; height: number } | null>(null);

  const active = snapshot.status !== 'idle';
  useEffect(() => {
    if (!active) {
      setMinimized(false);
      setMaximized(false);
      setPosition(null);
    }
  }, [active]);

  // A notification toast must never cover the minimized call pill, which sits
  // in the same bottom-right corner. Raising the toast stack by the pill's
  // height keeps both reachable.
  const pillVisible = !open || minimized;
  useEffect(() => {
    const root = document.documentElement;
    if (pillVisible) root.style.setProperty('--toast-offset', '46px');
    else root.style.removeProperty('--toast-offset');
    return () => {
      root.style.removeProperty('--toast-offset');
    };
  }, [pillVisible]);

  if (!open && !active) return null;

  if (!open || minimized) {
    return (
      <>
        <button
          className="callPill"
          onClick={() => {
            onOpenChange(true);
            setMinimized(false);
          }}
          title="Return to the call"
        >
          <span className="callPill__icon"><Icon name="video" size={15} /></span>
          <span>{active ? `${snapshot.peers.length + 1} in call` : 'Call panel'}</span>
          {active ? (
            <span className={`connection__dot connection__dot--${snapshot.status === 'active' ? 'live' : 'pending'}`} aria-hidden="true" />
          ) : null}
        </button>
        {active
          ? snapshot.peers.map((peer) =>
              peer.stream ? <AudioBridge key={peer.id} stream={peer.stream} /> : null,
            )
          : null}
      </>
    );
  }

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (window.matchMedia('(pointer: coarse)').matches) return;
    const dock = dockRef.current;
    if (!dock) return;
    const rect = dock.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    setPosition({ left: rect.left, top: rect.top });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const left = clamp(drag.left + event.clientX - drag.startX, 8, window.innerWidth - drag.width - 8);
    const top = clamp(drag.top + event.clientY - drag.startY, 8, window.innerHeight - drag.height - 8);
    setPosition({ left, top });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  // Give an active screen share the largest slot in the grid so it stays readable.
  const featuredId: string | null = snapshot.screenSharing
    ? 'self'
    : (snapshot.peers.find((peer) => peer.screen)?.id ?? null);

  const statusLabel =
    snapshot.status === 'connecting'
      ? 'Connecting…'
      : snapshot.status === 'reconnecting'
        ? 'Reconnecting…'
        : snapshot.status === 'error'
          ? 'Call failed'
          : active
            ? `${snapshot.peers.length + 1} in call`
            : 'Not in a call';

  return (
    <aside
      className={`callDock${maximized ? ' callDock--max' : ''}`}
      ref={dockRef}
      style={position ? { left: position.left, top: position.top, right: 'auto', bottom: 'auto' } : undefined}
      aria-label="Room call"
    >
      <header
        className="callDock__head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="callDock__grip" aria-hidden="true" />
        <div className="callDock__identity">
          <p className="callDock__eyebrow">Room call</p>
          <p className="callDock__status" role="status">
            <span
              className={`connection__dot connection__dot--${
                snapshot.status === 'active' ? 'live' : snapshot.status === 'idle' || snapshot.status === 'error' ? 'offline' : 'pending'
              }`}
              aria-hidden="true"
            />
            {statusLabel}
          </p>
        </div>
        <div className="callDock__headActions">
          <button
            className={`icon-button${maximized ? ' is-on' : ''}`}
            onClick={() => {
              setMaximized((value) => !value);
              // Re-anchor to the docked spot so the enlarged panel stays on screen.
              setPosition(null);
            }}
            aria-pressed={maximized}
            aria-label={maximized ? 'Restore call panel size' : 'Maximize call panel'}
            title={maximized ? 'Restore size' : 'Maximize (half screen)'}
          >
            <Icon name={maximized ? 'minimize' : 'maximize'} size={15} />
          </button>
          <button className="icon-button" onClick={() => setMinimized(true)} aria-label="Minimize call" title="Minimize">
            <Icon name="chevron-down" size={15} />
          </button>
          <button className="icon-button" onClick={() => onOpenChange(false)} aria-label="Close call panel" title="Close panel">
            <Icon name="close" size={15} />
          </button>
        </div>
      </header>

      {!active ? (
        <div className="callDock__idle">
          <p className="callDock__lede">
            Talk while you code. Media goes peer-to-peer; the host only relays connection setup.
          </p>
          <div className="callDock__join">
            <button className="button button--primary" onClick={() => void manager.join(true)}>
              <Icon name="video" size={15} />
              Start video call
            </button>
            <button className="button button--ghost" onClick={() => void manager.join(false)}>
              <Icon name="mic" size={15} />
              Audio only
            </button>
          </div>
          <p className="callDock__note">
            The browser asks for microphone and camera access only when you start. Screen sharing is available once
            you are in the call.
          </p>
          {snapshot.error ? <p className="callDock__error" role="alert">{snapshot.error}</p> : null}
        </div>
      ) : (
        <div className="callDock__body">
          <div className={`callDock__grid${snapshot.peers.length === 0 ? ' callDock__grid--solo' : ''}${featuredId ? ' callDock__grid--featured' : ''}`}>
            <VideoTile
              stream={snapshot.previewStream}
              name="You"
              color="#7c8cf8"
              muted
              self
              mic={snapshot.micEnabled}
              cam={snapshot.camEnabled}
              screen={snapshot.screenSharing}
              connection="connected"
              featured={featuredId === 'self'}
            />
            {snapshot.peers.map((peer) => (
              <VideoTile
                key={peer.id}
                stream={peer.stream}
                name={peer.name}
                color={peer.color}
                mic={peer.mic}
                cam={peer.cam}
                screen={peer.screen}
                connection={peer.connection}
                featured={featuredId === peer.id}
              />
            ))}
          </div>

          {snapshot.peers.length === 0 ? (
            <p className="callDock__waiting">Waiting for others to join the call…</p>
          ) : null}

          <div className="callDock__controls">
            <button
              className={`callControl${snapshot.micEnabled ? '' : ' is-off'}`}
              onClick={() => manager.toggleMic()}
              aria-pressed={snapshot.micEnabled}
              aria-label={snapshot.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
              title={snapshot.micEnabled ? 'Mute' : 'Unmute'}
            >
              <Icon name={snapshot.micEnabled ? 'mic' : 'mic-off'} size={16} />
            </button>
            <button
              className={`callControl${snapshot.camEnabled ? '' : ' is-off'}`}
              onClick={() => void manager.toggleCamera()}
              aria-pressed={snapshot.camEnabled}
              aria-label={snapshot.camEnabled ? 'Turn camera off' : 'Turn camera on'}
              title={snapshot.camEnabled ? 'Camera off' : 'Camera on'}
            >
              <Icon name={snapshot.camEnabled ? 'video' : 'video-off'} size={16} />
            </button>
            <button
              className={`callControl${snapshot.screenSharing ? ' is-sharing' : ''}`}
              onClick={() => (snapshot.screenSharing ? manager.stopScreenShare() : void manager.startScreenShare())}
              aria-pressed={snapshot.screenSharing}
              aria-label={snapshot.screenSharing ? 'Stop sharing screen' : 'Share screen'}
              title={snapshot.screenSharing ? 'Stop sharing' : 'Share screen'}
            >
              <Icon name={snapshot.screenSharing ? 'screen-off' : 'screen'} size={16} />
            </button>
            <button className="callControl callControl--leave" onClick={() => manager.leave()} aria-label="Leave call" title="Leave call">
              <Icon name="phone-off" size={16} />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function VideoTile({
  stream,
  name,
  color,
  muted = false,
  self = false,
  mic,
  cam,
  screen,
  connection,
  featured = false,
}: {
  stream: MediaStream | null;
  name: string;
  color: string;
  muted?: boolean;
  self?: boolean;
  mic: boolean;
  cam: boolean;
  screen: boolean;
  connection: RTCPeerConnectionState | 'new' | 'connected';
  featured?: boolean;
}) {
  const tileRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hasVideo = Boolean(stream && stream.getVideoTracks().length > 0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) {
      video.play().catch(() => setNeedsTap(true));
    }
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === tileRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  type WebkitFullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

  const toggleFullscreen = (): void => {
    const tile = tileRef.current;
    if (!tile) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (tile.requestFullscreen) {
      void tile.requestFullscreen().catch(() => {
        // iPhone Safari only allows fullscreen on the video element itself.
        (videoRef.current as WebkitFullscreenVideo | null)?.webkitEnterFullscreen?.();
      });
      return;
    }
    // Older WebKit: no element fullscreen API at all.
    (videoRef.current as WebkitFullscreenVideo | null)?.webkitEnterFullscreen?.();
  };

  return (
    <div
      ref={tileRef}
      className={`videoTile${stream && hasVideo ? ' videoTile--live' : ''}${featured ? ' videoTile--featured' : ''}${isFullscreen ? ' videoTile--fullscreen' : ''}`}
    >
      {stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          className={`videoTile__video${self && !screen ? ' videoTile__video--mirror' : ''}${screen || featured ? ' videoTile__video--screen' : ''}`}
        />
      ) : null}
      {!stream || !hasVideo ? (
        <div className="videoTile__placeholder" style={{ background: `${color}22`, color }}>
          {initials(name)}
        </div>
      ) : null}
      {needsTap && !muted ? (
        <button
          className="videoTile__unmute"
          onClick={() => {
            videoRef.current
              ?.play()
              .then(() => setNeedsTap(false))
              .catch(() => undefined);
          }}
        >
          Tap to hear
        </button>
      ) : null}
      {stream && hasVideo ? (
        <button
          className="videoTile__fs"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen this video'}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          <Icon name={isFullscreen ? 'collapse' : 'expand'} size={12} />
        </button>
      ) : null}
      <span className="videoTile__name" style={{ borderColor: `${color}88` }}>
        {self ? `${name} (you)` : name}
      </span>
      <span className="videoTile__badges">
        {screen ? <span className="videoTile__badge" title="Sharing screen"><Icon name="screen" size={11} /></span> : null}
        {!mic ? <span className="videoTile__badge videoTile__badge--off" title="Muted"><Icon name="mic-off" size={11} /></span> : null}
        {!cam && !screen ? <span className="videoTile__badge videoTile__badge--off" title="Camera off"><Icon name="video-off" size={11} /></span> : null}
        {connection === 'failed' || connection === 'disconnected' ? (
          <span className="videoTile__badge videoTile__badge--off" title="Connection problem">
            <Icon name="alert" size={11} />
          </span>
        ) : null}
      </span>
    </div>
  );
}

function AudioBridge({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    audio.srcObject = stream;
    audio.play().catch(() => undefined);
    return () => {
      audio.srcObject = null;
    };
  }, [stream]);
  return <audio ref={ref} autoPlay className="sr-only" />;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
}
