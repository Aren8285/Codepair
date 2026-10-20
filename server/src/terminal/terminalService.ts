import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { PathGuard } from '../security/pathGuard.js';
import { cleanupShellSetup, createShellSetup, type ShellSetup } from './shellEnv.js';

const MAX_INPUT_CHARS = 64 * 1024;
const WS_OPEN = 1;

interface TerminalOptions {
  enabled: boolean;
  readOnly: boolean;
  logger?: Pick<Console, 'error' | 'warn'>;
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

  constructor(
    private readonly guard: PathGuard,
    private readonly options: TerminalOptions,
  ) {
    this.logger = options.logger ?? console;
    if (options.enabled && !options.readOnly) {
      try {
        this.setup = createShellSetup(guard.root);
      } catch (error) {
        this.logger.error('[codepair] failed to prepare the terminal shell:', error);
      }
    }
  }

  handle(socket: WebSocket): void {
    if (this.disposed) {
      socket.close(1001, 'Server is shutting down.');
      return;
    }
    if (!this.options.enabled) {
      socket.close(4403, 'The terminal is disabled on this server.');
      return;
    }
    if (this.options.readOnly) {
      socket.close(4403, 'The terminal is disabled in read-only mode.');
      return;
    }
    if (!this.setup) {
      socket.close(4500, 'The terminal could not be started.');
      return;
    }

    let terminal: pty.IPty;
    try {
      terminal = pty.spawn(this.setup.shell, this.setup.args, {
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

    const session: TerminalSession = { socket, process: terminal, closed: false };
    this.sessions.add(session);

    const rootName = this.guard.root.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
    this.send(session, { type: 'ready', shell: this.setup.shellName, rootName });
    this.sendOutput(
      session,
      `\r\n\u001b[38;5;39mCodePair\u001b[0m \u001b[38;5;242mterminal\u001b[0m\r\n` +
        `\u001b[38;5;242mProject: ${rootName}\u001b[0m\r\n` +
        `\u001b[38;5;242mThe shell starts in the project root. It is a real PTY on the host.\u001b[0m\r\n\r\n`,
    );

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

  dispose(): void {
    this.disposed = true;
    for (const session of [...this.sessions]) {
      session.closed = true;
      try {
        session.process.kill();
      } catch {
        // Already exited.
      }
      try {
        session.socket.close(1001, 'Server is shutting down.');
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
