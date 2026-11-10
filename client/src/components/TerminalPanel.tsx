import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Icon } from './Icon';
import { currentConnectionId } from '../lib/connection';

type TerminalStatus = 'connecting' | 'ready' | 'exited' | 'offline';

interface TerminalPanelProps {
  token: string;
  rootName: string;
  onClose: () => void;
  onToast: (kind: 'success' | 'error' | 'info' | 'warning', message: string, detail?: string) => void;
}

export function TerminalPanel({ token, rootName, onClose, onToast }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const statusRef = useRef<TerminalStatus>('connecting');
  const setTerminalStatus = (next: TerminalStatus) => {
    statusRef.current = next;
    setStatus(next);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: {
        background: '#080f16',
        foreground: '#dbe3ee',
        cursor: '#7c8cf8',
        cursorAccent: '#08111a',
        selectionBackground: '#2b3f5a',
        black: '#0b131c',
        red: '#f28f8f',
        green: '#6fd08c',
        yellow: '#f2b880',
        blue: '#7c8cf8',
        magenta: '#e59ad8',
        cyan: '#76c7e8',
        white: '#dbe3ee',
        brightBlack: '#5b6b80',
        brightRed: '#ffb3b3',
        brightGreen: '#9fe6b5',
        brightYellow: '#ffd3a3',
        brightBlue: '#aab6ff',
        brightMagenta: '#f3c1e8',
        brightCyan: '#a3e0f5',
        brightWhite: '#f4f8fd',
      },
      fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: 4000,
      allowProposedApi: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    termRef.current = term;
    fitRef.current = fit;

    // Open on the next frame: React StrictMode mounts, disposes, then mounts
    // again, and disposing an xterm that has already opened leaves a queued
    // render callback that throws on the disposed core.
    let disposed = false;
    const openFrame = window.requestAnimationFrame(() => {
      if (disposed) return;
      term.open(host);
      fit.fit();
      term.focus();
    });

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(
        `${protocol}//${window.location.host}/ws/terminal?cid=${encodeURIComponent(currentConnectionId())}`,
        ['codepair', token],
      );
    } catch {
      term.writeln('\r\n\x1b[31mCould not open the terminal socket.\x1b[0m');
      setTerminalStatus('offline');
      return () => {
        disposed = true;
        window.cancelAnimationFrame(openFrame);
        term.dispose();
        termRef.current = null;
      };
    }
    socketRef.current = socket;

    socket.onopen = () => setTerminalStatus('connecting');
    socket.onmessage = (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === 'ready') {
        setTerminalStatus('ready');
      } else if (message.type === 'output' && typeof message.data === 'string') {
        term.write(message.data);
      } else if (message.type === 'exit') {
        setTerminalStatus('exited');
        term.writeln(`\r\n\x1b[38;5;242m[process exited with code ${String(message.exitCode ?? 0)}]\x1b[0m`);
      }
    };
    socket.onclose = () => {
      if (statusRef.current !== 'exited') {
        setTerminalStatus('offline');
        term.writeln('\r\n\x1b[38;5;242m[connection closed]\x1b[0m');
      }
    };
    socket.onerror = () => {
      if (statusRef.current === 'connecting') {
        onToast('error', 'Terminal connection failed', 'The host may have disabled the terminal.');
      }
    };

    const input = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });

    let resizeTimer = 0;
    const sendResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (disposed) return;
        try {
          fit.fit();
          if (socket.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
            socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        } catch {
          // Host not visible yet.
        }
      }, 60);
    };
    const observer = new ResizeObserver(sendResize);
    observer.observe(host);
    sendResize();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(openFrame);
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      input.dispose();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, 'Terminal closed.');
      } catch {
        // ignore
      }
      term.dispose();
      termRef.current = null;
      socketRef.current = null;
    };
    // The terminal is tied to the panel's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const label = status === 'ready' ? 'Connected' : status === 'connecting' ? 'Connecting' : status === 'exited' ? 'Exited' : 'Offline';

  return (
    <section className="terminalPanel" aria-label="Terminal">
      <header className="terminalPanel__header">
        <div className="terminalPanel__identity">
          <span className={`connection__dot connection__dot--${status === 'ready' ? 'live' : status === 'connecting' ? 'pending' : 'offline'}`} />
          <span className="terminalPanel__title">Terminal</span>
          <span className="terminalPanel__meta">{rootName} · {label}</span>
        </div>
        <div className="terminalPanel__actions">
          <button
            className="terminalButton"
            title="Clear terminal"
            onClick={() => termRef.current?.clear()}
            aria-label="Clear terminal"
          >
            Clear
          </button>
          <button className="icon-button" onClick={onClose} title="Close terminal" aria-label="Close terminal">
            <Icon name="close" size={15} />
          </button>
        </div>
      </header>
      <div className="terminalPanel__body">
        <div className="terminalPanel__xterm" ref={hostRef} />
      </div>
    </section>
  );
}
