import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AppError, toErrorPayload, unauthorized } from '../errors.js';
import type { ConnectionRegistry } from '../lobby/connections.js';
import { DEFAULT_SECRET_RULES, rulesUnhideDefaults, validateRules } from '../security/accessPolicy.js';
import { tokenFromAuthorizationHeader, type Authenticator } from '../security/auth.js';
import { requireCap } from '../security/gate.js';
import { securityHeaders } from '../security/headers.js';
import { listHostDirectories } from '../session/hostPaths.js';
import type { SessionManager } from '../session/sessionManager.js';

/** Tags the admin authentication middleware (route audit). */
export const ADMIN_AUTHENTICATION: unique symbol = Symbol.for('codepair.adminAuthentication');

/** Headers that prove a proxy (or something else) forwarded the request. */
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'x-real-ip'];

const ADMIN_JSON_LIMIT = '16kb';

export interface AdminAppOptions {
  sessions: SessionManager;
  /**
   * Built from a single grant for the Host console. Guest grants are never
   * registered on this authenticator, and it is passed only to this app.
   */
  authenticate: Authenticator;
  /** Actual bound port; 0 until the listener is up (then every request is refused). */
  port: () => number;
  /** Config-derived: does a shell bypass the path policy in this session? */
  terminalBypassesRules: () => boolean;
  /** Daemon-level sockets, so one kick reaches every surface of a tab. */
  connections: ConnectionRegistry;
  /** Host console stream: writes the opening snapshot, returns the unsubscribe. */
  subscribeEvents: (response: Response) => () => void;
  /** Built client directory; `host.html` is served only from this listener. */
  clientDist: string;
  logger?: Pick<Console, 'log' | 'error'>;
}

/**
 * The loopback-only Host console API.
 *
 * Defence in depth, applied before authentication: the Host header must be the
 * loopback origin on the actual port (DNS rebinding), an Origin header must
 * match it, and any forwarding header rejects the request outright. No CORS
 * headers are ever produced, and every response is `no-store`.
 */
