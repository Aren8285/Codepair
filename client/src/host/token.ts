const STORAGE_KEY = 'codepair.host.token';
const PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;

/** Read the host token from `#admin=` (stripping it from the address bar) or sessionStorage. */
export function loadHostToken(): string | null {
  const hash = window.location.hash;
  if (hash.startsWith('#admin=')) {
    const token = decodeURIComponent(hash.slice('#admin='.length));
    if (PATTERN.test(token)) {
      storeHostToken(token);
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      return token;
    }
  }
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored && PATTERN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function storeHostToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // The page still works for this tab.
  }
}

export function clearHostToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

/** Accepts a raw token or the full `…/host#admin=…` link. */
export function parseHostToken(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.hash.startsWith('#admin=')) {
      const token = decodeURIComponent(url.hash.slice('#admin='.length));
      return PATTERN.test(token) ? token : null;
    }
  } catch {
    // Not a URL; try the raw token below.
  }
  return PATTERN.test(value) ? value : null;
}
