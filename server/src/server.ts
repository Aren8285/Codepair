import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { createAdminApp } from './admin/adminApp.js';
import { ConfigError, generateToken, terminalBypassesRules, type ServerConfig } from './config.js';
import { AppError, badRequest, unauthorized, toErrorPayload } from './errors.js';
import { DEFAULT_IGNORED } from './files/fileService.js';
import {
  WS_PROTOCOL,
  createAuthenticator,
  extractHost,
  isOriginAllowed,
  tokenFromAuthorizationHeader,
  tokenFromWebSocketHeader,
  type Authenticator,
} from './security/auth.js';
import { CAPABILITY_GATE, requireCap } from './security/gate.js';
import { securityHeaders } from './security/headers.js';
import { CAPABILITIES, can, type Principal } from './security/principal.js';
import { SandboxError, type PathGuard } from './security/pathGuard.js';
import type { Session } from './session/session.js';
import { SessionManager } from './session/sessionManager.js';
import { SignalingHub } from './signaling/signalingHub.js';

export { CAPABILITY_GATE, requireCap };
export type { CapabilityGate } from './security/gate.js';

export const SERVER_VERSION = '0.3.2';
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
  readonly sessions: SessionManager;
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
}

export async function createCodepairServer(
  config: ServerConfig,
  options: CreateServerOptions = {},
): Promise<CodepairServer> {
  const startedAt = Date.now();

  const ignored = new Set(DEFAULT_IGNORED);
  for (const name of (process.env.CODE_PAIR_IGNORE ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    ignored.add(name);
  }

  // The one active session. `config.root` is read exactly here and nowhere else
  // in the server; every request resolves the session it will use, once.
  const sessions = new SessionManager(config.root, {
    saveDebounceMs: config.saveDebounceMs,
    maxFileBytes: config.maxFileBytes,
    terminalEnabled: config.terminalEnabled,
    ignored,
  });

  // Signalling is session-independent: rooms are stable for the daemon's life.
  const signaling = new SignalingHub({ room: config.roomId });

  const authenticate = options.authenticate ?? createAuthenticator(config.tokens);

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

  // Tagged so the route-audit test can prove every `/api` route still sits
  // behind authentication.
  const authenticateApi: ((request: Request, response: Response, next: NextFunction) => void) & {
    [API_AUTHENTICATION]: true;
  } = Object.assign(
    (request: Request, response: Response, next: NextFunction): void => {
      const principal = authenticate(tokenFromAuthorizationHeader(request.headers.authorization));
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
    const principal = principalOf(request);
    const session = sessions.current();
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
      roomId: config.roomId,
      version: SERVER_VERSION,
      startedAt,
      limits: { maxFileBytes: config.maxFileBytes },
      rtc: { iceServers: config.iceServers },
    });
  });

  app.get('/api/tree', requireCap('fs.read'), asyncRoute(async (request, response) => {
    const session = sessions.current();
    const input = queryString(request.query.path, '');
    response.json(await session.access(principalOf(request)).tree(input));
  }));

  app.get('/api/file', requireCap('fs.read'), asyncRoute(async (request, response) => {
    const session = sessions.current();
    const input = requiredQuery(request.query.path);
    response.json(await session.access(principalOf(request)).read(input));
  }));

  app.get('/api/search', requireCap('fs.read'), asyncRoute(async (request, response) => {
    const session = sessions.current();
    const query = typeof request.query.q === 'string' ? request.query.q.slice(0, 200) : '';
    response.json(await session.access(principalOf(request)).search(query));
  }));

  app.post('/api/files', requireCap('fs.write'), asyncRoute(async (request, response) => {
    const session = sessions.current();
    const body = asRecord(request.body);
    const input = requireString(body.path, 'path');
    const type = body.type;
    if (type !== 'file' && type !== 'directory') throw badRequest('type must be "file" or "directory".');
    const content = body.content === undefined ? '' : requireString(body.content, 'content');
    const entry = await session.access(principalOf(request)).create(input, type, content);
    response.status(201).json({ entry });
  }));

  app.post('/api/files/rename', requireCap('fs.write'), asyncRoute(async (request, response) => {
    const session = sessions.current();
    const body = asRecord(request.body);
    const from = requireString(body.from, 'from');
    const to = requireString(body.to, 'to');
    await session.documents.flushSubtree(from);
    session.documents.discardSubtree(from, 'This file was renamed.');
    const entry = await session.access(principalOf(request)).rename(from, to);
    response.json({ entry });
  }));

  app.delete('/api/files', requireCap('fs.delete'), asyncRoute(async (request, response) => {
    const session = sessions.current();
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

    const principal = authenticate(tokenFromWebSocketHeader(request.headers['sec-websocket-protocol']));
    if (!principal) {
      rejectUpgrade(socket, 401, 'Unauthorized', 'A valid access token is required.');
      return;
    }
    if (!isUpgradeOriginAllowed(request.headers.origin, extractHost(request), config)) {
      rejectUpgrade(socket, 403, 'Forbidden', 'Origin not allowed.');
      return;
    }

    if (url.pathname === '/ws/doc') {
      const docPath = url.searchParams.get('path');
      if (!docPath) {
        rejectUpgrade(socket, 400, 'Bad Request', 'Missing path.');
        return;
      }
      if (!can(principal, 'fs.read')) {
        rejectUpgrade(socket, 403, 'Forbidden', 'You do not have permission to open files.');
        return;
      }

      // One resolution per connection: everything below uses this session,
      // even if the Host switches root while the file is being read.
      const session = sessions.current();
      const access = session.access(principal);
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
          if (session.documents.disposed || !isActiveSession(sessions, session)) {
            // The session went away mid-prepare. Complete the upgrade only to
            // close it with that session's code (4410 on a root switch), so the
            // client stops reconnecting instead of seeing a rejected upgrade.
            docWss.handleUpgrade(request, socket, head, (webSocket) => {
              docWss.emit('connection', webSocket, request);
              session.documents.connect(docPath, webSocket, decision.write, access.view);
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
          session.documents.connect(docPath, webSocket, decision.write, access.view);
        });
      })();
      return;
    }

    if (url.pathname === '/ws/terminal') {
      const session = sessions.current();
      terminalWss.handleUpgrade(request, socket, head, (webSocket) => {
        terminalWss.emit('connection', webSocket, request);
        session.terminals.handle(webSocket, principal);
      });
      return;
    }

    if (url.pathname === '/ws/signal') {
      if (!signaling.acceptsRoom(url.searchParams.get('room'))) {
        rejectUpgrade(socket, 404, 'Not Found', 'Unknown room.');
        return;
      }
      signalWss.handleUpgrade(request, socket, head, (webSocket) => {
        signalWss.emit('connection', webSocket, request);
        signaling.handle(webSocket, principal);
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
      await sessions.dispose();
      signaling.dispose();
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

/** Is this session still the active one? Never throws during shutdown. */
function isActiveSession(sessions: SessionManager, session: Session): boolean {
  try {
    return sessions.current() === session;
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

/** The `/api` middleware always sets a principal; this only narrows the type. */
function principalOf(request: Request): Principal {
  if (!request.principal) throw unauthorized();
  return request.principal;
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
