import { Modal } from './Modal';
import { Icon } from './Icon';

/**
 * In-app guide. CodePair has two roles — the host that runs the code and the
 * people who join — so the guide is split the same way and written for someone
 * who has never seen the tool before.
 */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="How to use CodePair"
      description="One machine runs the project; everyone else joins from a browser."
      onClose={onClose}
      size="lg"
      className="help"
      footer={
        <button className="button button--primary" onClick={onClose}>
          Got it
        </button>
      }
    >
      <section className="help__section">
        <h3 className="help__title">
          <Icon name="room" size={15} />
          Set up a session (host)
        </h3>
        <ol className="help__steps">
          <li>
            <strong>Install once.</strong> In the CodePair folder run <code>npm install</code>. Node 20 or newer is
            required.
          </li>
          <li>
            <strong>Start the host</strong> on the folder you want to share:
            <pre className="help__cmd">npm start -- --root ~/code/my-project</pre>
          </li>
          <li>
            <strong>Copy the printed link.</strong> The terminal shows a URL with a token and a matching QR code in the
            app's Share dialog. That link is the whole session.
          </li>
          <li>
            <strong>Share it out of band</strong> — message it directly. Anyone who opens it joins as a collaborator.
          </li>
          <li>
            <strong>Stop with Ctrl+C.</strong> The token dies with the process and everyone is disconnected.
          </li>
        </ol>
        <dl className="help__flags">
          <div>
            <dt>
              <code>--host 0.0.0.0</code>
            </dt>
            <dd>Accept devices on your network instead of only this machine.</dd>
          </div>
          <div>
            <dt>
              <code>--mode read-only</code>
            </dt>
            <dd>Guests can read and watch, but cannot edit or open a terminal.</dd>
          </div>
          <div>
            <dt>
              <code>--no-terminal</code>
            </dt>
            <dd>Keep file editing but refuse remote shells.</dd>
          </div>
          <div>
            <dt>
              <code>--port 7420</code>
            </dt>
            <dd>Change the listening port when 7420 is taken.</dd>
          </div>
        </dl>
        <p className="help__note">
          <Icon name="alert" size={14} />
          <span>
            The link is a credential: it allows editing these files and, unless you passed <code>--no-terminal</code>,
            running commands as your user. Use read-only mode for demos or public links.
          </span>
        </p>
      </section>

      <section className="help__section">
        <h3 className="help__title">
          <Icon name="users" size={15} />
          Join a session (everyone else)
        </h3>
        <ol className="help__steps">
          <li>
            <strong>Open the link</strong> the host sent you — on a laptop or a phone. On a phone you can also scan the
            QR code from the host's Share dialog.
          </li>
          <li>
            <strong>Paste the token</strong> if the access screen appears. It is stored in that tab only; closing the
            tab forgets it.
          </li>
          <li>
            <strong>Pick a file</strong> in the explorer on the left, or press <kbd>Ctrl</kbd>&nbsp;
            <kbd>P</kbd> (<kbd>⌘</kbd>&nbsp;<kbd>P</kbd> on macOS) to search by name.
          </li>
          <li>
            <strong>Edit away.</strong> Changes reach everyone in a moment and are written to the host's disk. Coloured
            cursors are other people, with their name above them.
          </li>
          <li>
            <strong>Use the terminal</strong> with <kbd>Ctrl</kbd>&nbsp;<kbd>`</kbd> — it runs on the host, so
            <code>npm run dev</code>, <code>python</code> and friends work as if you were sitting there.
          </li>
          <li>
            <strong>Talk over a call</strong> with the video button: microphone, camera and screen sharing all start
            only when you press them.
          </li>
        </ol>
      </section>

      <section className="help__section">
        <h3 className="help__title">
          <Icon name="info" size={15} />
          Good to know
        </h3>
        <ul className="help__list">
          <li>
            <strong>Saving is automatic.</strong> Edits are written shortly after you stop typing; <kbd>Ctrl</kbd>
            &nbsp;<kbd>S</kbd> forces it now.
          </li>
          <li>
            <strong>Host-side edits are pulled in.</strong> If someone changes a file outside the editor, the change
            appears here. If you had unsaved edits at the same time, yours are kept and you get a warning.
          </li>
          <li>
            <strong>Destructive actions ask first.</strong> Deleting or renaming a file shows a confirmation, and open
            tabs follow the file.
          </li>
          <li>
            <strong>Download</strong> exports a copy of the file you are editing.
          </li>
          <li>
            <strong>On a phone</strong> the file explorer opens from the menu icon, the terminal slides up as an
            overlay, and the editor fills the screen.
          </li>
          <li>
            <strong>Nothing is relayed.</strong> Your browser talks straight to the host machine; there is no cloud
            service in between.
          </li>
        </ul>
        <table className="help__keys">
          <caption>Keyboard shortcuts</caption>
          <tbody>
            <tr>
              <th scope="row">Quick open</th>
              <td>
                <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>P</kbd>
              </td>
            </tr>
            <tr>
              <th scope="row">Toggle terminal</th>
              <td>
                <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>`</kbd>
              </td>
            </tr>
            <tr>
              <th scope="row">Save now</th>
              <td>
                <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>S</kbd>
              </td>
            </tr>
            <tr>
              <th scope="row">Close dialog or drawer</th>
              <td>
                <kbd>Esc</kbd>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </Modal>
  );
}
