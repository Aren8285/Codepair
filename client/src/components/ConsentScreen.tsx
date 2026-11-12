import type { ConsentItem } from '../lib/api';
import { Icon, PairMark } from './Icon';

interface ConsentScreenProps {
  rootName: string;
  items: ConsentItem[];
  declined: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onLeave: () => void;
}

/**
 * Candidate-only gate shown before this tab asks the Host to join. The list is
 * the server's manifest, not a client-side summary, so the accepted scope and
 * the logged scope cannot drift apart silently.
 */
export function ConsentScreen({
  rootName,
  items,
  declined,
  onAccept,
  onDecline,
  onLeave,
}: ConsentScreenProps) {
  if (declined) {
    return (
      <div className="consent consent--declined">
        <section className="consent__panel" aria-live="polite">
          <div className="consent__brand">
            <span className="consent__mark">
              <PairMark size={26} />
            </span>
            <span className="consent__wordmark">CodePair</span>
          </div>
          <p className="consent__eyebrow">
            <span className="lobby__dot" aria-hidden="true" />
            Interview not started
          </p>
          <h1 className="consent__title">Consent was declined.</h1>
          <p className="consent__body">
            No interview request was sent and no integrity signals were logged. Reload or use a different link to start again.
          </p>
          <div className="consent__actions">
            <button className="button button--primary" onClick={onLeave}>
              Use a different link
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="consent">
      <section className="consent__panel" aria-labelledby="consent-title">
        <div className="consent__brand">
          <span className="consent__mark">
            <PairMark size={26} />
          </span>
          <span className="consent__wordmark">CodePair</span>
        </div>

        <p className="consent__eyebrow">
          <span className="lobby__dot" aria-hidden="true" />
          Interview session · {rootName}
        </p>
        <h1 className="consent__title" id="consent-title">
          Before you join
        </h1>
        <p className="consent__body">
          This interview session records the following signals for the interviewer to review. They are not an automated
          verdict and are not tamper-proof. Nothing is recorded until you accept.
        </p>

        <ul className="consent__list">
          {items.map((item) => (
            <li key={item.id} className="consent__item">
              <span className="consent__check" aria-hidden="true">
                <Icon name="check" size={13} />
              </span>
              <div>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="consent__actions">
          <button className="button button--primary" onClick={onAccept}>
            I understand and agree to proceed
          </button>
          <button className="button button--ghost" onClick={onDecline}>
            Decline and exit
          </button>
        </div>
        <p className="consent__note">
          Your editor content and pasted text are never included in these signals. Paste events record size and target
          path only.
        </p>
      </section>
    </div>
  );
}
