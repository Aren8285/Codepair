import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { LobbyEntry, LobbySnapshot } from '../lib/api';
import { Icon, PairMark } from '../components/Icon';
import { HostApi, HostApiError, type HostSessionState } from './hostApi';
import { clearHostToken, loadHostToken, parseHostToken, storeHostToken } from './token';

type StreamState = 'connecting' | 'live' | 'reconnecting';

/** Above this many waiting cards the list scrolls instead of the page. */
export function HostApp() {
  const [token, setToken] = useState<string | null>(() => loadHostToken());
  const [snapshot, setSnapshot] = useState<LobbySnapshot | null>(null);
  const [info, setInfo] = useState<HostSessionState | null>(null);
  const [stream, setStream] = useState<StreamState>('connecting');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [kickArm, setKickArm] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const api = useMemo(() => (token ? new HostApi(token) : null), [token]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!kickArm) return;
    const timer = window.setTimeout(() => setKickArm(null), 4000);
    return () => window.clearTimeout(timer);
  }, [kickArm]);

  const fail = useCallback((caught: unknown) => {
    if (caught instanceof HostApiError && caught.status === 401) {
      clearHostToken();
      setToken(null);
      setSnapshot(null);
      setInfo(null);
      setError('That host token was rejected. Open the console link printed at startup again.');
      return;
    }
    setError(caught instanceof Error ? caught.message : 'The host console request failed.');
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    const [nextSnapshot, nextInfo] = await Promise.all([api.snapshot(), api.sessionState()]);
    setSnapshot(nextSnapshot);
    setInfo(nextInfo);
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setError('');
    refresh().catch((caught: unknown) => {
      if (!cancelled) fail(caught);
    });
    return () => {
      cancelled = true;
    };
  }, [api, refresh, fail]);

  useEffect(() => {
    if (!api) return;
    const source = new EventSource(api.eventsUrl());
    const apply = (event: MessageEvent) => {
      try {
        setSnapshot(JSON.parse(String(event.data)) as LobbySnapshot);
        setStream('live');
      } catch {
        // A malformed frame is ignored; the next snapshot replaces it.
      }
    };
    source.addEventListener('snapshot', apply);
    source.addEventListener('lobby', apply);
    source.onopen = () => setStream('live');
    source.onerror = () => setStream('reconnecting');
    return () => source.close();
  }, [api]);

  const act = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setBusy(key);
      setError('');
      try {
        await action();
      } catch (caught) {
        fail(caught);
      } finally {
        setBusy(null);
      }
    },
    [fail],
  );

  const admit = (entry: LobbyEntry, role: 'editor' | 'viewer') => {
    if (!api) return;
    void act(`admit:${entry.id}`, async () => {
      await api.admit(entry.id, role);
      await refresh();
    });
  };

  const deny = (entry: LobbyEntry) => {
    if (!api) return;
    void act(`deny:${entry.id}`, async () => {
      await api.deny(entry.id);
      await refresh();
    });
  };

  const toggleLock = () => {
    if (!api || !snapshot) return;
    void act('lock', async () => {
      setSnapshot(await api.lock(!snapshot.locked));
    });
  };

  const kick = (entry: LobbySnapshot['admitted'][number]) => {
    if (!api) return;
    if (kickArm !== entry.connectionId) {
      setKickArm(entry.connectionId);
      return;
    }
    setKickArm(null);
    void act(`kick:${entry.connectionId}`, async () => {
      await api.kick(entry.connectionId);
      await refresh();
    });
  };

  const connect = (next: string) => {
    storeHostToken(next);
    setError('');
    setToken(next);
  };

  if (!token) {
    return <HostGate onConnect={connect} error={error} />;
  }

  if (!snapshot) {
    return (
      <div className="hostBoot">
        <div className="hostBoot__mark">
          <PairMark size={30} />
        </div>
        <p className="hostBoot__title">Opening the Host console</p>
        <p className="hostBoot__text">{error || 'Reading the lobby from the host process.'}</p>
        {error ? (
          <div className="hostBoot__actions">
            <button className="button button--ghost" onClick={() => setToken(null)}>
              Use a different token
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const waiting = snapshot.pending;
  const inside = snapshot.admitted;
  const ownerOnline = inside.filter((entry) => entry.role === 'owner').length;

  return (
    <div className="host">
      <header className="host__bar">
        <div className="host__brand">
          <span className="host__brand-mark">
            <PairMark size={24} />
          </span>
          <div className="host__brand-text">
            <span className="host__wordmark">CodePair</span>
            <span className="host__console">Host console</span>
          </div>
        </div>

        <div className="host__session">
          <span className="host__root">{info?.session.rootName ?? '—'}</span>
          <code className="host__path" title={info?.session.rootPath}>
            {info?.session.rootPath ?? 'Reading the project…'}
          </code>
        </div>

        <div className="host__bar-right">
          <span className={`host__stream host__stream--${stream}`} title="Live lobby events">
            <span className="host__stream-dot" aria-hidden="true" />
            {stream === 'live' ? 'Live' : stream === 'reconnecting' ? 'Reconnecting' : 'Connecting'}
          </span>
          {snapshot.enabled ? (
            <button
              className={`host__lock${snapshot.locked ? ' is-locked' : ''}`}
              onClick={toggleLock}
              aria-pressed={snapshot.locked}
              disabled={busy === 'lock'}
            >
              <Icon name={snapshot.locked ? 'lock' : 'lock'} size={14} />
              {snapshot.locked ? 'Room locked' : 'Room open'}
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="host__error" role="alert">
          <Icon name="alert" size={14} />
          {error}
        </p>
      ) : null}

      {!snapshot.enabled ? (
        <p className="host__notice">
          <Icon name="info" size={14} />
          The waiting room is off (<code>--no-lobby</code>). Everyone with a token goes straight in; lock, admit and kick
          are unavailable until the host restarts without that flag.
        </p>
      ) : null}

      <main className="host__grid">
        <section className="host__col" aria-labelledby="host-pending">
          <div className="host__col-head">
            <h2 id="host-pending">Waiting</h2>
            <span className={`host__count${waiting.length > 0 ? ' host__count--hot' : ''}`}>{waiting.length}</span>
          </div>
          {waiting.length === 0 ? (
            <div className="host__empty">
              <p className="host__empty-title">Nobody is waiting.</p>
              <p className="host__empty-text">
                Share the room link. A guest appears here with the name their tab chose, and stays out until you admit
                them.
              </p>
            </div>
          ) : (
            <ul className="host__list">
              {waiting.map((entry) => (
                <li key={entry.id} className="host__card">
                  <div className="host__card-top">
                    <span className="host__avatar" aria-hidden="true">
                      {initials(entry.displayName)}
                    </span>
                    <div className="host__card-name">
                      <p className="host__name">{entry.displayName}</p>
                      <p className="host__meta">
                        asked as {entry.tokenRole} · waiting {relative(entry.requestedAt, now)}
                      </p>
                    </div>
                    <span className={`host__badge host__badge--${entry.tokenRole}`}>{entry.tokenRole}</span>
                  </div>
                  <div className="host__card-actions">
                    {entry.tokenRole === 'viewer' ? (
                      <button
                        className="button button--primary button--small"
                        onClick={() => admit(entry, 'viewer')}
                        disabled={busy === `admit:${entry.id}`}
                      >
                        Admit as viewer
                      </button>
                    ) : (
                      <>
                        <button
                          className="button button--primary button--small"
                          onClick={() => admit(entry, 'editor')}
                          disabled={busy === `admit:${entry.id}`}
                        >
                          Admit as editor
                        </button>
                        <button
                          className="button button--ghost button--small"
                          onClick={() => admit(entry, 'viewer')}
                          disabled={busy === `admit:${entry.id}`}
                        >
                          Viewer
                        </button>
                      </>
                    )}
                    <button
                      className="button button--ghost button--small host__deny"
                      onClick={() => deny(entry)}
                      disabled={busy === `deny:${entry.id}`}
                    >
                      Deny
                    </button>
                  </div>
                  <p className="host__card-foot">connection {shortId(entry.connectionId)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="host__col host__col--inside" aria-labelledby="host-inside">
          <div className="host__col-head">
            <h2 id="host-inside">In the session</h2>
            <span className="host__count">{inside.length}</span>
          </div>
          {inside.length === 0 ? (
            <div className="host__empty">
              <p className="host__empty-title">The room is empty.</p>
              <p className="host__empty-text">Admitted guests and the owner appear here. Removing one closes every socket that tab opened.</p>
            </div>
          ) : (
            <ul className="host__list">
              {inside.map((entry) => (
                <li key={entry.connectionId} className="host__card host__card--inside">
                  <div className="host__card-top">
                    <span className={`host__avatar host__avatar--${entry.role}`} aria-hidden="true">
                      {initials(entry.displayName)}
                    </span>
                    <div className="host__card-name">
                      <p className="host__name">{entry.displayName}</p>
                      <p className="host__meta">
                        {entry.role} · in for {relative(entry.connectedSince, now)}
                      </p>
                    </div>
                    <span className={`host__badge host__badge--${entry.role}`}>{entry.role}</span>
                  </div>
                  <div className="host__card-actions host__card-actions--end">
                    {entry.role === 'owner' ? (
                      <span className="host__owner-note">Owner bypasses the lobby</span>
                    ) : (
                      <button
                        className={`button button--small ${kickArm === entry.connectionId ? 'button--danger' : 'button--ghost host__deny'}`}
                        onClick={() => kick(entry)}
                        disabled={!snapshot.enabled || busy === `kick:${entry.connectionId}`}
                      >
                        {kickArm === entry.connectionId ? 'Confirm kick' : 'Kick'}
                      </button>
                    )}
                  </div>
                  <p className="host__card-foot">connection {shortId(entry.connectionId)}</p>
                </li>
              ))}
            </ul>
          )}
          <dl className="host__stats">
            <div>
              <dt>Documents</dt>
              <dd>{info?.openDocuments ?? 0}</dd>
            </div>
            <div>
              <dt>Doc sockets</dt>
              <dd>{info?.documentConnections ?? 0}</dd>
            </div>
            <div>
              <dt>Terminals</dt>
              <dd>{info?.terminals ?? 0}</dd>
            </div>
            <div>
              <dt>Owners</dt>
              <dd>{ownerOnline}</dd>
            </div>
          </dl>
        </section>
      </main>

      <footer className="host__foot">
        <span>Loopback only</span>
        <span className="host__foot-sep" aria-hidden="true" />
        <span>The admin token stays in this browser tab.</span>
        <span className="host__foot-sep" aria-hidden="true" />
        <span>Lobby changes stream live over SSE.</span>
      </footer>
    </div>
  );
}

function HostGate({ onConnect, error }: { onConnect: (token: string) => void; error?: string }) {
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const token = parseHostToken(value);
    if (!token) {
      setLocalError('Paste the full host console link, or the token after #admin=.');
      return;
    }
    setLocalError('');
    onConnect(token);
  };

  return (
    <div className="hostGate">
      <section className="hostGate__panel">
        <div className="hostGate__brand">
          <span className="hostGate__mark">
            <PairMark size={28} />
          </span>
          <span className="hostGate__wordmark">CodePair</span>
        </div>
        <p className="hostGate__eyebrow">Host console</p>
        <h1 className="hostGate__title">Open the control room.</h1>
        <p className="hostGate__body">
          This page only answers on the host machine’s loopback listener. Paste the link printed at startup — its
          token never leaves this tab.
        </p>
        <form className="hostGate__form" onSubmit={submit}>
          <label className="field-label" htmlFor="host-token">
            Host console link or token
          </label>
          <input
            id="host-token"
            className="text-input text-input--mono"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setLocalError('');
            }}
            placeholder="http://127.0.0.1:7421/host#admin=…"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          {localError || error ? (
            <p className="field-error" role="alert">
              <Icon name="alert" size={14} />
              {localError || error}
            </p>
          ) : null}
          <button className="button button--primary hostGate__submit" type="submit">
            Open console
          </button>
        </form>
        <p className="hostGate__note">Loopback only · the guest app never exposes this listener.</p>
      </section>
    </div>
  );
}

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '');
  return letters.join('') || 'G';
}

function relative(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shortId(connectionId: string): string {
  return connectionId.length <= 14 ? connectionId : `${connectionId.slice(0, 6)}…${connectionId.slice(-4)}`;
}
