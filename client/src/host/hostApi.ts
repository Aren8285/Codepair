import type { LobbySnapshot } from '../lib/api';

export interface HostSessionState {
  session: { id: string; rootName: string; rootPath: string; createdAt: number };
  openDocuments: number;
  documentConnections: number;
  terminals: number;
  terminalBypassesRules: boolean;
}

export class HostApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostApiError';
  }
}

/** The loopback Host console API. Every call carries the admin Bearer token. */
export class HostApi {
  constructor(private readonly token: string) {}

  eventsUrl(): string {
    return `/admin/api/events?token=${encodeURIComponent(this.token)}`;
  }

  snapshot(): Promise<LobbySnapshot> {
    return this.request<LobbySnapshot>('/admin/api/lobby');
  }

  sessionState(): Promise<HostSessionState> {
    return this.request<HostSessionState>('/admin/api/state');
  }

  admit(id: string, role: 'editor' | 'viewer'): Promise<unknown> {
    return this.request(`/admin/api/lobby/${encodeURIComponent(id)}/admit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
  }

  deny(id: string): Promise<unknown> {
    return this.request(`/admin/api/lobby/${encodeURIComponent(id)}/deny`, { method: 'POST' });
  }

  lock(locked: boolean): Promise<LobbySnapshot> {
    return this.request<LobbySnapshot>('/admin/api/lobby/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked }),
    });
  }

  kick(connectionId: string): Promise<void> {
    return this.request<void>(`/admin/api/connections/${encodeURIComponent(connectionId)}/kick`, {
      method: 'POST',
    });
  }

  private async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(route, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new HostApiError(0, 'NETWORK', 'Cannot reach the host console listener.');
    }

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    if (!response.ok) {
      const payload = body as { error?: { code?: string; message?: string } } | undefined;
      throw new HostApiError(
        response.status,
        payload?.error?.code ?? 'HTTP_ERROR',
        payload?.error?.message ?? `Request failed with ${response.status}.`,
      );
    }
    return body as T;
  }
}
