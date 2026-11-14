import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { createAdminApp } from './admin/adminApp.js';
import { ConfigError, assertTurnConfig, generateToken, terminalBypassesRules, type ServerConfig } from './config.js';
import { AppError, badRequest, unauthorized, toErrorPayload } from './errors.js';
import { mintTurnCredential } from './webrtc/turnCredentials.js';
import { DEFAULT_IGNORED } from './files/fileService.js';
import { ConnectionRegistry } from './lobby/connections.js';
import {
  LOBBY_CLOSE_CODE,
  LOBBY_DENIED_REASON,
  LOBBY_EXPIRED_REASON,
  LOBBY_REMOVED_REASON,
  LOBBY_WAITING_REASON,
  isConnectionId,
  type LobbyStatus,
} from './lobby/lobby.js';
import { seatPrincipal } from './lobby/principal.js';
import {
  WS_PROTOCOL,
  createAuthenticator,
  extractHost,
  isOriginAllowed,
  tokenFromAuthorizationHeader,
  tokenFromWebSocketHeader,
  type Authenticator,
  TokenStore,
} from './security/auth.js';
import { CAPABILITY_GATE, requireCap } from './security/gate.js';
import { securityHeaders } from './security/headers.js';
import { CAPABILITIES, can, type Principal } from './security/principal.js';
import { SandboxError, type PathGuard } from './security/pathGuard.js';
import type { Session } from './session/session.js';
import { RoomRegistry, type Room } from './rooms/roomRegistry.js';
import { createTunnelState, type TunnelStatus } from './tunnelStatus.js';
import { probeInterviewSandbox, type InterviewSandboxStatus } from './terminal/interviewSandbox.js';
import type { TerminalSpawn } from './terminal/terminalService.js';
import {
  MAX_EVENT_BATCH,
  type DisplaySurface,
  type IntegrityEventInput,
  type IntegrityEventType,
} from './interview/interviewStore.js';

export { CAPABILITY_GATE, requireCap };
export type { CapabilityGate } from './security/gate.js';

export const SERVER_VERSION = '0.8.0';

declare global {
  namespace Express {
    interface Request {
      room?: Room;
    }
  }
}
const MAX_WS_PAYLOAD = 2 * 1024 * 1024;

/** Tags the `/api` authentication middleware (route audit). */
export const API_AUTHENTICATION: unique symbol = Symbol.for('codepair.apiAuthentication');

export interface CodepairServer {
  readonly app: express.Express;
  readonly httpServer: http.Server;
  /** Path guard of the active session (convenience for the banner and tests). */
  readonly guard: PathGuard;
  readonly root: string;
  readonly config: ServerConfig;
  readonly startedAt: number;
  readonly sessions: RoomRegistry;
  /** Loopback-only Host console listener. */
  readonly admin: {
    readonly token: string;
    readonly port: number;
    readonly app: express.Express;
    readonly httpServer: http.Server;
  };
  start(port?: number, host?: string): Promise<{ port: number; host: string; adminPort: number }>;
  close(): Promise<void>;
}

export interface CreateServerOptions {
  /**
   * Test seam only: replaces the guest token→principal lookup so a gate can be
   * driven with a principal no role produces. Production always builds the
   * authenticator from the configured tokens.
   */
  authenticate?: Authenticator;
  /** Test seam: snapshot source for the admin tunnel status. */
  tunnelStatus?: () => TunnelStatus;
  /** Test seam: clock used by the session's invite store. */
  inviteNow?: () => number;
  /** Test seam: injectable Docker probe; never installs or pulls Docker. */
  sandboxProbe?: (image: string) => Promise<InterviewSandboxStatus>;
  /** Test seams for the normal and candidate terminal spawn paths. */
  terminalSpawn?: TerminalSpawn;
  sandboxSpawn?: TerminalSpawn;
}

