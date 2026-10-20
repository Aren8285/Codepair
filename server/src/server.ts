import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { ConfigError, type ServerConfig } from './config.js';
import { DocumentHub } from './documents/documentHub.js';
import { AppError, badRequest, readOnlyViolation, unauthorized, toErrorPayload } from './errors.js';
import { DEFAULT_IGNORED, FileService } from './files/fileService.js';
import { PathGuard, SandboxError } from './security/pathGuard.js';
import {
  WS_PROTOCOL,
  extractHost,
  isOriginAllowed,
  tokenFromAuthorizationHeader,
  tokenFromWebSocketHeader,
  tokensMatch,
} from './security/auth.js';
import { SignalingHub } from './signaling/signalingHub.js';
import { TerminalService } from './terminal/terminalService.js';

const SERVER_VERSION = '0.2.0';
const MAX_WS_PAYLOAD = 2 * 1024 * 1024;

export interface CodepairServer {
  readonly app: express.Express;
  readonly httpServer: http.Server;
  readonly guard: PathGuard;
  readonly config: ServerConfig;
  readonly startedAt: number;
  start(port?: number, host?: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

export async function createCodepairServer(config: ServerConfig): Promise<CodepairServer> {
  const startedAt = Date.now();
  const guard = new PathGuard(config.root);
  const ignored = new Set(DEFAULT_IGNORED);
  for (const name of (process.env.CODE_PAIR_IGNORE ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    ignored.add(name);
  }
  const files = new FileService(guard, { maxFileBytes: config.maxFileBytes, ignored });
  const documents = new DocumentHub(files, { saveDebounceMs: config.saveDebounceMs });
  const terminal = new TerminalService(guard, {
    enabled: config.terminalEnabled,
    readOnly: config.mode === 'read-only',
  });
  const signaling = new SignalingHub({ room: config.roomId });
  const readOnly = config.mode === 'read-only';

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(securityHeaders);
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, version: SERVER_VERSION });
  });

  app.use('/api', (request, response, next) => {
    const token = tokenFromAuthorizationHeader(request.headers.authorization);
    if (!tokensMatch(token, config.token)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      next(unauthorized());
      return;
    }
    next();
  });

  app.get('/api/session', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      mode: config.mode,
      rootName: path.basename(guard.root) || 'project',
      roomId: config.roomId,
      version: SERVER_VERSION,
      startedAt,
      capabilities: {
        write: !readOnly,
        terminal: config.terminalEnabled && !readOnly,
        upload: false,
      },
      limits: { maxFileBytes: config.maxFileBytes },
      rtc: { iceServers: config.iceServers },
    });
  });

  app.get('/api/tree', asyncRoute(async (request, response) => {
    const input = queryString(request.query.path, '');
    response.json(await files.tree(input));
  }));

  app.get('/api/file', asyncRoute(async (request, response) => {
    const input = requiredQuery(request.query.path);
    response.json(await files.read(input));
  }));

  app.get('/api/search', asyncRoute(async (request, response) => {
    const query = typeof request.query.q === 'string' ? request.query.q.slice(0, 200) : '';
    response.json(await files.search(query));
  }));

  app.post('/api/files', asyncRoute(async (request, response) => {
    requireWrite(request, readOnly);
    const body = asRecord(request.body);
    const input = requireString(body.path, 'path');
    const type = body.type;
    if (type !== 'file' && type !== 'directory') throw badRequest('type must be "file" or "directory".');
    const content = body.content === undefined ? '' : requireString(body.content, 'content');
    const entry = await files.create(input, type, content);
    response.status(201).json({ entry });
  }));

  app.post('/api/files/rename', asyncRoute(async (request, response) => {
    requireWrite(request, readOnly);
    const body = asRecord(request.body);
    const from = requireString(body.from, 'from');
    const to = requireString(body.to, 'to');
    await documents.flushSubtree(from);
    documents.discardSubtree(from, 'This file was renamed.');
    const entry = await files.rename(from, to);
    response.json({ entry });
  }));

  app.delete('/api/files', asyncRoute(async (request, response) => {
    requireWrite(request, readOnly);
    const input = typeof request.query.path === 'string' ? request.query.path : undefined;
    if (!input) throw badRequest('path query parameter is required.');
    documents.discardSubtree(input, 'This file was deleted.');
    const result = await files.remove(input);
    response.json(result);
  }));

  app.use('/api', (_request, _response, next) => {
    next(new AppError(404, 'NOT_FOUND', 'Unknown API route.'));
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

    const token = tokenFromWebSocketHeader(request.headers['sec-websocket-protocol']);
    if (!tokensMatch(token, config.token)) {
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
      try {
        guard.resolve(docPath);
      } catch (error) {
        const message = error instanceof SandboxError ? error.message : 'Invalid path.';
        rejectUpgrade(socket, 403, 'Forbidden', message);
        return;
      }
      void (async () => {
        try {
          await documents.prepare(docPath);
        } catch (error) {
          if (socket.destroyed) return;
          const status = error instanceof AppError ? error.status : 404;
          const message = error instanceof Error ? error.message : 'Could not open file.';
          rejectUpgrade(socket, status >= 400 && status < 600 ? status : 500, 'Cannot Open File', message);
          return;
        }
        if (socket.destroyed) return;
        docWss.handleUpgrade(request, socket, head, (webSocket) => {
          docWss.emit('connection', webSocket, request);
          documents.connect(docPath, webSocket, readOnly);
        });
      })();
      return;
    }

    if (url.pathname === '/ws/terminal') {
      terminalWss.handleUpgrade(request, socket, head, (webSocket) => {
        terminalWss.emit('connection', webSocket, request);
        terminal.handle(webSocket);
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
        signaling.handle(webSocket);
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

  return {
    app,
    httpServer,
    guard,
    config,
    startedAt,
    async start(port = config.port, host = config.host) {
      if (listening) throw new ConfigError('Server is already listening.');
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
      listening = true;
      const address = httpServer.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return { port: actualPort, host };
    },
    async close() {
      if (closed) return;
      closed = true;
      await documents.dispose();
      terminal.dispose();
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
    },
  };
}

/**
 * Production accepts same-origin and explicitly configured origins. In Vite
 * development the browser talks to port 5180 (often through a LAN address),
 * so any loopback/private-network origin on the dev server's port is allowed.
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

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function requireWrite(request: Request, readOnly: boolean): void {
  if (readOnly) throw readOnlyViolation(request.method === 'DELETE' ? 'Deleting' : 'Editing');
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

function securityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob: mediastream:",
      "connect-src 'self' ws: wss:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // WebRTC needs camera/mic/display capture, but only same-origin pages may ask.
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  if (_request.path.startsWith('/api')) response.setHeader('Cache-Control', 'no-store');
  next();
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
