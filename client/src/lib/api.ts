export type AccessMode = 'read-only' | 'read-write';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SessionInfo {
  mode: AccessMode;
  rootName: string;
  roomId: string;
  version: string;
  startedAt: number;
  capabilities: { write: boolean; terminal: boolean; upload: boolean };
  limits: { maxFileBytes: number };
  rtc: { iceServers: IceServer[] };
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: number;
  symlink?: boolean;
  blocked?: boolean;
}

export interface TreeResponse {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface SearchResponse {
  query: string;
  entries: Array<Pick<FileEntry, 'name' | 'path' | 'type'>>;
  truncated: boolean;
}

export interface FileResponse {
  path: string;
  content: string;
  size: number;
  mtime: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class ApiClient {
  constructor(private readonly token: string) {}

  session(signal?: AbortSignal): Promise<SessionInfo> {
    return this.request<SessionInfo>('/api/session', { signal });
  }

  tree(path = '', signal?: AbortSignal): Promise<TreeResponse> {
    return this.request<TreeResponse>(`/api/tree?path=${encodeURIComponent(path)}`, { signal });
  }

  readFile(path: string): Promise<FileResponse> {
    return this.request<FileResponse>(`/api/file?path=${encodeURIComponent(path)}`);
  }

  search(query: string, signal?: AbortSignal): Promise<SearchResponse> {
    return this.request<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}`, { signal });
  }

  createFile(path: string, type: 'file' | 'directory', content = ''): Promise<{ entry: FileEntry }> {
    return this.request('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, type, content }),
    });
  }

  rename(from: string, to: string): Promise<{ entry: FileEntry }> {
    return this.request('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
  }

  remove(path: string): Promise<{ path: string }> {
    return this.request(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
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
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'NETWORK', 'Cannot reach the CodePair host. Check the connection.');
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
      throw new ApiError(
        response.status,
        payload?.error?.code ?? 'HTTP_ERROR',
        payload?.error?.message ?? `Request failed with ${response.status}.`,
      );
    }

    return body as T;
  }
}

export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PATH_ESCAPE':
      case 'INVALID_PATH':
        return 'Blocked: that path is outside the shared project.';
      case 'READ_ONLY':
        return 'This session is read-only.';
      case 'PROTECTED_PATH':
        return error.message;
      case 'FILE_TOO_LARGE':
      case 'BINARY_FILE':
        return error.message;
      case 'UNAUTHORIZED':
        return 'Your access token was rejected. Reconnect with a valid link.';
      default:
        return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
