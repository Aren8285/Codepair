import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Constant-time token comparison; hashing first avoids leaking length. */
export function tokensMatch(provided: string | undefined | null, expected: string): boolean {
  if (!provided) return false;
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function tokenFromAuthorizationHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Browsers cannot set headers on a WebSocket. Instead the client offers the
 * protocols ["codepair", token] and the server selects "codepair" only.
 * This keeps the token out of URLs, access logs and Referer headers.
 */
export const WS_PROTOCOL = 'codepair';

export function tokenFromWebSocketHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const protocols = header.split(',').map((value) => value.trim());
  if (!protocols.includes(WS_PROTOCOL)) return undefined;
  return protocols.find((value) => value !== WS_PROTOCOL);
}

export function isOriginAllowed(origin: string | undefined, host: string | undefined, allowedOrigins: string[]): boolean {
  // Non-browser clients (tests, curl) omit Origin. They still need a valid token.
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    return Boolean(host) && parsed.host === host;
  } catch {
    return false;
  }
}

export function extractHost(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  return typeof host === 'string' ? host : undefined;
}
