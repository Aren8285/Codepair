import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AppError, toErrorPayload, unauthorized } from '../errors.js';
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
