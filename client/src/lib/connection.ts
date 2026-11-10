const STORAGE_KEY = 'codepair.connection';
const PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function freshId(): string {
  const cryptoApi = window.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(18);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/**
 * One id per tab, shared by every surface (HTTP, doc, terminal, signal) so the
 * Host can admit or remove a whole tab in one action. sessionStorage keeps two
 * tabs in the same browser distinct, exactly like the presence identity.
 */
export function currentConnectionId(): string {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored && PATTERN.test(stored)) return stored;
  } catch {
    // Storage can be unavailable; a page-lifetime id is still enough.
  }
  const id = freshId();
  storeConnectionId(id);
  return id;
}

/** A denied/removed tab asks again as someone new, without a reload. */
export function rotateConnectionId(): string {
  const id = freshId();
  storeConnectionId(id);
  return id;
}

function storeConnectionId(id: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Ignore: the id simply will not survive a reload.
  }
}
