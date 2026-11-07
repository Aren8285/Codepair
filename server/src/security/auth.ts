import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { makePrincipal, type Principal, type Role } from './principal.js';

export interface TokenGrant {
  readonly token: string;
  readonly role: Role;
}

export type HashCompare = (left: Buffer, right: Buffer) => boolean;

/** Resolve a presented token to a fresh Principal, or null when it is not valid. */
export type Authenticator = (rawToken: string | undefined | null) => Principal | null;

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/**
 * Build the token→role lookup once, at startup.
 *
 * Each configured token is hashed a single time, so request handling only hashes
 * the presented value. Every grant is compared on every attempt — including
 * after a match — so timing reveals neither which token matched nor how many are
 * configured. Hashing first also equalises buffer lengths, so a short or long
 * guess cannot make `timingSafeEqual` throw or short-circuit.
 */
export function createAuthenticator(
  grants: readonly TokenGrant[],
  compare: HashCompare = timingSafeEqual,
): Authenticator {
  const entries = grants.map((grant) => ({ hash: hashToken(grant.token), role: grant.role }));
  return (rawToken) => {
    if (typeof rawToken !== 'string' || rawToken.length === 0) return null;
    const presented = hashToken(rawToken);
    let matched: Role | undefined;
    for (const entry of entries) {
      if (compare(presented, entry.hash) && matched === undefined) matched = entry.role;
    }
    return matched === undefined ? null : makePrincipal(matched);
  };
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
