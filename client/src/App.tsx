import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiClient,
  ApiError,
  describeApiError,
  redeemInvite,
  type FileEntry,
  type LobbyStatus,
  type RedeemedInvite,
  type SessionInfo,
} from './lib/api';
import { baseName, languageForPath, parentDirectory } from './lib/language';
import { clearInviteHash, clearStoredToken, inviteFromHash, loadToken, roomFromPath, storeToken } from './lib/token';
import { rotateConnectionId } from './lib/connection';
import { currentPresence } from './lib/presence';
import { exportEditorFile } from './lib/download';
import { CallManager } from './lib/calls';
import type { CursorState, EditorStatus, Participant } from './lib/status';
import type { ToastKind } from './components/Toasts';
import { ToastStack, useToasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { FileTree } from './components/FileTree';
import { TabStrip } from './components/TabStrip';
import { EditorPane } from './components/EditorPane';
import { Welcome } from './components/Welcome';
import { TerminalPanel } from './components/TerminalPanel';
import { StatusBar } from './components/StatusBar';
import { TokenGate } from './components/TokenGate';
import { LobbyScreen, type LobbyGateView } from './components/LobbyScreen';
import { ConsentScreen } from './components/ConsentScreen';
import { CallDock } from './components/CallDock';
import { IntegrityReporter } from './lib/integrity';
import {
  DeleteDialog,
  NewEntryDialog,
  QuickOpenDialog,
  RenameDialog,
  ShareDialog,
} from './components/Dialogs';
import { HelpDialog } from './components/HelpDialog';
import { Icon, PairMark } from './components/Icon';

type SessionState = 'idle' | 'loading' | 'ready' | 'error';
type LobbyView = LobbyGateView | 'admitted';
type ConsentState = 'pending' | 'accepted' | 'declined';
type InviteState = 'idle' | 'redeeming' | 'error';

/**
 * StrictMode mounts App twice in development. Keep one redemption promise per
 * invite for the tab's lifetime so a maxUses:1 link cannot be consumed twice.
 */
const inviteRedemptions = new Map<string, Promise<RedeemedInvite>>();

function redeemInviteOnce(id: string, roomId: string | null): Promise<RedeemedInvite> {
  const key = `${roomId ?? ''}:${id}`;
  const existing = inviteRedemptions.get(key);
  if (existing) return existing;
  const pending = redeemInvite(id, roomId).catch((error: unknown) => {
    inviteRedemptions.delete(key);
    throw error;
  });
  inviteRedemptions.set(key, pending);
  return pending;
}

type ModalState =
  | { kind: 'share' }
  | { kind: 'quick-open' }
  | { kind: 'help' }
  | { kind: 'new-file'; parentDir: string }
  | { kind: 'new-folder'; parentDir: string }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'delete'; entry: FileEntry }
  | null;

