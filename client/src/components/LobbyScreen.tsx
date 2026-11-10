import type { ReactNode } from 'react';
import { Icon, PairMark } from './Icon';

export type LobbyGateView = 'checking' | 'waiting' | 'denied' | 'expired' | 'removed' | 'locked' | 'full' | 'invite';

interface LobbyScreenProps {
  view: LobbyGateView;
  rootName: string;
  displayName: string;
  message?: string;
  onRetry: (freshIdentity: boolean) => void;
  onLeave: () => void;
}

interface Copy {
  eyebrow: string;
  title: string;
  body: string;
  tone: 'pending' | 'error' | 'warning' | 'muted';
}

const COPY: Record<Exclude<LobbyGateView, 'checking'>, Copy> = {
  waiting: {
    eyebrow: 'Waiting room',
    title: 'The host will let you in.',
    body: 'Your request is in the Host console. Keep this tab open; the session opens here the moment it is admitted.',
    tone: 'pending',
  },
  denied: {
    eyebrow: 'Request declined',
    title: 'The host declined this request.',
    body: 'Nothing from this session was shared with this tab. You can ask again as a new tab, or use a different link.',
    tone: 'error',
  },
  removed: {
    eyebrow: 'Removed',
    title: 'You were removed from this session.',
    body: 'The host closed this tab’s document, terminal and call connections. Ask again to rejoin the queue.',
    tone: 'error',
  },
  expired: {
    eyebrow: 'No answer',
    title: 'Nobody answered in time.',
    body: 'The request expired before the host acted on it. Ask again and it goes back into the queue.',
    tone: 'warning',
  },
  locked: {
    eyebrow: 'Locked',
    title: 'This room is locked.',
    body: 'The host has paused new joins. Try again once the room is open — nothing needs to be reloaded.',
    tone: 'warning',
  },
  full: {
    eyebrow: 'Lobby full',
    title: 'The waiting room is full.',
    body: 'Fifty requests are already waiting. Try again in a moment; the host has to clear some first.',
    tone: 'warning',
  },
  invite: {
    eyebrow: 'Invite unavailable',
    title: 'This invite link can’t be used.',
    body: 'It may have expired, reached its use limit, or been revoked. Ask the host for a fresh invite link.',
    tone: 'error',
  },
};

const PRIMARY: Record<'denied' | 'removed' | 'expired' | 'locked' | 'full' | 'invite', { label: string; fresh: boolean }> = {
  denied: { label: 'Ask again as a new tab', fresh: true },
  removed: { label: 'Ask to join again', fresh: true },
  expired: { label: 'Try again', fresh: false },
  locked: { label: 'Try again', fresh: false },
  full: { label: 'Try again', fresh: false },
  invite: { label: 'Try this link again', fresh: false },
};

/** Full-page gate between "token accepted" and "the workspace". */
export function LobbyScreen({ view, rootName, displayName, message, onRetry, onLeave }: LobbyScreenProps): ReactNode {
  const copy = view === 'checking' ? null : COPY[view];
  const primary = view === 'checking' || view === 'waiting' ? null : PRIMARY[view];

  return (
    <div className={`lobby lobby--${view}`}>
      <section className="lobby__panel" aria-live="polite">
        <div className="lobby__brand">
          <span className="lobby__mark">
            <PairMark size={26} />
          </span>
          <span className="lobby__wordmark">CodePair</span>
        </div>

        {copy ? (
          <>
            <p className={`lobby__eyebrow lobby__eyebrow--${copy.tone}`}>
              <span className="lobby__dot" aria-hidden="true" />
              {copy.eyebrow}
            </p>
            <h1 className="lobby__title">{copy.title}</h1>
            <p className="lobby__body">{copy.body}</p>
          </>
        ) : (
          <>
            <p className="lobby__eyebrow lobby__eyebrow--pending">
              <span className="lobby__dot" aria-hidden="true" />
              Asking the host
            </p>
            <h1 className="lobby__title">Requesting access…</h1>
            <p className="lobby__body">Sending this tab’s connection id to the Host console.</p>
          </>
        )}

        {view === 'checking' || view === 'waiting' ? (
          <div className="lobby__pulse" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {message ? (
          <p className="lobby__error" role="alert">
            <Icon name="alert" size={14} />
            {message}
          </p>
        ) : null}

        <dl className="lobby__facts">
          <div>
            <dt>Project</dt>
            <dd>{rootName}</dd>
          </div>
          <div>
            <dt>You appear as</dt>
            <dd>{displayName}</dd>
          </div>
        </dl>

        <div className="lobby__actions">
          {primary ? (
            <button className="button button--primary" onClick={() => onRetry(primary.fresh)}>
              {primary.label}
            </button>
          ) : null}
          <button className="button button--ghost" onClick={onLeave}>
            Use a different link
          </button>
        </div>

        <p className="lobby__note">
          Requests are visible only in the Host console on the host machine. Nothing is shared until the host admits this tab.
        </p>
      </section>
    </div>
  );
}