export function createAdminApp(options: AdminAppOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(loopbackOnly(options.port));
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(securityHeaders);

  // EventSource cannot set headers, so this ONE admin route accepts `?token=`.
  // It authenticates itself and then goes through the same capability gate;
  // every other admin route still reads only Authorization, and the cross-route
  // test proves that is not a blanket query-token bypass.
  const queryTokenAuth = (request: Request, response: Response, next: NextFunction): void => {
    const raw = typeof request.query.token === 'string' ? request.query.token : undefined;
    const principal = options.authenticate(raw);
    if (!principal) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      next(unauthorized());
      return;
    }
    request.principal = principal;
    next();
  };

  app.get('/admin/api/events', queryTokenAuth, requireCap('session.admin'), (request, response) => {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    const unsubscribe = options.subscribeEvents(response);
    const heartbeat = setInterval(() => {
      try {
        response.write(': ping\n\n');
      } catch {
        // The client went away; 'close' does the cleanup.
      }
    }, 15_000);
    heartbeat.unref?.();
    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    });
  });

  const authenticate = taggedAuthenticator(options.authenticate);
  app.use('/admin', authenticate);
  app.use(express.json({ limit: ADMIN_JSON_LIMIT }));

  app.get('/admin/api/state', requireCap('session.admin'), (_request, response) => {
    const session = options.sessions.current();
    response.json({
      session: {
        id: session.id,
        rootName: path.basename(session.root) || 'project',
        rootPath: session.root,
        createdAt: session.createdAt,
      },
      openDocuments: session.documents.openDocuments,
      documentConnections: session.documents.documentConnections,
      terminals: session.terminals.activeSessions,
      terminalBypassesRules: options.terminalBypassesRules(),
    });
  });

  app.get(
    '/admin/api/fs/list',
    requireCap('session.admin'),
    asyncRoute(async (request, response) => {
      const raw = typeof request.query.path === 'string' ? request.query.path : undefined;
      const showHidden = request.query.showHidden === '1' || request.query.showHidden === 'true';
      response.json(await listHostDirectories(raw, showHidden));
    }),
  );

  app.get('/admin/api/policy', requireCap('session.admin'), (_request, response) => {
    const session = options.sessions.current();
    response.json({
      rules: session.policy.rules,
      defaults: DEFAULT_SECRET_RULES,
      confirmUnhide: session.policy.confirmUnhide,
      terminalBypassesRules: options.terminalBypassesRules(),
    });
  });

  app.put(
    '/admin/api/policy/rules',
    requireCap('session.admin'),
    asyncRoute(async (request, response) => {
      const body = asRecord(request.body);
      const unknown = Object.keys(body).filter((key) => key !== 'rules' && key !== 'confirmUnhide');
      if (unknown.length > 0) {
        throw new AppError(400, 'BAD_REQUEST', `Unknown field(s): ${unknown.join(', ')}.`);
      }
      if (body.rules === undefined) {
        throw new AppError(400, 'BAD_REQUEST', '"rules" is required.');
      }
      if (body.confirmUnhide !== undefined && typeof body.confirmUnhide !== 'boolean') {
        throw new AppError(400, 'BAD_REQUEST', '"confirmUnhide" must be a boolean.');
      }
      // Validate everything before touching the live list: a bad request must
      // change nothing, and lifting a default needs an explicit confirmation.
      const rules = validateRules(body.rules);
      const confirmUnhide = body.confirmUnhide === true;
      if (rulesUnhideDefaults(rules) && !confirmUnhide) {
        throw new AppError(
          400,
          'UNHIDE_SECRET',
          'Those rules expose a built-in secret default; pass confirmUnhide: true to allow it.',
        );
      }

      const session = options.sessions.current();
      const affected = await session.documents.applyPolicy(rules, confirmUnhide);
      response.json({
        rules: session.policy.rules,
        confirmUnhide: session.policy.confirmUnhide,
        affected,
      });
    }),
  );

  app.get('/admin/api/lobby', requireCap('session.admin'), (_request, response) => {
    response.json(options.sessions.current().lobby.snapshot());
  });

  app.post('/admin/api/lobby/:id/admit', requireCap('session.admin'), (request, response) => {
    const body = asRecord(request.body);
    const role = body.role;
    if (role !== 'editor' && role !== 'viewer') {
      throw new AppError(400, 'BAD_REQUEST', '"role" must be "editor" or "viewer".');
    }
    const id = request.params.id;
    if (!id) throw new AppError(400, 'BAD_REQUEST', 'A lobby entry id is required.');
    response.json({ entry: options.sessions.current().lobby.admit(id, role) });
  });

  app.post('/admin/api/lobby/:id/deny', requireCap('session.admin'), (request, response) => {
    const id = request.params.id;
    if (!id) throw new AppError(400, 'BAD_REQUEST', 'A lobby entry id is required.');
    response.json({ entry: options.sessions.current().lobby.deny(id) });
  });

  app.post('/admin/api/lobby/lock', requireCap('session.admin'), (request, response) => {
    const body = asRecord(request.body);
    if (typeof body.locked !== 'boolean') {
      throw new AppError(400, 'BAD_REQUEST', '"locked" must be a boolean.');
    }
    const session = options.sessions.current();
    session.lobby.setLocked(body.locked);
    response.json(session.lobby.snapshot());
  });

  app.post(
    '/admin/api/connections/:connectionId/kick',
    requireCap('session.admin'),
    (request, response) => {
      const connectionId = request.params.connectionId;
      if (!connectionId) throw new AppError(400, 'BAD_REQUEST', 'A connection id is required.');
      // Mark the connection removed first, so a reconnect is refused, then
      // close doc, terminal and signal sockets together.
      options.sessions.current().lobby.kick(connectionId);
      options.connections.close(connectionId);
      response.status(204).end();
    },
  );

  app.post(
    '/admin/api/session/root',
    requireCap('session.admin'),
    asyncRoute(async (request, response) => {
      const body = asRecord(request.body);
      const target = body.path;
      if (typeof target !== 'string' || target.length === 0) {
        throw new AppError(400, 'BAD_REQUEST', '"path" must be a non-empty string.');
      }
      if (body.confirmBroad !== undefined && typeof body.confirmBroad !== 'boolean') {
        throw new AppError(400, 'BAD_REQUEST', '"confirmBroad" must be a boolean.');
      }

      const result = await options.sessions.switchRoot(target, { confirmBroad: body.confirmBroad === true });
      const logger = options.logger ?? console;
      logger.log(
        `[codepair] host console: ${result.changed ? 'project root switched to' : 'project root unchanged:'} ${result.session.root}`,
      );
      if (result.flushErrors.length > 0) {
        logger.error(`[codepair] host console: could not save ${result.flushErrors.join(', ')} before switching.`);
      }

      response.json({
        changed: result.changed,
        session: {
          id: result.session.id,
          rootName: path.basename(result.session.root) || 'project',
          rootPath: result.session.root,
          createdAt: result.session.createdAt,
        },
        flushErrors: result.flushErrors,
      });
    }),
  );

  // The console page itself. It is not an API route and carries no token: the
  // page asks for the token from its `#admin=` fragment, then authenticates
  // every request it makes. Still behind the loopback guard above.
  const hostHtml = path.join(options.clientDist, 'host.html');
  if (fs.existsSync(hostHtml)) {
    const sendHost = (_request: Request, response: Response): void => {
      response.setHeader('Cache-Control', 'no-store');
      response.sendFile(hostHtml);
    };
    app.get('/host', sendHost);
    app.get('/host/', sendHost);
    app.use(
      '/assets',
      express.static(path.join(options.clientDist, 'assets'), {
        dotfiles: 'deny',
        maxAge: '1y',
        immutable: true,
      }),
    );
  } else {
    const hostMissing = (_request: Request, response: Response): void => {
      response
        .status(503)
        .type('text/plain')
        .send('The Host console UI is not built. Run `npm run build` and restart CodePair.');
    };
    app.get('/host', hostMissing);
    app.get('/host/', hostMissing);
  }

  app.use('/admin', (_request, _response, next) => {
    next(new AppError(404, 'NOT_FOUND', 'Unknown admin route.'));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const normalized = normalizeBodyParserError(error);
    const { status, payload } = toErrorPayload(normalized ?? error);
    if (status >= 500) (options.logger ?? console).error('[codepair] admin request failed:', error);
    if (response.headersSent) return;
    response.status(status).setHeader('Cache-Control', 'no-store').json(payload);
  });

  return app;
}

function loopbackOnly(port: () => number) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    for (const header of FORWARDED_HEADERS) {
      if (request.headers[header] !== undefined) {
        next(new AppError(403, 'FORBIDDEN', 'That request was proxied; the host console is loopback-only.'));
        return;
      }
    }

    const actual = port();
    const host = request.headers.host;
    // Fail closed: until the listener reports its port, no Host can match.
    if (!host || actual <= 0) {
      next(new AppError(403, 'FORBIDDEN', 'The host console only answers its loopback origin.'));
      return;
    }
    if (host !== `127.0.0.1:${actual}` && host !== `localhost:${actual}`) {
      next(new AppError(403, 'FORBIDDEN', 'The host console only answers its loopback origin.'));
      return;
    }

    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${actual}` && origin !== `http://localhost:${actual}`) {
      next(new AppError(403, 'FORBIDDEN', 'That origin may not reach the host console.'));
      return;
    }

    next();
  };
}

function taggedAuthenticator(authenticate: Authenticator) {
  return Object.assign(
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
    { [ADMIN_AUTHENTICATION]: true as const },
  );
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError(400, 'BAD_REQUEST', 'Expected a JSON object body.');
  }
  return value as Record<string, unknown>;
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