export function App() {
  const [inviteId, setInviteId] = useState<string | null>(() => inviteFromHash());
  const [inviteState, setInviteState] = useState<InviteState>(() => (inviteFromHash() ? 'redeeming' : 'idle'));
  const [inviteError, setInviteError] = useState('');
  const [inviteAttempt, setInviteAttempt] = useState(0);
  const [token, setToken] = useState<string | null>(() => (inviteFromHash() ? null : loadToken()));
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [sessionError, setSessionError] = useState('');
  const [authError, setAuthError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [routeRoom, setRouteRoom] = useState<string | null>(() => roomFromPath(window.location.pathname));
  const [malformedRoom] = useState(() => window.location.pathname.startsWith('/room/') && roomFromPath(window.location.pathname) === null);
  const api = useMemo(
    () => (token ? new ApiClient(token, routeRoom ?? undefined) : null),
    [token, routeRoom],
  );

  useEffect(() => {
    if (!inviteId) return;
    let cancelled = false;
    setInviteState('redeeming');
    setInviteError('');
    redeemInviteOnce(inviteId, routeRoom)
      .then(({ token: nextToken }) => {
        if (cancelled) return;
        storeToken(nextToken);
        clearInviteHash();
        setToken(nextToken);
        setInviteId(null);
        setInviteState('idle');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setInviteError(describeApiError(error));
        setInviteState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [inviteId, inviteAttempt, routeRoom]);

  // Admission state. `checking` is the moment between "token accepted" and the
  // Host's answer; `admitted` is the only view that renders the workspace.
  const [lobbyView, setLobbyView] = useState<LobbyView>('checking');
  const [lobbyMessage, setLobbyMessage] = useState('');
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [consentState, setConsentState] = useState<ConsentState>('accepted');

  const applyLobbyStatus = useCallback((status: LobbyStatus) => {
    setLobbyMessage('');
    if (status.state === 'admitted') setLobbyView('admitted');
    else if (status.state === 'waiting') setLobbyView('waiting');
    else if (status.state === 'denied') setLobbyView('denied');
    else if (status.state === 'expired') setLobbyView('expired');
    else if (status.state === 'removed') setLobbyView('removed');
    else setLobbyView('checking');
  }, []);

  const applyLobbyError = useCallback((error: unknown) => {
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'LOBBY_LOCKED':
          setLobbyView('locked');
          return;
        case 'LOBBY_FULL':
          setLobbyView('full');
          return;
        case 'LOBBY_DENIED':
          setLobbyView('denied');
          return;
        case 'LOBBY_REMOVED':
          setLobbyView('removed');
          return;
        case 'LOBBY_EXPIRED':
          setLobbyView('expired');
          return;
        case 'LOBBY_WAITING':
          setLobbyView('waiting');
          return;
        default:
          break;
      }
      if (error.status === 401) {
        clearStoredToken();
        setToken(null);
        setSession(null);
        setSessionState('idle');
        setAuthError('That access token was rejected. Ask the host for a fresh link.');
        return;
      }
    }
    setLobbyView('checking');
    setLobbyMessage(describeApiError(error));
  }, []);

  useEffect(() => {
    if (!api || !session || sessionState !== 'ready') return;
    if (session.role === 'candidate' && consentState !== 'accepted') return;
    let cancelled = false;
    setLobbyView('checking');
    setLobbyMessage('');
    api
      .joinLobby(currentPresence().name, session.role === 'candidate')
      .then((status) => {
        if (!cancelled) applyLobbyStatus(status);
      })
      .catch((error: unknown) => {
        if (!cancelled) applyLobbyError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [api, session, sessionState, joinAttempt, consentState, applyLobbyStatus, applyLobbyError]);

  // While waiting, poll the cheap status route; it is reachable before admission.
  useEffect(() => {
    if (lobbyView !== 'waiting' || !api) return;
    const timer = window.setInterval(() => {
      api.lobbyStatus().then(applyLobbyStatus).catch(applyLobbyError);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [lobbyView, api, applyLobbyStatus, applyLobbyError]);

  const retryLobby = useCallback((freshIdentity: boolean) => {
    if (freshIdentity) rotateConnectionId();
    setJoinAttempt((value) => value + 1);
  }, []);

  // Keep the app exactly as tall as the visual viewport so the virtual keyboard
  // shrinks the workspace instead of hiding Monaco or the status bar.
  useEffect(() => {
    const apply = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
    };
    apply();
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      window.visualViewport?.removeEventListener('resize', apply);
      window.visualViewport?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, []);

  useEffect(() => {
    if (!token || !api) {
      setSession(null);
      setSessionState('idle');
      return;
    }
    const controller = new AbortController();
    setSessionState('loading');
    setSessionError('');
    // A fresh session (new token, reload after a switch) must ask again.
    setLobbyView('checking');
    setLobbyMessage('');
    api
      .session(controller.signal)
      .then((info) => {
        if (controller.signal.aborted) return;
        setSession(info);
        setSessionState('ready');
        setConsentState(
          info.role === 'candidate' && info.interview?.consentRequired ? 'pending' : 'accepted',
        );
        setAuthError('');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          clearStoredToken();
          setToken(null);
          setSession(null);
          setSessionState('idle');
          setAuthError('That access token was rejected. Ask the host for a fresh link.');
          return;
        }
        setSession(null);
        setSessionState('error');
        setSessionError(describeApiError(error));
      });
    return () => controller.abort();
  }, [api, token, retryKey]);

  const connect = (nextToken: string) => {
    storeToken(nextToken);
    setAuthError('');
    setToken(nextToken);
  };

  const lock = useCallback(() => {
    clearStoredToken();
    setToken(null);
    setSession(null);
    setSessionState('idle');
    setAuthError('');
    setRouteRoom(null);
    window.history.replaceState(null, '', '/');
  }, []);

  if (inviteState === 'redeeming') {
    return <BootScreen />;
  }

  if (inviteState === 'error') {
    return (
      <LobbyScreen
        view="invite"
        rootName="CodePair"
        displayName={currentPresence().name}
        message={inviteError}
        onRetry={() => setInviteAttempt((value) => value + 1)}
        onLeave={() => {
          clearInviteHash();
          setInviteId(null);
          setInviteState('idle');
          setInviteError('');
        }}
      />
    );
  }

  if (!token) {
    return <TokenGate onConnect={connect} error={authError} />;
  }

  if (sessionState === 'error') {
    return <ErrorScreen message={sessionError} onRetry={() => setRetryKey((value) => value + 1)} onReset={lock} />;
  }

  if (!session || sessionState !== 'ready' || !api) {
    return <BootScreen />;
  }

  if (malformedRoom) {
    return (
      <ErrorScreen
        message="That room link is not valid. Room links look like /room/ab12-cd34."
        onRetry={() => setRetryKey((value) => value + 1)}
        onReset={lock}
      />
    );
  }

  if (routeRoom && routeRoom !== session.roomId) {
    return (
      <ErrorScreen
        message={`This room link belongs to a different CodePair session (${routeRoom}). The host is currently serving room ${session.roomId}.`}
        onRetry={() => setRetryKey((value) => value + 1)}
        onReset={lock}
      />
    );
  }

  if (session.role === 'candidate' && consentState !== 'accepted') {
    return (
      <ConsentScreen
        rootName={session.rootName}
        items={session.interview?.consent ?? []}
        declined={consentState === 'declined'}
        onAccept={() => setConsentState('accepted')}
        onDecline={() => setConsentState('declined')}
        onLeave={lock}
      />
    );
  }

  if (lobbyView !== 'admitted') {
    return (
      <LobbyScreen
        view={lobbyView}
        rootName={session.rootName}
        displayName={currentPresence().name}
        message={lobbyMessage}
        onRetry={retryLobby}
        onLeave={lock}
      />
    );
  }

  const lostLobby = () => setRetryKey((value) => value + 1);

  return (
    <Workspace
      token={token}
      api={api}
      session={session}
      onLock={lock}
      onLobbyLost={lostLobby}
      roomId={routeRoom ?? session.roomId}
    />
  );
}

function Workspace({
  token,
  api,
  session,
  roomId,
  onLock,
  onLobbyLost,
}: {
  token: string;
  api: ApiClient;
  session: SessionInfo;
  roomId: string;
  onLock: () => void;
  onLobbyLost: () => void;
}) {
  const readOnly = !session.capabilities.includes('fs.write');
  const candidate = session.role === 'candidate';
  const terminalAvailable = candidate
    ? session.interview?.sandboxTerminalAvailable === true
    : session.capabilities.includes('term.use');
  const suggestionsEnabled = !candidate || session.interview?.monacoSuggestions !== false;
  const { toasts, push, dismiss } = useToasts();
  const self = useMemo(() => currentPresence(), []);
  const [childrenByDir, setChildrenByDir] = useState<Record<string, FileEntry[] | undefined>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [tabs, setTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<Record<string, EditorStatus>>({});
  const [presence, setPresence] = useState<Record<string, Participant[]>>({});
  const [cursors, setCursors] = useState<Record<string, CursorState>>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const tabsRef = useRef(tabs);
  const activeRef = useRef(activePath);
  const contentRef = useRef(new Map<string, () => string>());
  /** One toast per root switch, however many document sockets close. */
  const hostSwitchNotifiedRef = useRef(false);
  /** One toast per path the Host hid, until that tab is opened again. */
  const policyDeniedRef = useRef<Set<string>>(new Set());
  const integrityRef = useRef<IntegrityReporter | null>(null);
  tabsRef.current = tabs;
  activeRef.current = activePath;

  const notify = useCallback(
    (kind: ToastKind, message: string, detail?: string) => {
      push({ kind, message, detail });
    },
    [push],
  );

  const callManager = useMemo(
    () =>
      new CallManager({
        token,
        roomId,
        iceServers: session.rtc.iceServers,
        self,
        onToast: (kind, message, detail) => notify(kind, message, detail),
        onScreenShareSurface: (surface) => integrityRef.current?.reportScreenSurface(surface),
      }),
    [token, roomId, session.rtc.iceServers, self, notify],
  );

  useEffect(() => () => callManager.destroy(), [callManager]);

  // Candidate integrity evidence starts only after lobby admission, when the
  // workspace mounts. Nothing is attached on the consent screen.
  useEffect(() => {
    if (!candidate) return;
    const reporter = new IntegrityReporter(api, () => activeRef.current);
    reporter.attach();
    integrityRef.current = reporter;
    return () => {
      reporter.stop();
      reporter.detach();
      integrityRef.current = null;
    };
  }, [api, candidate]);

  // A seat can end while this tab is open (kick, deny, root switch). Document
  // sockets report 4425/4429 immediately; this slow poll is the net for tabs
  // with no document open, such as a terminal-only session.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void api
        .lobbyStatus()
        .then((status) => {
          if (status.enabled && status.state !== 'admitted') onLobbyLost();
        })
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.code === 'LOBBY_REMOVED') onLobbyLost();
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [api, onLobbyLost]);

  const activeStatus = activePath ? editorStatus[activePath] : undefined;
  const activeCursor = (activePath ? cursors[activePath] : undefined) ?? { line: 1, column: 1, selected: 0 };
  const connection = activePath ? (activeStatus?.connection ?? 'connecting') : 'ready';
  const participants = activePath ? (presence[activePath] ?? []) : [];
  const activeLanguage = activePath ? languageForPath(activePath) : 'plaintext';

  const loadDir = useCallback(
    async (dir: string): Promise<void> => {
      setLoadingDirs((previous) => new Set(previous).add(dir));
      try {
        const response = await api.tree(dir);
        setChildrenByDir((previous) => ({ ...previous, [dir]: response.entries }));
        if (response.truncated) notify('info', 'Large folder', 'Only the first 4,000 entries are shown.');
      } catch (error) {
        notify('error', 'Could not load files', describeApiError(error));
        throw error;
      } finally {
        setLoadingDirs((previous) => {
          const next = new Set(previous);
          next.delete(dir);
          return next;
        });
      }
    },
    [api, notify],
  );

  useEffect(() => {
    void loadDir('').catch(() => undefined);
  }, [loadDir]);

  const refreshTree = useCallback(async () => {
    const dirs = new Set(['', ...expanded]);
    await Promise.all([...dirs].map((dir) => loadDir(dir).catch(() => undefined)));
  }, [expanded, loadDir]);

  const toggleDir = useCallback(
    (dir: string) => {
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(dir)) {
          next.delete(dir);
        } else {
          next.add(dir);
          if (childrenByDir[dir] === undefined) void loadDir(dir).catch(() => undefined);
        }
        return next;
      });
    },
    [childrenByDir, loadDir],
  );

  const expandTo = useCallback(
    async (dir: string) => {
      const parts = dir.split('/').filter(Boolean);
      const dirs = [''];
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        dirs.push(current);
      }
      setExpanded((previous) => new Set([...previous, ...dirs]));
      await Promise.all(dirs.map((item) => loadDir(item).catch(() => undefined)));
    },
    [loadDir],
  );

  const removeTabs = useCallback((predicate: (path: string) => boolean) => {
    const currentTabs = tabsRef.current;
    const removed = currentTabs.filter(predicate);
    if (removed.length === 0) return;
    const nextTabs = currentTabs.filter((path) => !predicate(path));
    const currentActive = activeRef.current;
    let nextActive = currentActive;
    if (currentActive && predicate(currentActive)) {
      const index = currentTabs.indexOf(currentActive);
      nextActive = nextTabs[Math.min(index, Math.max(nextTabs.length - 1, 0))] ?? null;
    }
    tabsRef.current = nextTabs;
    activeRef.current = nextActive;
    setTabs(nextTabs);
    setActivePath(nextActive);
    setEditorStatus((previous) => removeKeys(previous, removed));
    setPresence((previous) => removeKeys(previous, removed));
    setCursors((previous) => removeKeys(previous, removed));
    for (const path of removed) contentRef.current.delete(path);
  }, []);

  const openPath = useCallback((path: string) => {
    // Reopening a tab re-arms its denial notice, so a later hide toasts again.
    policyDeniedRef.current.delete(path);
    const current = tabsRef.current;
    const next = current.includes(path) ? current : [...current, path];
    tabsRef.current = next;
    activeRef.current = path;
    setTabs(next);
    setActivePath(path);
    setSidebarOpen(false);
  }, []);

  const closeTab = useCallback((path: string) => removeTabs((candidate) => candidate === path), [removeTabs]);
  const closePathsUnder = useCallback(
    (prefix: string) => removeTabs((path) => path === prefix || path.startsWith(`${prefix}/`)),
    [removeTabs],
  );

  const handleStatus = useCallback((path: string, status: EditorStatus) => {
    setEditorStatus((previous) => {
      const current = previous[path];
      if (
        current &&
        current.connection === status.connection &&
        current.save === status.save &&
        current.savedAt === status.savedAt &&
        current.fatal?.code === status.fatal?.code
      ) {
        return previous;
      }
      return { ...previous, [path]: status };
    });
  }, []);

  const handlePresence = useCallback((path: string, next: Participant[]) => {
    setPresence((previous) => ({ ...previous, [path]: next }));
  }, []);

  const handleCursor = useCallback((path: string, cursor: CursorState) => {
    setCursors((previous) => {
      const current = previous[path];
      if (current && current.line === cursor.line && current.column === cursor.column && current.selected === cursor.selected) {
        return previous;
      }
      return { ...previous, [path]: cursor };
    });
  }, []);

  const registerContent = useCallback((path: string, getter: (() => string) | null) => {
    if (getter) contentRef.current.set(path, getter);
    else contentRef.current.delete(path);
  }, []);

  const handleFatal = useCallback(
    (path: string, message: string, code: number) => {
      if (code === 4425 || code === 4429) {
        // The tab lost its seat: close everything and go back through the lobby.
        removeTabs(() => true);
        onLobbyLost();
        return;
      }
      if (code === 4403) {
        // The Host removed access to this file. Close its tab and explain once
        // per path; this has its own dedupe, independent of the 4410 latch.
        closePathsUnder(path);
        if (policyDeniedRef.current.has(path)) return;
        policyDeniedRef.current.add(path);
        notify('error', message || 'The host removed access to this file.');
        return;
      }
      if (code !== 4410) return;
      closePathsUnder(path);
      if (hostSwitchNotifiedRef.current) return;
      hostSwitchNotifiedRef.current = true;
      // Re-arm, so a host that switches again without a reload still gets told.
      window.setTimeout(() => {
        hostSwitchNotifiedRef.current = false;
      }, 3000);
      const atRisk = Object.values(editorStatus).some((status) => status.save !== 'saved');
      notify(
        'info',
        'The host switched to a different project. Reload to continue.',
        atRisk ? 'Some changes in this tab may not have been saved; copy anything important before reloading.' : undefined,
      );
      void refreshTree();
    },
    [closePathsUnder, editorStatus, notify, onLobbyLost, refreshTree, removeTabs],
  );

  const createEntry = useCallback(
    async (path: string, type: 'file' | 'directory') => {
      await api.createFile(path, type);
      setModal(null);
      await expandTo(parentDirectory(path));
      notify('success', type === 'file' ? 'File created' : 'Folder created', path);
      if (type === 'file') {
        openPath(path);
      } else {
        setExpanded((previous) => new Set(previous).add(path));
        void loadDir(path).catch(() => undefined);
      }
    },
    [api, expandTo, loadDir, notify, openPath],
  );

  const renameEntry = useCallback(
    async (entry: FileEntry, to: string) => {
      const wasOpen = tabsRef.current.some((path) => path === entry.path);
      await api.rename(entry.path, to);
      closePathsUnder(entry.path);
      setModal(null);
      await Promise.all([expandTo(parentDirectory(to)), loadDir(parentDirectory(entry.path)).catch(() => undefined)]);
      notify('success', 'Renamed', `${entry.path} → ${to}`);
      if (wasOpen && entry.type === 'file') openPath(to);
    },
    [api, closePathsUnder, expandTo, loadDir, notify, openPath],
  );

  const deleteEntry = useCallback(
    async (entry: FileEntry) => {
      await api.remove(entry.path);
      closePathsUnder(entry.path);
      setModal(null);
      await loadDir(parentDirectory(entry.path)).catch(() => undefined);
      notify('success', 'Deleted', entry.path);
    },
    [api, closePathsUnder, loadDir, notify],
  );

  const downloadActive = useCallback(() => {
    const path = activeRef.current;
    if (!path) {
      notify('warning', 'No file open', 'Open a file before downloading.');
      return;
    }
    const getter = contentRef.current.get(path);
    if (!getter) {
      notify('warning', 'Editor not ready', 'Try again once the file has finished loading.');
      return;
    }
    const fileName = exportEditorFile(path, getter());
    notify('success', 'Downloaded', fileName);
  }, [notify]);

  const toggleTerminal = useCallback(() => {
    if (!terminalAvailable) {
      notify(
        'warning',
        candidate ? 'Sandbox terminal unavailable' : readOnly ? 'Read-only session' : 'Terminal unavailable',
        candidate
          ? 'The Docker sandbox could not be started, so the candidate terminal is disabled.'
          : readOnly
            ? 'The terminal is disabled because this session only allows reading.'
            : 'The host started CodePair with the terminal disabled.',
      );
      return;
    }
    setTerminalOpen((open) => !open);
    setSidebarOpen(false);
  }, [notify, readOnly, terminalAvailable, candidate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'p' && !event.shiftKey) {
          event.preventDefault();
          setModal({ kind: 'quick-open' });
          return;
        }
        if (event.code === 'Backquote') {
          event.preventDefault();
          toggleTerminal();
          return;
        }
      }
      if (event.key === 'Escape' && sidebarOpen) setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen, toggleTerminal]);

  useEffect(() => {
    document.title = activePath ? `${baseName(activePath)} · CodePair` : `${session.rootName} · CodePair`;
  }, [activePath, session.rootName]);

  const hasAtRiskChanges = Object.values(editorStatus).some(
    (status) =>
      status.save === 'saving' ||
      status.save === 'error' ||
      status.connection === 'offline' ||
      status.connection === 'reconnecting',
  );

  useEffect(() => {
    if (!hasAtRiskChanges) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasAtRiskChanges]);

  useEffect(() => {
    const offline = () => notify('warning', 'You are offline', 'Edits are kept in this tab and merge when the host returns.');
    const online = () => notify('success', 'Connection restored');
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [notify]);

  const rootFiles = (childrenByDir[''] ?? []).filter((entry) => entry.type === 'file');
  const terminalEnabled = terminalAvailable && !readOnly;

  return (
    <div className={`app${readOnly ? ' app--readonly' : ''}`}>
      <TopBar
        rootName={session.rootName}
        roomId={roomId}
        mode={session.mode}
        connection={connection}
        participants={participants.length > 0 ? participants : [{ ...self, id: -1, self: true }]}
        terminalOpen={terminalOpen}
        terminalEnabled={terminalEnabled}
        sidebarOpen={sidebarOpen}
        callOpen={callOpen}
        canDownload={Boolean(activePath)}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onOpenSearch={() => setModal({ kind: 'quick-open' })}
        onToggleCall={() => setCallOpen((open) => !open)}
        onDownload={downloadActive}
        onOpenShare={() => setModal({ kind: 'share' })}
        onToggleTerminal={toggleTerminal}
        onOpenHelp={() => setModal({ kind: 'help' })}
        onLock={onLock}
      />

      <a className="skip-link" href="#editor-stack">Skip to editor</a>

      <div className="workspace">
        <FileTree
          rootName={session.rootName}
          readOnly={readOnly}
          mobileOpen={sidebarOpen}
          childrenByDir={childrenByDir}
          expanded={expanded}
          loadingDirs={loadingDirs}
          activePath={activePath}
          onCloseMobile={() => setSidebarOpen(false)}
          onToggleDir={toggleDir}
          onOpenFile={openPath}
          onRefresh={() => void refreshTree()}
          onNewFile={(parentDir) => setModal({ kind: 'new-file', parentDir })}
          onNewFolder={(parentDir) => setModal({ kind: 'new-folder', parentDir })}
          onRename={(entry) => setModal({ kind: 'rename', entry })}
          onDelete={(entry) => setModal({ kind: 'delete', entry })}
        />

        <main className="main">
          <TabStrip
            tabs={tabs.map((path) => ({ path, status: editorStatus[path] }))}
            activePath={activePath}
            onSelect={openPath}
            onClose={closeTab}
            onQuickOpen={() => setModal({ kind: 'quick-open' })}
          />

          <div className="editorStack" id="editor-stack">
            {tabs.length === 0 || !activePath ? (
              <Welcome
                rootName={session.rootName}
                readOnly={readOnly}
                files={rootFiles}
                onOpenFile={openPath}
                onQuickOpen={() => setModal({ kind: 'quick-open' })}
                onShare={() => setModal({ kind: 'share' })}
                onHelp={() => setModal({ kind: 'help' })}
              />
            ) : (
              tabs.map((path) => (
                <EditorPane
                  key={path}
                  token={token}
                  roomId={roomId}
                  path={path}
                  active={path === activePath}
                  readOnly={readOnly}
                  suggestionsEnabled={suggestionsEnabled}
                  onStatus={handleStatus}
                  onPresence={handlePresence}
                  onCursor={handleCursor}
                  onFatal={handleFatal}
                  onToast={(kind, message, detail) => notify(kind, message, detail)}
                  registerContent={registerContent}
                />
              ))
            )}
          </div>

          {terminalOpen ? (
            <TerminalPanel token={token} roomId={roomId} rootName={session.rootName} onClose={() => setTerminalOpen(false)} onToast={(kind, message, detail) => notify(kind, message, detail)} />
          ) : null}

          <StatusBar
            activePath={activePath}
            language={activeLanguage}
            cursor={activeCursor}
            mode={session.mode}
            save={activeStatus?.save ?? 'saved'}
            savedAt={activeStatus?.savedAt}
            terminalOpen={terminalOpen}
            terminalEnabled={terminalEnabled}
            onToggleTerminal={toggleTerminal}
          />
        </main>
      </div>

      <CallDock manager={callManager} open={callOpen} onOpenChange={setCallOpen} />
      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {modal?.kind === 'share' ? (
        <ShareDialog
          token={token}
          roomId={roomId}
          rootName={session.rootName}
          readOnly={readOnly}
          onClose={() => setModal(null)}
          onLock={onLock}
          onToast={(kind, message, detail) => notify(kind, message, detail)}
        />
      ) : null}

      {modal?.kind === 'quick-open' ? (
        <QuickOpenDialog api={api} onOpen={openPath} onClose={() => setModal(null)} />
      ) : null}

      {modal?.kind === 'help' ? <HelpDialog onClose={() => setModal(null)} /> : null}

      {modal?.kind === 'new-file' || modal?.kind === 'new-folder' ? (
        <NewEntryDialog
          kind={modal.kind === 'new-file' ? 'file' : 'folder'}
          parentDir={modal.parentDir}
          onClose={() => setModal(null)}
          onCreate={(path) => createEntry(path, modal.kind === 'new-file' ? 'file' : 'directory')}
        />
      ) : null}

      {modal?.kind === 'rename' ? (
        <RenameDialog entry={modal.entry} onClose={() => setModal(null)} onRename={(to) => renameEntry(modal.entry, to)} />
      ) : null}

      {modal?.kind === 'delete' ? (
        <DeleteDialog entry={modal.entry} onClose={() => setModal(null)} onDelete={() => deleteEntry(modal.entry)} />
      ) : null}
    </div>
  );
}

function BootScreen() {
  return (
    <div className="bootScreen">
      <div className="bootScreen__mark">
        <PairMark size={34} />
      </div>
      <p className="bootScreen__title">Connecting to your host</p>
      <p className="bootScreen__text">Verifying the access token in this tab.</p>
      <span className="bootScreen__line" aria-hidden="true" />
    </div>
  );
}

function ErrorScreen({ message, onRetry, onReset }: { message: string; onRetry: () => void; onReset: () => void }) {
  return (
    <div className="bootScreen">
      <div className="bootScreen__mark bootScreen__mark--error">
        <Icon name="wifi-off" size={24} />
      </div>
      <p className="bootScreen__title">Cannot open this session</p>
      <p className="bootScreen__text">{message || 'Check that the CodePair host is still running.'}</p>
      <div className="bootScreen__actions">
        <button className="button button--primary" onClick={onRetry}>Try again</button>
        <button className="button button--ghost" onClick={onReset}>Use a different link</button>
      </div>
    </div>
  );
}

function removeKeys<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  if (keys.length === 0) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}
