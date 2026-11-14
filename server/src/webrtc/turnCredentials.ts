import { createHmac, randomBytes } from 'node:crypto';

/**
 * coturn's REST-API credential format:
 *   username   = `${unixExpiry}:${label}`
 *   credential = base64(HMAC-SHA1(static-auth-secret, username))
 *
 * The label is deliberately random and carries no identity. coturn enforces
 * the expiry; this daemon only stamps and signs it.
 */
export interface TurnCredential {
  username: string;
  credential: string;
  ttl: number;
}

export function mintTurnCredential(
  secret: string,
  ttlSeconds = 3600,
  clock: () => number = Date.now,
  label = randomBytes(8).toString('base64url'),
): TurnCredential {
  const ttl = Math.floor(ttlSeconds);
  const expiry = Math.floor(clock() / 1000) + ttl;
  const username = `${expiry}:${label}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, ttl };
}