export async function createCodepairServer(
  config: ServerConfig,
  options: CreateServerOptions = {},
): Promise<CodepairServer> {
  // Eager startup validation for programmatic callers that bypass parseConfig.
  assertTurnConfig(config);
  const startedAt = Date.now();

  const ignored = new Set(DEFAULT_IGNORED);
  for (const name of (process.env.CODE_PAIR_IGNORE ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    ignored.add(name);
  }

  // Daemon-level socket registry: a kick must still reach a tab's sockets after
  // a root switch, when its seat lived in the disposed session's lobby.
  const connections = new ConnectionRegistry();
  const track = (webSocket: WebSocket, roomId: string, connectionId: string | undefined): void => {
    if (!connectionId) return;
    const untrack = connections.track(roomId, connectionId, webSocket);
    webSocket.once('close', untrack);
  };

  // Host console fan-out: each stream is scoped to one room's lobby.
  const eventClients = new Map<Response, string>();
  const lobbySnapshotJson = (roomId: string): string => {
    const room = sessions.get(roomId);
    return JSON.stringify(
      room?.session.lobby.snapshot() ?? { enabled: false, locked: true, admitted: 0, pending: [] },
    );
  };
  const broadcastLobby = (roomId: string): void => {
    for (const [client, clientRoomId] of eventClients) {
      if (clientRoomId !== roomId) continue;
      try {
        client.write(`event: lobby\ndata: ${lobbySnapshotJson(roomId)}\n\n`);
      } catch {
        eventClients.delete(client);
      }
    }
  };
  const subscribeEvents = (response: Response, roomId: string): (() => void) => {
    eventClients.set(response, roomId);
    response.write(`event: snapshot\ndata: ${lobbySnapshotJson(roomId)}\n\n`);
    return () => {
      eventClients.delete(response);
    };
  };
  const closeRoomEvents = (roomId: string): void => {
    for (const [client, clientRoomId] of eventClients) {
      if (clientRoomId !== roomId) continue;
      eventClients.delete(client);
      try {
        client.end();
      } catch {
        // The client already went away.
      }
    }
  };

  const interviewSandbox = config.interviewSandbox
    ? await (options.sandboxProbe ?? probeInterviewSandbox)(config.interviewSandboxImage)
    : {
        available: false,
        image: config.interviewSandboxImage,
        reason: 'The candidate interview sandbox is disabled on this server.',
      };

  // The default room and every additional room share the daemon's socket and
  // lifecycle infrastructure, but own their session, tokens and signalling.
  const tokenStore = new TokenStore(config.tokens);
  const sessions = new RoomRegistry(
    config.roomId,
    config.root,
    tokenStore,
    {
      saveDebounceMs: config.saveDebounceMs,
      maxFileBytes: config.maxFileBytes,
      terminalEnabled: config.terminalEnabled,
      ignored,
      lobby: { enabled: config.lobbyEnabled, timeoutMs: config.lobbyTimeoutMs },
      inviteNow: options.inviteNow,
      interviewSandbox,
      terminalSpawn: options.terminalSpawn,
      sandboxSpawn: options.sandboxSpawn,
    },
    broadcastLobby,
  );

  const authenticateForRoom = (room: Room) =>
    room.isDefault && options.authenticate ? options.authenticate : room.tokens.authenticate;
  const tunnelState = createTunnelState(config.tunnelProvider);
  const tunnelStatus = options.tunnelStatus ?? (() => tunnelState.status());
  let boundPort = config.port;
  const guestOrigin = (): string => {
    const publicUrl = tunnelStatus().publicUrl;
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    const host = config.host === '0.0.0.0' || config.host === '::' ? firstLanAddress() ?? '127.0.0.1' : config.host;
    const formatted = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${formatted}:${boundPort}`;
  };

  // The Host console gets its own authenticator, built from one grant, and that
  // instance is passed only to the admin app. Guest grants are never registered
  // on it; admin routes are never mounted on the guest listener, so holding
  // `session.admin` on the guest port grants nothing there.
  const adminToken = generateToken();
  const adminAuthenticator = createAuthenticator([{ token: adminToken, role: 'host' }]);
  let adminPort: number | undefined;
  const adminApp = createAdminApp({
    sessions,
    authenticate: adminAuthenticator,
    port: () => adminPort ?? 0,
    terminalBypassesRules: () => terminalBypassesRules(config),
    connections,
    subscribeEvents,
    closeRoomEvents,
    clientDist: config.clientDist,
    tunnelStatus,
    guestOrigin,
  });
  const adminHttpServer = http.createServer(adminApp);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(securityHeaders);
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, version: SERVER_VERSION });
  });

  // The room selector is resolved once per request. It chooses which token
  // store authenticates the request; it is not itself a credential.
  app.use('/api', (request, _response, next) => {
    const raw = request.headers['x-codepair-room'];
    if (Array.isArray(raw)) {
      next(new AppError(404, 'ROOM_NOT_FOUND', 'That room does not exist.'));
      return;
    }
    const roomId = typeof raw === 'string' && raw.length > 0 ? raw : config.roomId;
    const room = sessions.get(roomId);
    if (!room) {
      next(new AppError(404, 'ROOM_NOT_FOUND', 'That room does not exist.'));
      return;
    }
    request.room = room;
    next();
  });

  // Invite redemption is the one intentionally unauthenticated API route: the
  // whole point is to exchange a link for a token. It is rate-limited and
  // fail-closed inside InviteStore, and it grants no access by itself.
  app.post('/api/invites/:id/redeem', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      response.json(roomOf(request).session.invites.redeem(request.params.id));
    } catch (error) {
      next(error);
    }
  });

  // Tagged so the route-audit test can prove every `/api` route still sits
  // behind authentication.
  const authenticateApi: ((request: Request, response: Response, next: NextFunction) => void) & {
    [API_AUTHENTICATION]: true;
  } = Object.assign(
    (request: Request, response: Response, next: NextFunction): void => {
      const principal = authenticateForRoom(roomOf(request))(
        tokenFromAuthorizationHeader(request.headers.authorization),
      );
      if (!principal) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        next(unauthorized());
        return;
      }
      request.principal = principal;
      next();
    },
    { [API_AUTHENTICATION]: true as const },
  );

  app.use('/api', authenticateApi);

  app.get('/api/session', (request, response) => {
    const room = roomOf(request);
    const session = room.session;
    // Reachable while waiting on purpose (the waiting screen needs it), and an
    // admitted seat can only narrow what this tab is told it may do.
    const connectionId = connectionIdOf(request);
    const principal = effectivePrincipal(session, principalOf(request), connectionId);
    const sandboxAvailable =
      config.terminalEnabled && session.terminals.interviewSandbox?.available === true;
    // Mint once per response: no shared or cached credential is handed out.
    const turn = config.turnSecret
      ? mintTurnCredential(config.turnSecret, config.turnCredentialTtl)
      : undefined;
    const iceServers = turn
      ? [...config.iceServers, { urls: config.turnUrls, username: turn.username, credential: turn.credential }]
      : config.iceServers;
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      role: principal.role,
      // Effective capabilities: the terminal feature flag can only remove
      // `term.use`, never add a capability.
      capabilities: CAPABILITIES.filter(
        (capability) => can(principal, capability) && (capability !== 'term.use' || config.terminalEnabled),
      ),
      mode: can(principal, 'fs.write') ? 'read-write' : 'read-only',
      rootName: path.basename(session.root) || 'project',
      roomId: room.id,
      version: SERVER_VERSION,
      startedAt,
      limits: { maxFileBytes: config.maxFileBytes },
      rtc: { iceServers },
      ...(principal.role === 'candidate'
        ? {
            interview: {
              consentRequired: !connectionId || !session.interview.hasConsent(connectionId),
              consent: session.interview.manifest,
              // A convenience/fairness measure, not a security boundary.
              monacoSuggestions: false,
              sandboxTerminalAvailable: sandboxAvailable,
            },
          }
        : {}),
    });
  });

  // Lobby (waiting room). `join` creates or retries this tab's request; `status`
  // lets the waiting screen poll without any other file access.
  app.post(
    '/api/lobby/join',
    requireCap('fs.read'),
    asyncRoute(async (request, response) => {
      const room = roomOf(request);
      const session = room.session;
      const principal = principalOf(request);
      const connectionId = connectionIdOf(request);
      if (!connectionId) {
        throw new AppError(403, 'LOBBY_REQUIRED', 'A connection id is required to join the lobby.');
      }
      const body = asRecord(request.body);
      const displayName = typeof body.displayName === 'string' ? body.displayName : '';
      const role = guestRoleOf(principal);
      if (role === 'candidate') {
        const consented = session.interview.hasConsent(connectionId) || body.consent === true;
        if (!consented) {
          throw new AppError(
            403,
            'CONSENT_REQUIRED',
            'Accept the interview logging notice before joining.',
          );
        }
        if (body.consent === true) session.interview.grantConsent(connectionId);
      }
      claimConnection(connections, room.id, connectionId);
      response.json(session.lobby.request(connectionId, displayName, role));
    }),
  );

  app.get('/api/lobby/status', requireCap('fs.read'), (request, response) => {
    const room = roomOf(request);
    const session = room.session;
    const connectionId = connectionIdOf(request);
    if (!connectionId) {
      throw new AppError(403, 'LOBBY_REQUIRED', 'A connection id is required to join the lobby.');
    }
    claimConnection(connections, room.id, connectionId);
    response.json(session.lobby.status(connectionId, guestRoleOf(principalOf(request))));
  });

  // The waiting room: every guest route below needs an admitted connection. The
  // owner token never waits. A connection id alone grants nothing — it must
  // belong to an admitted entry, and its seat can only narrow the token's
  // capabilities. Anything unrecognized fails closed as "waiting".
  app.use('/api', (request, _response, next) => {
    const room = roomOf(request);
    const connectionId = connectionIdOf(request);
    claimConnection(connections, room.id, connectionId);
    const principal = principalOf(request);
    if (principal.role === 'owner') {
      next();
      return;
    }
    const session = room.session;
    if (!session.lobby.enabled) {
      next();
      return;
    }
    if (!connectionId) {
      next(new AppError(403, 'LOBBY_REQUIRED', 'A connection id is required to use this API.'));
      return;
    }
    const seat = session.lobby.seatFor(connectionId);
    // An owner's connection id is not a guest seat: never let it be borrowed.
    if (!seat || seat.role === 'owner') {
      next(lobbyError(session.lobby.status(connectionId, guestRoleOf(principal))));
      return;
    }
    request.principal = seatPrincipal(principal, seat.role);
    next();
  });

  app.get('/api/tree', requireCap('fs.read'), asyncRoute(async (request, response) => {
    const session = roomOf(request).session;
    const input = queryString(request.query.path, '');
    response.json(await session.access(principalOf(request)).tree(input));
  }));

  app.get('/api/file', requireCap('fs.read'), asyncRoute(async (request, response) => {
    const session = roomOf(request).session;
    const input = requiredQuery(request.query.path);
    response.json(await session.access(principalOf(request)).read(input));
  }));

  app.get('/api/search', requireCap('fs.read'), asyncRoute(async (request, response) => {
    const session = roomOf(request).session;
    const query = typeof request.query.q === 'string' ? request.query.q.slice(0, 200) : '';
    response.json(await session.access(principalOf(request)).search(query));
  }));

  app.post(
    '/api/integrity',
    requireCap('fs.read'),
    asyncRoute(async (request, response) => {
      const session = roomOf(request).session;
      const principal = principalOf(request);
      const connectionId = connectionIdOf(request);
      if (principal.role !== 'candidate') {
        throw new AppError(403, 'INTERVIEW_ONLY', 'Integrity signals are accepted only from an interview candidate.');
      }
      if (!connectionId) {
        throw new AppError(403, 'LOBBY_REQUIRED', 'A connection id is required to log integrity signals.');
      }
      if (!session.interview.hasConsent(connectionId)) {
        throw new AppError(403, 'CONSENT_REQUIRED', 'Accept the interview logging notice before logging signals.');
      }
      const body = asRecord(request.body);
      const rawEvents = body.events;
      if (!Array.isArray(rawEvents) || rawEvents.length === 0 || rawEvents.length > MAX_EVENT_BATCH) {
        throw new AppError(400, 'BAD_REQUEST', `events must contain 1-${MAX_EVENT_BATCH} entries.`);
      }
      const events = rawEvents.map((entry) => validateIntegrityEvent(entry));
      const accepted = session.interview.record(connectionId, events);
      response.status(202).json({ accepted });
    }),
  );

  app.post('/api/files', requireCap('fs.write'), asyncRoute(async (request, response) => {
    const session = roomOf(request).session;
    const body = asRecord(request.body);
    const input = requireString(body.path, 'path');
    const type = body.type;
    if (type !== 'file' && type !== 'directory') throw badRequest('type must be "file" or "directory".');
    const content = body.content === undefined ? '' : requireString(body.content, 'content');
    const entry = await session.access(principalOf(request)).create(input, type, content);
    response.status(201).json({ entry });
  }));

  app.post('/api/files/rename', requireCap('fs.write'), asyncRoute(async (request, response) => {
    const session = roomOf(request).session;
    const body = asRecord(request.body);
    const from = requireString(body.from, 'from');
    const to = requireString(body.to, 'to');
    await session.documents.flushSubtree(from);
    session.documents.discardSubtree(from, 'This file was renamed.');
    const entry = await session.access(principalOf(request)).rename(from, to);
    response.json({ entry });
  }));

  app.delete('/api/files', requireCap('fs.delete'), asyncRoute(async (request, response) => {
    const session = roomOf(request).session;
    const input = typeof request.query.path === 'string' ? request.query.path : undefined;
    if (!input) throw badRequest('path query parameter is required.');
    session.documents.discardSubtree(input, 'This file was deleted.');
    const result = await session.access(principalOf(request)).remove(input);
    response.json(result);
  }));

  app.use('/api', (_request, _response, next) => {
    next(new AppError(404, 'NOT_FOUND', 'Unknown API route.'));
  });

  // The Host console is a separate listener. It is never mounted here, and the
  // prefix is refused before the static/SPA fallbacks can answer it with a page.
  app.use('/admin', (_request, _response, next) => {
    next(new AppError(404, 'NOT_FOUND', 'Not found.'));
  });

  // The Host console lives on the loopback admin listener, never on this one.
  const hostConsoleElsewhere = (_request: Request, response: Response): void => {
    response
      .status(404)
      .type('text/plain')
      .send('The Host console runs on the loopback admin port printed at startup.');
  };
  app.get('/host', hostConsoleElsewhere);
  app.get('/host/', hostConsoleElsewhere);

  const hasClientBuild = fs.existsSync(path.join(config.clientDist, 'index.html'));
  if (hasClientBuild) {
    app.use(
      express.static(config.clientDist, {
        index: false,
        dotfiles: 'deny',
        maxAge: '1y',
        setHeaders(response, filePath) {
          if (filePath.endsWith('index.html')) response.setHeader('Cache-Control', 'no-store');
        },
      }),
    );
    app.get('*', (request, response, next) => {
      if (request.path.startsWith('/api') || request.path.startsWith('/ws/')) {
        next();
        return;
      }
      response.setHeader('Cache-Control', 'no-store');
      response.sendFile(path.join(config.clientDist, 'index.html'));
    });
  } else {
    app.get('*', (request, response) => {
      if (request.path.startsWith('/api') || request.path.startsWith('/ws/')) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return;
      }
      response
        .status(503)
        .type('text/plain')
        .send(
          [
            'CodePair UI is not built yet.',
            '',
            'For development, run `npm run dev` and open the Vite URL printed by the server.',
            'For production, run `npm run build` and restart the daemon.',
            '',
            config.devClientUrl ? `Dev UI: ${config.devClientUrl}` : '',
          ].join('\n'),
        );
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const parseError = normalizeBodyParserError(error);
    const { status, payload } = toErrorPayload(parseError ?? error);
    if (status >= 500) {
      console.error('[codepair] request failed:', error);
    }
    if (response.headersSent) return;
    response.status(status).setHeader('Cache-Control', 'no-store').json(payload);
  });

  const httpServer = http.createServer(app);
  const docWss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD,
    perMessageDeflate: { threshold: 1024 },
    handleProtocols: () => WS_PROTOCOL,
  });
  const terminalWss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
    handleProtocols: () => WS_PROTOCOL,
  });
  const signalWss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: { threshold: 1024 },
    handleProtocols: () => WS_PROTOCOL,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());

    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request', 'Malformed URL.');
      return;
    }

    const requestedRoom = url.searchParams.get('room') ?? config.roomId;
    const room = sessions.get(requestedRoom);
    if (!room) {
      rejectUpgrade(socket, 404, 'Not Found', 'Unknown room.');
      return;
    }

    // Authenticate against the selected room's token store. The room selector is
    // never a credential: a valid token from room A gets 401 in room B.
    const principal = authenticateForRoom(room)(
      tokenFromWebSocketHeader(request.headers['sec-websocket-protocol']),
    );
    if (!principal) {
      rejectUpgrade(socket, 401, 'Unauthorized', 'A valid access token is required.');
      return;
    }
    if (!isUpgradeOriginAllowed(request.headers.origin, extractHost(request), config)) {
      rejectUpgrade(socket, 403, 'Forbidden', 'Origin not allowed.');
      return;
    }

    // One session for this upgrade: the lobby decision, the access check and
    // the connection below all belong to the same root selection.
    const session = room.session;
    let upgradePrincipal = principal;
    let upgradeConnectionId: string | undefined;
    let refusal: string | undefined;
    const rawConnectionId = url.searchParams.get('cid');
    if (principal.role === 'owner') {
      if (isConnectionId(rawConnectionId)) {
        upgradeConnectionId = rawConnectionId;
        session.lobby.connectDirect(rawConnectionId, 'Owner', 'owner');
      }
    } else if (!session.lobby.enabled) {
      // No waiting room: every authenticated connection is admitted. A supplied
      // connection id is still claimed so it cannot be borrowed by another room.
      if (isConnectionId(rawConnectionId)) upgradeConnectionId = rawConnectionId;
    } else if (!isConnectionId(rawConnectionId)) {
      refusal = 'A connection id is required to join this room.';
    } else {
      const seat = session.lobby.seatFor(rawConnectionId);
      if (seat && seat.role !== 'owner') {
        upgradePrincipal = seatPrincipal(principal, seat.role);
        upgradeConnectionId = rawConnectionId;
      } else {
        refusal = lobbyRefusalReason(session.lobby.status(rawConnectionId, guestRoleOf(principal)));
      }
    }

    if (refusal === undefined && upgradeConnectionId) {
      if (!connections.claim(upgradeConnectionId, room.id)) {
        rejectUpgrade(socket, 403, 'Forbidden', 'That connection id belongs to a different room.');
        return;
      }
    }

    if (url.pathname === '/ws/doc') {
      const docPath = url.searchParams.get('path');
      if (!docPath) {
        rejectUpgrade(socket, 400, 'Bad Request', 'Missing path.');
        return;
      }
      // A waiting room refusal completes the upgrade and closes with a code, so
      // the tab can tell "ask the host" from "that file is gone".
      if (refusal !== undefined) {
        lobbyRefuse(docWss, request, socket, head, refusal);
        return;
      }
      if (!can(upgradePrincipal, 'fs.read')) {
        rejectUpgrade(socket, 403, 'Forbidden', 'You do not have permission to open files.');
        return;
      }

      // One resolution per connection: everything below uses this session,
      // even if the Host switches root while the file is being read.
      const access = session.access(upgradePrincipal);
      try {
        session.pathGuard.resolve(docPath);
      } catch (error) {
        const message = error instanceof SandboxError ? error.message : 'Invalid path.';
        rejectUpgrade(socket, 403, 'Forbidden', message);
        return;
      }
      // A hidden file must be indistinguishable from a missing one: same status,
      // same reason phrase, same message, and no file read has happened yet.
      const decision = access.documentAccess(docPath);
      if (!decision.visible) {
        rejectUpgrade(socket, 404, 'Cannot Open File', 'That path does not exist.');
        return;
      }

      void (async () => {
        try {
          await session.documents.prepare(docPath);
        } catch (error) {
          if (socket.destroyed) return;
          if (session.documents.disposed || !isActiveSession(sessions, room, session)) {
            // The session went away mid-prepare. Complete the upgrade only to
            // close it with that session's code (4410 on a root switch), so the
            // client stops reconnecting instead of seeing a rejected upgrade.
            docWss.handleUpgrade(request, socket, head, (webSocket) => {
              docWss.emit('connection', webSocket, request);
              track(webSocket, room.id, upgradeConnectionId);
              session.documents.connect(docPath, webSocket, decision.write, access.view, {
                connectionId: upgradeConnectionId,
                role: upgradePrincipal.role,
              });
            });
            return;
          }
          const status = error instanceof AppError ? error.status : 404;
          const message = error instanceof Error ? error.message : 'Could not open file.';
          rejectUpgrade(socket, status >= 400 && status < 600 ? status : 500, 'Cannot Open File', message);
          return;
        }
        if (socket.destroyed) return;
        docWss.handleUpgrade(request, socket, head, (webSocket) => {
          docWss.emit('connection', webSocket, request);
          track(webSocket, room.id, upgradeConnectionId);
          session.documents.connect(docPath, webSocket, decision.write, access.view, {
                connectionId: upgradeConnectionId,
                role: upgradePrincipal.role,
              });
        });
      })();
      return;
    }

    if (url.pathname === '/ws/terminal') {
      if (refusal !== undefined) {
        lobbyRefuse(terminalWss, request, socket, head, refusal);
        return;
      }
      terminalWss.handleUpgrade(request, socket, head, (webSocket) => {
        terminalWss.emit('connection', webSocket, request);
        track(webSocket, room.id, upgradeConnectionId);
        session.terminals.handle(webSocket, upgradePrincipal);
      });
      return;
    }

    if (url.pathname === '/ws/signal') {
      if (refusal !== undefined) {
        lobbyRefuse(signalWss, request, socket, head, refusal);
        return;
      }
      signalWss.handleUpgrade(request, socket, head, (webSocket) => {
        signalWss.emit('connection', webSocket, request);
        track(webSocket, room.id, upgradeConnectionId);
        room.signaling.handle(webSocket, upgradePrincipal, upgradeConnectionId);
      });
      return;
    }

    rejectUpgrade(socket, 404, 'Not Found', 'Unknown WebSocket endpoint.');
  });

  docWss.on('connection', (socket) => {
    socket.on('error', (error) => console.error('[codepair] document socket error:', error.message));
  });
  terminalWss.on('connection', (socket) => {
    socket.on('error', (error) => console.error('[codepair] terminal socket error:', error.message));
  });
  signalWss.on('connection', (socket) => {
    socket.on('error', (error) => console.error('[codepair] signal socket error:', error.message));
  });

  let listening = false;
  let closed = false;

  const admin = {
    token: adminToken,
    app: adminApp as express.Express,
    httpServer: adminHttpServer,
    get port(): number {
      return adminPort ?? 0;
    },
  };

  return {
    app,
    httpServer,
    config,
    startedAt,
    sessions,
    admin,
    get guard(): PathGuard {
      return sessions.current().pathGuard;
    },
    get root(): string {
      return sessions.current().root;
    },
    async start(port = config.port, host = config.host) {
      if (listening) throw new ConfigError('Server is already listening.');

      const actualPort = await listen(httpServer, port, host);
      boundPort = actualPort;

      try {
        // 127.0.0.1 as a literal, never `config.host`: the Host console is
        // unreachable from the LAN and from a tunnel.
        adminPort = await listen(adminHttpServer, config.adminPort, '127.0.0.1');
      } catch (error) {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
          httpServer.closeAllConnections?.();
        });
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        const reason = code === 'EADDRINUSE' ? 'is already in use' : `could not be bound (${String(code ?? error)})`;
        throw new ConfigError(`Admin port ${config.adminPort} ${reason}. Pass --admin-port <n> to choose another port.`);
      }

      listening = true;
      return { port: actualPort, host, adminPort: adminPort ?? 0 };
    },
    async close() {
      if (closed) return;
      closed = true;
      await sessions.disposeAll();
      connections.clear();
      for (const client of docWss.clients) client.terminate();
      for (const client of terminalWss.clients) client.terminate();
      for (const client of signalWss.clients) client.terminate();
      await Promise.all([
        new Promise<void>((resolve) => docWss.close(() => resolve())),
        new Promise<void>((resolve) => terminalWss.close(() => resolve())),
        new Promise<void>((resolve) => signalWss.close(() => resolve())),
      ]);
      if (listening) {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
          httpServer.closeAllConnections?.();
        });
        listening = false;
      }
      await new Promise<void>((resolve) => {
        adminHttpServer.close(() => resolve());
        adminHttpServer.closeAllConnections?.();
      });
    },
  };
}

/**
 * Production accepts same-origin and explicitly configured origins. In Vite
 * development the browser talks to port 5180 (often through a LAN address),
 * so any loopback/private-network origin on the dev server's port is allowed
 * regardless of protocol (HTTP or HTTPS, since we now enable SSL in Vite).
 * A valid access token is still required in every case.
 */
function isUpgradeOriginAllowed(origin: string | undefined, host: string | undefined, config: ServerConfig): boolean {
  if (isOriginAllowed(origin, host, config.allowedOrigins)) return true;
  if (!origin || !config.devClientUrl) return false;
  try {
    const parsed = new URL(origin);
    const dev = new URL(config.devClientUrl);
    if (parsed.port !== dev.port) return false;
    return isLocalOrPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isLocalOrPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

function firstLanAddress(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

/** Is this exact session still the active one for its room? */
function isActiveSession(sessions: RoomRegistry, room: Room, session: Session): boolean {
  try {
    return sessions.isActive(room) && room.session === session;
  } catch {
    return false;
  }
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

/** The per-tab connection id sent as a header (guest HTTP) or query (ws). */
function connectionIdOf(request: Request): string | undefined {
  const raw = request.headers['x-codepair-connection'];
  return isConnectionId(raw) ? raw : undefined;
}

/** The guest instances of `Role`, narrowed for the lobby (host never reaches here). */
function guestRoleOf(principal: Principal): 'owner' | 'editor' | 'viewer' | 'candidate' {
  if (principal.role === 'owner' || principal.role === 'editor' || principal.role === 'candidate') {
    return principal.role;
  }
  return 'viewer';
}

/** A seat may only narrow a token's capabilities, never widen them. */
function effectivePrincipal(
  session: Session,
  principal: Principal,
  connectionId: string | undefined,
): Principal {
  if (principal.role === 'owner' || !connectionId) return principal;
  const seat = session.lobby.seatFor(connectionId);
  if (!seat || seat.role === 'owner') return principal;
  return seatPrincipal(principal, seat.role);
}

/** HTTP refusal for a connection that may not touch the file API yet. */
function lobbyError(status: LobbyStatus): AppError {
  switch (status.state) {
    case 'denied':
      return new AppError(403, 'LOBBY_DENIED', LOBBY_DENIED_REASON);
    case 'expired':
      return new AppError(403, 'LOBBY_EXPIRED', LOBBY_EXPIRED_REASON);
    case 'removed':
      return new AppError(403, 'LOBBY_REMOVED', LOBBY_REMOVED_REASON);
    case 'withdrawn':
      return new AppError(403, 'LOBBY_CLOSED', 'Your request was withdrawn.');
    default:
      return new AppError(403, 'LOBBY_WAITING', LOBBY_WAITING_REASON);
  }
}

function lobbyRefusalReason(status: LobbyStatus): string {
  if (status.state === 'denied') return LOBBY_DENIED_REASON;
  if (status.state === 'removed') return LOBBY_REMOVED_REASON;
  if (status.state === 'expired') return LOBBY_EXPIRED_REASON;
  return LOBBY_WAITING_REASON;
}

/**
 * Refuse a lobby candidate the way a WebSocket client can understand: finish
 * the upgrade, then close with 4425 and a reason, so the tab shows the waiting
 * (or declined/removed) screen instead of a generic connection error.
 */
function lobbyRefuse(
  wss: WebSocketServer,
  request: http.IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
  reason: string,
): void {
  wss.handleUpgrade(request, socket, head, (webSocket) => {
    webSocket.on('error', () => {});
    webSocket.close(LOBBY_CLOSE_CODE, reason);
  });
}

/** The `/api` middleware always sets a principal; this only narrows the type. */
function principalOf(request: Request): Principal {
  if (!request.principal) throw unauthorized();
  return request.principal;
}

/** The `/api` room resolver always sets this before authentication. */
function roomOf(request: Request): Room {
  if (!request.room) throw new AppError(500, 'ROOM_CONTEXT_MISSING', 'The room was not resolved.');
  return request.room;
}

function claimConnection(
  connections: ConnectionRegistry,
  roomId: string,
  connectionId: string | undefined,
): void {
  if (!connectionId) return;
  if (!connections.claim(connectionId, roomId)) {
    throw new AppError(403, 'ROOM_MISMATCH', 'That connection id belongs to a different room.');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('Expected a JSON object body.');
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw badRequest(`"${field}" must be a non-empty string.`);
  return value;
}

function queryString(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw badRequest('Query parameter must be a string.');
  return value;
}

function requiredQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw badRequest('path query parameter is required.');
  return value;
}

const INTEGRITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'visibility',
  'blur',
  'focus',
  'fullscreen-enter',
  'fullscreen-exit',
  'paste',
  'screen-share-surface',
]);
const DISPLAY_SURFACES: ReadonlySet<string> = new Set(['monitor', 'window', 'browser', 'unknown']);

function validateIntegrityEvent(value: unknown): IntegrityEventInput {
  const event = asRecord(value);
  if (typeof event.type !== 'string' || !INTEGRITY_EVENT_TYPES.has(event.type)) {
    throw badRequest('Each integrity event must have a known type.');
  }
  const path = event.path;
  if (path !== undefined && (typeof path !== 'string' || path.length === 0 || path.length > 300 || path.includes('\u0000'))) {
    throw badRequest('Integrity event path must be a short relative path.');
  }
  const size = event.size;
  if (
    size !== undefined &&
    (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > 10_000_000)
  ) {
    throw badRequest('Integrity event size must be a non-negative integer.');
  }
  const surface = event.surface;
  if (surface !== undefined && (typeof surface !== 'string' || !DISPLAY_SURFACES.has(surface))) {
    throw badRequest('Integrity event surface must be monitor, window, browser or unknown.');
  }
  return {
    type: event.type as IntegrityEventType,
    ...(path !== undefined ? { path } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(surface !== undefined ? { surface: surface as DisplaySurface } : {}),
  };
}

function normalizeBodyParserError(error: unknown): AppError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const type = (error as { type?: unknown }).type;
  if (type === 'entity.parse.failed') {
    return new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
  if (type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }
  return undefined;
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: number, reason: string, message: string): void {
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Cache-Control: no-store\r\n' +
      '\r\n' +
      body,
  );
  socket.destroy();
}

export function createAccessUrl(baseUrl: string, token: string, roomId?: string): string {
  const base = baseUrl.replace(/\/$/, '');
  const roomPath = roomId ? `/room/${encodeURIComponent(roomId)}` : '/';
  return `${base}${roomPath}#token=${encodeURIComponent(token)}`;
}
