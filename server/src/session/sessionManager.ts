import { AppError } from '../errors.js';
import { assertSwitchable, resolveHostDirectory } from './hostPaths.js';
import { createSession, type Session, type SessionOptions } from './session.js';

/** Close code a socket gets when the Host moves the session to another root. */
export const SWITCH_CLOSE_CODE = 4410;
export const SWITCH_CLOSE_REASON = 'The host switched to a different project.';

export interface SwitchOptions {
  confirmBroad?: boolean;
}

export interface SwitchResult {
  changed: boolean;
  session: Session;
  /** Relative paths whose flush failed while disposing the old session. */
  flushErrors: string[];
}

/**
 * Holds exactly one active session.
 *
 * Switching is serialised: concurrent calls run one after another, in call
 * order, so two switches can never interleave their build/swap/dispose phases.
 */
export class SessionManager {
  private active: Session;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    initialRoot: string,
    private readonly options: SessionOptions,
  ) {
    this.active = createSession(initialRoot, options);
  }

  /** Resolve the session for one request or connection; call it once. */
  current(): Session {
    if (this.disposed) throw new AppError(503, 'SHUTTING_DOWN', 'The server is shutting down.');
    return this.active;
  }

  switchRoot(target: string, options: SwitchOptions = {}): Promise<SwitchResult> {
    const run = () => this.doSwitch(target, options);
    // Chain on both settled outcomes so one failed switch cannot wedge the queue.
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async doSwitch(target: string, options: SwitchOptions): Promise<SwitchResult> {
    if (this.disposed) throw new AppError(503, 'SHUTTING_DOWN', 'The server is shutting down.');

    // 1. Validate the new path. Any failure leaves the current session intact.
    const canonical = await assertSwitchable(target, { confirmBroad: options.confirmBroad === true });

    // 2. Same root: nothing to do, nothing to close.
    if (canonical === this.active.root) {
      return { changed: false, session: this.active, flushErrors: [] };
    }

    // 3. Build the replacement first, so a construction failure changes nothing.
    const next = createSession(canonical, this.options);

    // 4. Swap atomically: new requests resolve the new session from here on.
    const previous = this.active;
    this.active = next;

    // 5. Dispose the old session: flush to the OLD absolute paths, stop pollers
    //    and timers, kill PTYs, remove rc dirs, close doc/terminal sockets with
    //    4410. Signalling lives outside the session and stays connected.
    const { flushErrors } = await previous.documents.dispose({
      closeCode: SWITCH_CLOSE_CODE,
      reason: SWITCH_CLOSE_REASON,
    });
    previous.terminals.dispose({ closeCode: SWITCH_CLOSE_CODE, reason: SWITCH_CLOSE_REASON });

    return { changed: true, session: next, flushErrors };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.active.documents.dispose();
    this.active.terminals.dispose();
  }
}

export { resolveHostDirectory };
