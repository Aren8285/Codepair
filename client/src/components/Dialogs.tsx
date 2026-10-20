import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import type { ApiClient, FileEntry, SearchResponse } from '../lib/api';
import { describeApiError } from '../lib/api';
import { baseName } from '../lib/language';
import { buildShareUrl } from '../lib/token';
import { Modal } from './Modal';
import { Icon } from './Icon';

interface ShareDialogProps {
  token: string;
  roomId: string;
  rootName: string;
  readOnly: boolean;
  onClose: () => void;
  onLock: () => void;
  onToast: (kind: 'success' | 'error' | 'info' | 'warning', message: string, detail?: string) => void;
}

export function ShareDialog({ token, roomId, rootName, readOnly, onClose, onLock, onToast }: ShareDialogProps) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const url = useMemo(() => buildShareUrl(token, roomId), [token, roomId]);
  const copiedTimer = useRef<number | undefined>(undefined);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
  const masked = url.replace(/#token=.*/, '#token=••••••••••••');

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 480,
      color: { dark: '#0b1218', light: '#eef3f8' },
    })
      .then((data) => {
        if (!cancelled) setQr(data);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const copy = async () => {
    let success = false;
    try {
      await navigator.clipboard.writeText(url);
      success = true;
    } catch {
      success = false;
    }
    if (!success) {
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      try {
        success = document.execCommand('copy');
      } catch {
        success = false;
      }
      textarea.remove();
    }
    if (success) {
      setCopied(true);
      onToast('success', 'Room link copied');
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2200);
    } else {
      setRevealed(true);
      onToast('error', 'Could not copy automatically', 'Select the link and copy it manually.');
    }
  };

  return (
    <Modal
      title="Invite to this room"
      description={`${rootName} · room ${roomId}`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button className="button button--ghost button--danger-text" onClick={onLock}>
            <Icon name="lock" size={14} /> Lock session
          </button>
          <button className="button button--primary" onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="share">
        <div className="share__qr">
          <div className="share__qr-frame">
            {qr ? (
              <img src={qr} alt="QR code containing this room's access link" width={188} height={188} />
            ) : (
              <span className="spinner" />
            )}
            <span className="share__qr-corner share__qr-corner--tl" aria-hidden="true" />
            <span className="share__qr-corner share__qr-corner--tr" aria-hidden="true" />
            <span className="share__qr-corner share__qr-corner--bl" aria-hidden="true" />
            <span className="share__qr-corner share__qr-corner--br" aria-hidden="true" />
          </div>
          <p className="share__qr-hint">Scan on a phone on the same network.</p>
        </div>

        <div className="share__details">
          <label className="field-label" htmlFor="share-link">Room link</label>
          <div className="share__link-row">
            <input
              id="share-link"
              className="text-input text-input--mono"
              value={revealed ? url : masked}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <button className="button button--ghost" onClick={() => setRevealed((value) => !value)}>
              {revealed ? 'Hide' : 'Show'}
            </button>
          </div>
          <button className="button button--primary share__copy" onClick={() => void copy()}>
            <Icon name={copied ? 'check' : 'copy'} size={15} />
            {copied ? 'Copied link' : 'Copy room link'}
          </button>

          <div className={`share__mode share__mode--${readOnly ? 'read' : 'write'}`}>
            <Icon name={readOnly ? 'lock' : 'pencil'} size={14} />
            <p>
              {readOnly
                ? 'Anyone with this link can read the project. Editing and the terminal are disabled.'
                : 'Anyone with this link can edit files, join calls, and open a terminal on this host.'}
            </p>
          </div>

          {loopback ? (
            <div className="share__notice">
              <Icon name="info" size={14} />
              <p>
                This address points at <code>localhost</code>, so a phone cannot open it. Restart the host with
                <code> --host 0.0.0.0</code> and use the network link printed in your terminal.
              </p>
            </div>
          ) : null}
          <p className="share__expiry">Token-scoped access. Closing the host process revokes every link.</p>
        </div>
      </div>
    </Modal>
  );
}

interface QuickOpenDialogProps {
  api: ApiClient;
  onOpen: (path: string) => void;
  onClose: () => void;
}

export function QuickOpenDialog({ api, onOpen, onClose }: QuickOpenDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResponse['entries']>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setError('');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .search(trimmed, controller.signal)
        .then((response) => {
          setResults(response.entries);
          setTruncated(response.truncated);
          setSelected(0);
          setError('');
        })
        .catch((cause: unknown) => {
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          setError(describeApiError(cause));
        })
        .finally(() => setLoading(false));
    }, 140);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [api, query]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const choose = (path: string) => {
    onOpen(path);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((value) => Math.min(value + 1, Math.max(0, results.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((value) => Math.max(0, value - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = results[selected];
      if (entry) choose(entry.path);
    }
  };

  return (
    <Modal
      title="Open a file"
      description="Search every file in the shared project."
      onClose={onClose}
      size="lg"
      className="quickopen"
    >
      <div className="quickopen__search">
        <Icon name="search" size={17} />
        <input
          data-autofocus
          className="quickopen__input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a file name or path"
          autoComplete="off"
          spellCheck={false}
          aria-controls="quickopen-results"
          aria-activedescendant={results[selected] ? `quickopen-result-${selected}` : undefined}
          aria-label="Search files"
        />
        {loading ? <span className="spinner spinner--small" /> : null}
      </div>

      <div className="quickopen__results" id="quickopen-results" role="listbox" aria-label="Matching files" ref={listRef}>
        {error ? <p className="quickopen__empty quickopen__empty--error">{error}</p> : null}
        {!error && query.trim() === '' ? (
          <div className="quickopen__empty">
            <p>Start typing to find a file.</p>
            <span>Only files in this project are searched. Heavy folders are skipped.</span>
          </div>
        ) : null}
        {!error && query.trim() !== '' && !loading && results.length === 0 ? (
          <div className="quickopen__empty">
            <p>No matching files.</p>
            <span>Try a shorter name or a different extension.</span>
          </div>
        ) : null}
        {results.map((entry, index) => {
          const directory = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1) : '';
          return (
            <button
              key={entry.path}
              id={`quickopen-result-${index}`}
              role="option"
              aria-selected={index === selected}
              data-selected={index === selected}
              className={`quickopen__item${index === selected ? ' is-selected' : ''}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(entry.path)}
            >
              <span className="quickopen__icon"><Icon name="file" size={15} /></span>
              <span className="quickopen__name">{baseName(entry.path)}</span>
              <span className="quickopen__path">{directory.replace(/\/$/, '')}</span>
              <span className="quickopen__open">Open</span>
            </button>
          );
        })}
        {truncated ? <p className="quickopen__truncated">Showing the first matches. Refine your search for more.</p> : null}
      </div>

      <div className="quickopen__footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </Modal>
  );
}

interface NewEntryDialogProps {
  kind: 'file' | 'folder';
  parentDir: string;
  onClose: () => void;
  onCreate: (path: string) => Promise<void>;
}

export function NewEntryDialog({ kind, parentDir, onClose, onCreate }: NewEntryDialogProps) {
  const [value, setValue] = useState(parentDir ? `${parentDir}/` : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const path = value.trim();
    if (!path) {
      setError(`Enter a name for the new ${kind}.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onCreate(path);
    } catch (cause) {
      setError(describeApiError(cause));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={kind === 'file' ? 'New file' : 'New folder'}
      description={parentDir ? `Inside ${parentDir}` : 'At the project root'}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="button button--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" type="submit" form="new-entry-form" disabled={busy}>
            {busy ? <span className="spinner spinner--small" /> : <Icon name={kind === 'file' ? 'file-plus' : 'folder-plus'} size={14} />}
            Create {kind}
          </button>
        </>
      }
    >
      <form id="new-entry-form" onSubmit={(event) => void submit(event)} className="dialog-form">
        <label className="field-label" htmlFor="new-entry-path">{kind === 'file' ? 'File path' : 'Folder path'}</label>
        <input
          id="new-entry-path"
          data-autofocus
          className="text-input text-input--mono"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={kind === 'file' ? 'src/new-file.ts' : 'src/components'}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="field-help">Relative to the project root. Nested folders must already exist.</p>
        {error ? <p className="field-error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
      </form>
    </Modal>
  );
}

interface RenameDialogProps {
  entry: FileEntry;
  onClose: () => void;
  onRename: (to: string) => Promise<void>;
}

export function RenameDialog({ entry, onClose, onRename }: RenameDialogProps) {
  const [value, setValue] = useState(entry.path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = value.trim();
    if (!next) {
      setError('Enter a path.');
      return;
    }
    if (next === entry.path) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onRename(next);
    } catch (cause) {
      setError(describeApiError(cause));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Rename"
      description={entry.path}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="button button--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="button button--primary" type="submit" form="rename-form" disabled={busy}>
            {busy ? <span className="spinner spinner--small" /> : <Icon name="pencil" size={14} />}
            Rename
          </button>
        </>
      }
    >
      <form id="rename-form" onSubmit={(event) => void submit(event)} className="dialog-form">
        <label className="field-label" htmlFor="rename-path">New path</label>
        <input
          id="rename-path"
          data-autofocus
          className="text-input text-input--mono"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="field-help">Use a path to move the {entry.type === 'directory' ? 'folder' : 'file'} within the project.</p>
        {error ? <p className="field-error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
      </form>
    </Modal>
  );
}

interface DeleteDialogProps {
  entry: FileEntry;
  onClose: () => void;
  onDelete: () => Promise<void>;
}

export function DeleteDialog({ entry, onClose, onDelete }: DeleteDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onDelete();
    } catch (cause) {
      setError(describeApiError(cause));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Delete ${entry.type === 'directory' ? 'folder' : 'file'}?`}
      description={entry.path}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="button button--ghost" onClick={onClose}>Cancel</button>
          <button className="button button--danger" onClick={() => void submit()} disabled={busy}>
            {busy ? <span className="spinner spinner--small" /> : <Icon name="trash" size={14} />}
            Delete permanently
          </button>
        </>
      }
    >
      <div className="delete-warning">
        <span className="delete-warning__icon"><Icon name="alert" size={18} /></span>
        <div>
          <p>
            {entry.type === 'directory'
              ? 'Everything inside this folder will be removed from the host.'
              : 'This file will be removed from the host.'}
          </p>
          <p className="delete-warning__note">This action cannot be undone.</p>
        </div>
      </div>
      {error ? <p className="field-error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
    </Modal>
  );
}
