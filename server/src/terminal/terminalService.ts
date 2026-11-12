import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { PathGuard } from '../security/pathGuard.js';
import { can, type Principal } from '../security/principal.js';
import { cleanupShellSetup, createShellSetup, type ShellSetup } from './shellEnv.js';
import {
  buildInterviewSandboxInvocation,
  normalizeCandidateDir,
  type InterviewSandboxStatus,
} from './interviewSandbox.js';

export type TerminalSpawn = typeof pty.spawn;

const MAX_INPUT_CHARS = 64 * 1024;
const WS_OPEN = 1;

interface TerminalOptions {
  /** Server-wide feature flag: `--no-terminal` wins over any principal. */
  enabled: boolean;
  logger?: Pick<Console, 'error' | 'warn'>;
  /** Candidate sandbox availability and the writable subdirectory. */
  sandbox?: InterviewSandboxStatus;
  sandboxCandidateDir?: string;
  /** Test seam for the normal host PTY path. */
  spawn?: TerminalSpawn;
  /** Test seam for the candidate sandbox path. */
  sandboxSpawn?: TerminalSpawn;
}

interface TerminalSession {
  socket: WebSocket;
  process: pty.IPty;
  closed: boolean;
}

/**
 * Each browser tab gets its own interactive shell. A real PTY is used, so
 * compilers, REPLs and full-screen programs behave normally.
 *
 * Isolation: the shell starts in the project root and the generated rc files
 * override `cd`/`pushd` to refuse leaving it, hide host history and scrub the
 * environment. This is *defence in depth and UX guidance*, not an OS sandbox:
 * an authenticated remote operator still has the Host user's OS privileges.
 */
export class TerminalService {
  private readonly sessions = new Set<TerminalSession>();
  private readonly setup: ShellSetup | undefined;
  private readonly logger: Pick<Console, 'error' | 'warn'>;
  private disposed = false;
  private closeCode = 1001;
  private closeReason = 'Server is shutting down.';

  constructor(
    private readonly guard: PathGuard,
    private readonly options: TerminalOptions,
  ) {
    this.logger = options.logger ?? console;
    if (options.enabled) {
      try {
        this.setup = createShellSetup(guard.root);
      } catch (error) {
        this.logger.error('[codepair] failed to prepare the terminal shell:', error);
      }
    }
  }

