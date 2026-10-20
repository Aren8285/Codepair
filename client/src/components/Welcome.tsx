import type { FileEntry } from '../lib/api';
import { baseName } from '../lib/language';
import { Icon, PairMark } from './Icon';

interface WelcomeProps {
  rootName: string;
  readOnly: boolean;
  files: FileEntry[];
  onOpenFile: (path: string) => void;
  onQuickOpen: () => void;
  onShare: () => void;
  onHelp: () => void;
}

export function Welcome({ rootName, readOnly, files, onOpenFile, onQuickOpen, onShare, onHelp }: WelcomeProps) {
  return (
    <div className="welcome">
      <div className="welcome__inner">
        <div className="welcome__mark">
          <PairMark size={40} />
        </div>
        <p className="welcome__eyebrow">
          <span className="connection__dot connection__dot--live" aria-hidden="true" />
          Connected to {rootName}
        </p>
        <h1 className="welcome__title">A window into your workspace.</h1>
        <p className="welcome__lede">
          Files stay on the host. Edits sync as you type, and the terminal runs where the code lives.
        </p>
        <div className="welcome__actions">
          <button className="button button--primary" onClick={onQuickOpen}>
            <Icon name="search" size={16} />
            Open a file
          </button>
          <button className="button button--ghost" onClick={onShare}>
            <Icon name="share" size={15} />
            Share session
          </button>
          <button className="button button--ghost" onClick={onHelp}>
            <Icon name="info" size={15} />
            How to use
          </button>
        </div>

        {files.length > 0 ? (
          <div className="welcome__files">
            <p className="welcome__files-label">In this folder</p>
            <div className="welcome__file-list">
              {files.slice(0, 5).map((file) => (
                <button key={file.path} className="welcome__file" onClick={() => onOpenFile(file.path)}>
                  <Icon name="file" size={15} />
                  <span>{baseName(file.path)}</span>
                  <span className="welcome__file-open">Open</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="welcome__hints">
          <span><kbd>⌘</kbd><kbd>P</kbd> quick open</span>
          <span><kbd>⌘</kbd><kbd>`</kbd> terminal</span>
          <span><kbd>⌘</kbd><kbd>S</kbd> save now</span>
          {readOnly ? <span className="welcome__readonly">Read-only session</span> : null}
        </div>
      </div>
    </div>
  );
}
