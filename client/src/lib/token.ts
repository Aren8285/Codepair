const STORAGE_KEY = 'codepair.token';
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;

/** Read the token from `#token=` (stripping it from the address bar) or sessionStorage. */
export function loadToken(): string | null {
  const hash = window.location.hash;
  if (hash.startsWith('#token=')) {
    const token = decodeURIComponent(hash.slice('#token='.length));
    if (TOKEN_PATTERN.test(token)) {
      storeToken(token);
      const clean = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, '', clean);
      return token;
    }
  }
  const stored = sessionStorage.getItem(STORAGE_KEY);
  return stored && TOKEN_PATTERN.test(stored) ? stored : null;
}

export function storeToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function buildShareUrl(token: string, roomId?: string): string {
  const path = roomId ? `/room/${encodeURIComponent(roomId)}` : '/';
  return `${window.location.origin}${path}#token=${encodeURIComponent(token)}`;
}

/** Accepts a raw token, a full access URL, or a room link with a token hash. */
export function parseAccessInput(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.hash.startsWith('#token=')) {
      const token = decodeURIComponent(url.hash.slice('#token='.length));
      return TOKEN_PATTERN.test(token) ? token : null;
    }
  } catch {
    // Not a URL; fall through to the raw-token check.
  }
  return TOKEN_PATTERN.test(value) ? value : null;
}

/** `/room/ab12-cd34` → `ab12-cd34`; anything else → null. */
export function roomFromPath(pathname: string): string | null {
  const match = /^\/room\/([a-z0-9]{1,8}-[a-z0-9]{1,8})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}
