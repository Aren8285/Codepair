import { useState, type FormEvent } from 'react';
import { parseAccessInput } from '../lib/token';
import { Icon, PairMark } from './Icon';

export function TokenGate({ onConnect, error }: { onConnect: (token: string) => void; error?: string }) {
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const token = parseAccessInput(value);
    if (!token) {
      setLocalError('Paste the access link or the 43-character token from the host.');
      return;
    }
    setLocalError('');
    onConnect(token);
  };

  return (
    <div className="gate">
      <section className="gate__intro">
        <div className="gate__brand">
          <span className="gate__mark">
            <PairMark size={30} />
          </span>
          <span>CodePair</span>
        </div>
        <p className="gate__eyebrow">Local-first collaborative IDE</p>
        <h1 className="gate__headline">
          Your project,
          <br />
          within reach.
        </h1>
        <p className="gate__lede">
          A direct, local-first coding environment. Files, editor and terminal stay on the host machine;
          this browser is just the window.
        </p>
        <ul className="gate__points">
          <li>
            <Icon name="lock" size={15} />
            Token-scoped access, generated on every start.
          </li>
          <li>
            <Icon name="folder" size={15} />
            Filesystem access is contained to the shared folder.
          </li>
          <li>
            <Icon name="users" size={15} />
            Concurrent edits converge with CRDT sync.
          </li>
        </ul>
        <p className="gate__foot">Host and client talk directly. Nothing is relayed through a cloud service.</p>
      </section>

      <section className="gate__panel" aria-labelledby="gate-title">
        <p className="gate__panel-eyebrow">Access</p>
        <h2 id="gate-title">Open your session</h2>
        <p className="gate__panel-lede">Paste the access link from your host, or the token printed in its terminal.</p>
        <form onSubmit={submit} className="gate__form">
          <label className="field-label" htmlFor="token-input">
            Access link or token
          </label>
          <input
            id="token-input"
            data-autofocus
            className="text-input text-input--mono"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setLocalError('');
            }}
            placeholder="http://192.168.1.20:7420/room/…  or  IFOX4LE6…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(localError || error)}
          />
          {localError || error ? (
            <p className="field-error" role="alert">
              <Icon name="alert" size={14} />
              {localError || error}
            </p>
          ) : null}
          <button className="button button--primary gate__submit" type="submit">
            Connect to host
          </button>
        </form>
        <p className="gate__note">The token stays in this tab. Closing it, or stopping the host, revokes your access.</p>
        <p className="gate__version">Local-first · v0.4.0</p>
      </section>
    </div>
  );
}
