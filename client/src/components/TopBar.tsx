import { Icon, PairMark } from './Icon';
import type { AccessMode } from '../lib/api';
import type { ConnectionState } from '../lib/docProvider';
import type { Participant } from '../lib/status';

interface TopBarProps {
  rootName: string;
  roomId: string;
  mode: AccessMode;
  connection: ConnectionState | 'ready';
  participants: Participant[];
  terminalOpen: boolean;
  terminalEnabled: boolean;
  sidebarOpen: boolean;
  callOpen: boolean;
  canDownload: boolean;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  onToggleCall: () => void;
  onDownload: () => void;
  onOpenShare: () => void;
  onToggleTerminal: () => void;
  onOpenHelp: () => void;
  onLock: () => void;
}

const connectionLabel: Record<ConnectionState | 'ready', string> = {
  ready: 'Ready',
  connecting: 'Connecting',
  connected: 'Syncing',
  synced: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

export function TopBar({
  rootName,
  roomId,
  mode,
  connection,
  participants,
  terminalOpen,
  terminalEnabled,
  sidebarOpen,
  callOpen,
  canDownload,
  onToggleSidebar,
  onOpenSearch,
  onToggleCall,
  onDownload,
  onOpenShare,
  onToggleTerminal,
  onOpenHelp,
  onLock,
}: TopBarProps) {
  const others = participants.filter((participant) => !participant.self);
  const visible = others.slice(0, 3);
  const hiddenCount = Math.max(0, others.length - visible.length);
  const statusTone =
    connection === 'synced' || connection === 'ready'
      ? 'live'
      : connection === 'offline'
        ? 'offline'
        : 'pending';

  return (
    <header className="topbar">
      <div className="topbar__left">
        <button
          className="icon-button topbar__menu"
          onClick={onToggleSidebar}
          aria-label="Toggle file explorer"
          aria-expanded={sidebarOpen}
          aria-controls="file-explorer"
        >
          <Icon name="menu" size={18} />
        </button>
        <div className="brand" aria-label="CodePair">
          <PairMark size={23} className="brand__mark" />
          <span className="brand__name">CodePair</span>
        </div>
        <span className="topbar__divider" aria-hidden="true" />
        <span className="topbar__project" title={rootName}>
          {rootName}
        </span>
        <span className={`mode-badge mode-badge--${mode === 'read-only' ? 'read' : 'write'}`}>
          {mode === 'read-only' ? 'Read-only' : 'Read/write'}
        </span>
        <span className="room-chip" title={`Room ${roomId}`}>
          <Icon name="room" size={12} />
          {roomId}
        </span>
      </div>

      <div className="topbar__right">
        <div className="presence" aria-label="People in this file">
          {visible.map((participant) => (
            <span
              key={participant.id}
              className="presence__avatar"
              style={{
                backgroundColor: `${participant.color}24`,
                color: participant.color,
                borderColor: `${participant.color}66`,
              }}
              title={participant.name}
            >
              {initials(participant.name)}
            </span>
          ))}
          {hiddenCount > 0 ? <span className="presence__more">+{hiddenCount}</span> : null}
          {others.length === 0 ? <span className="presence__solo">Just you</span> : null}
        </div>

        <span
          className={`connection connection--${statusTone}`}
          role="status"
          aria-label={`Connection: ${connectionLabel[connection]}`}
          title={connectionLabel[connection]}
        >
          <span className="connection__dot" aria-hidden="true" />
          <span className="connection__label">{connectionLabel[connection]}</span>
        </span>

        <div className="topbar__actions">
          <button className="icon-button" onClick={onOpenSearch} aria-label="Quick open file" title="Quick open (⌘/Ctrl P)">
            <Icon name="search" size={17} />
          </button>
          <button
            className={`icon-button${callOpen ? ' is-active' : ''}`}
            onClick={onToggleCall}
            aria-label="Call panel"
            aria-pressed={callOpen}
            title="Voice, video and screen share"
          >
            <Icon name="video" size={17} />
          </button>
          <button
            className="icon-button topbar__download"
            onClick={onDownload}
            disabled={!canDownload}
            aria-label="Download current file"
            title="Download current editor contents"
          >
            <Icon name="download" size={17} />
          </button>
          <button className="button button--ghost topbar__share" onClick={onOpenShare} title="Share this session">
            <Icon name="share" size={15} />
            <span>Share</span>
          </button>
          <button
            className={`icon-button${terminalOpen ? ' is-active' : ''}`}
            onClick={onToggleTerminal}
            aria-label={terminalEnabled ? 'Toggle terminal' : 'Terminal unavailable'}
            aria-pressed={terminalOpen}
            title={terminalEnabled ? 'Terminal (⌘/Ctrl `)' : 'Terminal unavailable in this session'}
            disabled={!terminalEnabled}
          >
            <Icon name="terminal" size={17} />
          </button>
          <button
            className="icon-button"
            onClick={onOpenHelp}
            aria-label="How to use CodePair"
            title="How to use CodePair"
          >
            <Icon name="info" size={17} />
          </button>
          <button className="icon-button topbar__lock" onClick={onLock} aria-label="Lock session" title="Lock session">
            <Icon name="lock" size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
}
