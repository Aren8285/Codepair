import type { AccessMode } from '../lib/api';
import type { CursorState, SaveState } from '../lib/status';
import { Icon } from './Icon';

interface StatusBarProps {
  activePath: string | null;
  language: string;
  cursor: CursorState;
  mode: AccessMode;
  save: SaveState;
  savedAt?: number;
  terminalOpen: boolean;
  terminalEnabled: boolean;
  onToggleTerminal: () => void;
}

export function StatusBar({
  activePath,
  language,
  cursor,
  mode,
  save,
  savedAt,
  terminalOpen,
  terminalEnabled,
  onToggleTerminal,
}: StatusBarProps) {
  return (
    <footer className="statusbar">
      <div className="statusbar__left">
        <span className={`statusbar__save statusbar__save--${save}`}>
          {save === 'saving' ? <span className="spinner spinner--small" /> : <Icon name="check" size={13} />}
          {save === 'saving' ? 'Saving' : save === 'error' ? 'Save failed' : 'Saved'}
        </span>
        <span className="statusbar__path" title={activePath ?? 'No file open'}>
          {activePath ?? 'No file open'}
        </span>
        {savedAt && save === 'saved' ? (
          <span className="statusbar__time">saved {new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        ) : null}
      </div>
      <div className="statusbar__right">
        <span className="statusbar__item">{language}</span>
        <span className="statusbar__item">
          Ln {cursor.line}, Col {cursor.column}
        </span>
        {cursor.selected > 0 ? <span className="statusbar__item">{cursor.selected} selected</span> : null}
        <span className="statusbar__item statusbar__mode">{mode === 'read-only' ? 'Read-only' : 'Live editing'}</span>
        <button
          className={`statusbar__terminal${terminalOpen ? ' is-active' : ''}`}
          onClick={onToggleTerminal}
          disabled={!terminalEnabled}
          aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
        >
          <Icon name="terminal" size={13} />
          Terminal
        </button>
      </div>
    </footer>
  );
}