  handle(socket: WebSocket, principal: Principal): void {
    if (this.disposed) {
      // Checked first: a socket that resolved this session before a root swap
      // never spawns a shell in a session that is being torn down.
      socket.close(this.closeCode, this.closeReason);
      return;
    }
    if (!this.options.enabled) {
      socket.close(4403, 'The terminal is disabled on this server.');
      return;
    }

    let terminal: pty.IPty;
    let shellName: string;
    let intro: string;

    if (principal.role === 'candidate') {
      // Categorically separate from the host terminal: a candidate gets a
      // sandboxed shell or nothing. There is no fall-through to `term.use` or
      // to the host PTY. This branch is intentionally before both checks.
      if (!this.options.sandbox?.available) {
        socket.close(
          4403,
          this.options.sandbox?.reason
            ? `The sandboxed interview terminal is unavailable: ${this.options.sandbox.reason}`
            : 'The sandboxed interview terminal is unavailable.',
        );
        return;
      }
      let candidateDir: string;
      let invocation;
      try {
        candidateDir = normalizeCandidateDir(this.options.sandboxCandidateDir ?? 'solution');
        invocation = buildInterviewSandboxInvocation({
          root: this.guard.root,
          candidateDir,
          image: this.options.sandbox.image,
        });
      } catch (error) {
        this.logger.error('[codepair] invalid interview sandbox specification:', error);
        socket.close(4403, 'The sandboxed interview terminal is unavailable.');
        return;
      }
      try {
        const spawn = this.options.sandboxSpawn ?? pty.spawn;
        terminal = spawn(invocation.file, invocation.args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: this.guard.root,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
      } catch (error) {
        this.logger.error('[codepair] interview sandbox spawn failed:', error);
        socket.close(4403, 'The sandboxed interview terminal could not be started.');
        return;
      }
      shellName = 'docker';
      intro =
        `\r\n\u001b[38;5;39mCodePair\u001b[0m \u001b[38;5;242msandboxed interview terminal\u001b[0m\r\n` +
        `\u001b[38;5;242mNo network. Only ${candidateDir}/ is writable; the rest of the project is read-only.\u001b[0m\r\n` +
        `\u001b[38;5;242mThis container is removed when the terminal closes.\u001b[0m\r\n\r\n`;
    } else {
      // Checked before `pty.spawn` below, so a principal without term.use never
      // creates a child process.
      // TODO(iter2): generic permission message
      if (!can(principal, 'term.use')) {
        socket.close(4403, 'The terminal is disabled in read-only mode.');
        return;
      }
      if (!this.setup) {
        socket.close(4500, 'The terminal could not be started.');
        return;
      }
      try {
        // Deliberately resolved at spawn time so the existing node-pty spy in the
        // terminal tests still observes the normal host path.
        const spawn = this.options.spawn ?? pty.spawn;
        terminal = spawn(this.setup.shell, this.setup.args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: this.guard.root,
          env: this.setup.env,
        });
      } catch (error) {
        this.logger.error('[codepair] PTY spawn failed:', error);
        socket.close(4500, 'The terminal could not be started.');
        return;
      }
      shellName = this.setup.shellName;
      intro =
        `\r\n\u001b[38;5;39mCodePair\u001b[0m \u001b[38;5;242mterminal\u001b[0m\r\n` +
        `\u001b[38;5;242mThe shell starts in the project root. It is a real PTY on the host.\u001b[0m\r\n\r\n`;
    }

    const session: TerminalSession = { socket, process: terminal, closed: false };
    this.sessions.add(session);

    const rootName = this.guard.root.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
    this.send(session, { type: 'ready', shell: shellName, rootName });
    this.sendOutput(session, intro);

    terminal.onData((data) => this.sendOutput(session, data));

    terminal.onExit(({ exitCode, signal }) => {
      if (session.closed) return;
      this.send(session, { type: 'exit', exitCode, signal });
      session.closed = true;
      this.sessions.delete(session);
      socket.close(1000, 'Shell exited.');
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (message.type === 'input' && typeof message.data === 'string') {
        if (message.data.length > MAX_INPUT_CHARS) return;
        terminal.write(message.data);
      } else if (message.type === 'resize') {
        const cols = Number(message.cols);
        const rows = Number(message.rows);
        if (Number.isInteger(cols) && Number.isInteger(rows)) {
          terminal.resize(clamp(cols, 2, 500), clamp(rows, 1, 300));
        }
      } else if (message.type === 'ping') {
        this.send(session, { type: 'pong' });
      }
    });

    socket.on('close', () => {
      session.closed = true;
      this.sessions.delete(session);
      try {
        terminal.kill();
      } catch {
        // Already exited.
      }
    });
    socket.on('error', () => {
      // close performs cleanup
    });
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  /** Directory holding the generated rc files; removed by `dispose`. */
  get shellSetupDir(): string | undefined {
    return this.setup?.rcDir;
  }

  /** GO 1 stub: exposed for the session payload in GO 2. */
  get interviewSandbox(): InterviewSandboxStatus | undefined {
    return this.options.sandbox;
  }

  dispose(options: { closeCode?: number; reason?: string } = {}): void {
    this.closeCode = options.closeCode ?? 1001;
    this.closeReason = options.reason ?? 'Server is shutting down.';
    this.disposed = true;
    for (const session of [...this.sessions]) {
      session.closed = true;
      try {
        session.process.kill();
      } catch {
        // Already exited.
      }
      try {
        session.socket.close(this.closeCode, this.closeReason);
      } catch {
        session.socket.terminate();
      }
    }
    this.sessions.clear();
    cleanupShellSetup(this.setup);
  }

  private sendOutput(session: TerminalSession, output: string): void {
    this.send(session, { type: 'output', data: output });
  }

  private send(session: TerminalSession, payload: Record<string, unknown>): void {
    if (session.socket.readyState !== WS_OPEN) return;
    try {
      session.socket.send(JSON.stringify(payload));
    } catch {
      // Socket closed mid-send; close handler cleans up.
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
