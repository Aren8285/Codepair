import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type AccessMode = 'read-only' | 'read-write';
export type TunnelProvider = 'cloudflare' | 'ngrok';

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface ServerConfig {
  /** Absolute path of the shared directory. */
  root: string;
  host: string;
  port: number;
  mode: AccessMode;
  /** Random per-process access token. */
  token: string;
  tokenWasGenerated: boolean;
  /** Stable room identifier for this session (signalling + share links). */
  roomId: string;
  /** Dev-only: origin of the Vite server, used in the printed link and WS origin checks. */
  devClientUrl?: string;
  /** Extra browser origins accepted by the WebSocket upgrade. */
  allowedOrigins: string[];
  saveDebounceMs: number;
  maxFileBytes: number;
  terminalEnabled: boolean;
  iceServers: IceServerConfig[];
  tunnelProvider?: TunnelProvider;
  clientDist: string;
  quiet: boolean;
}

export class ConfigError extends Error {
  readonly code = 'CONFIG_ERROR';
}

const DEFAULT_PORT = 7420;
const MAX_TOKEN_BYTES = 512;

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Room links look like `/room/xyz-123`; ids are random, short and URL-safe. */
export function generateRoomId(): string {
  const hex = randomBytes(4).toString('hex');
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

export function parseConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const flags = parseFlags(argv);
  const rootInput = flagValue(flags, 'root') ?? cwd;
  const root = path.resolve(cwd, rootInput);

  const modeRaw = (flagValue(flags, 'mode') ?? env.CODE_PAIR_MODE ?? 'read-write').toLowerCase();
  if (modeRaw !== 'read-only' && modeRaw !== 'read-write' && modeRaw !== 'ro' && modeRaw !== 'rw') {
    throw new ConfigError(`Invalid mode "${modeRaw}". Use "read-only" or "read-write".`);
  }
  const mode: AccessMode = modeRaw === 'read-only' || modeRaw === 'ro' ? 'read-only' : 'read-write';

  const portRaw = flagValue(flags, 'port') ?? env.CODE_PAIR_PORT ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`Invalid port "${portRaw}".`);
  }

  const host = flagValue(flags, 'host') ?? env.CODE_PAIR_HOST ?? '127.0.0.1';
  if (!host.trim()) throw new ConfigError('Host must not be empty.');

  const envToken = flagValue(flags, 'token') ?? env.CODE_PAIR_TOKEN;
  if (envToken !== undefined && (envToken.length < 16 || Buffer.byteLength(envToken) > MAX_TOKEN_BYTES)) {
    throw new ConfigError('Access token must be between 16 and 512 bytes.');
  }
  const token = envToken ?? generateToken();
  if (!/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new ConfigError(
      'Access token may only contain letters, digits, dot, underscore, tilde or hyphen (it is sent as a WebSocket subprotocol).',
    );
  }

  const devClientUrl = flagValue(flags, 'dev-client') ?? env.CODE_PAIR_DEV_CLIENT;
  if (devClientUrl) assertOrigin(devClientUrl, 'dev client URL');

  const allowedOrigins = [
    ...(flagValue(flags, 'allow-origin') ?? env.CODE_PAIR_ALLOW_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    ...(devClientUrl ? [new URL(devClientUrl).origin] : []),
  ];
  for (const origin of allowedOrigins) assertOrigin(origin, 'allowed origin');

  const tunnelRaw = flagValue(flags, 'tunnel') ?? env.CODE_PAIR_TUNNEL;
  if (tunnelRaw && tunnelRaw !== 'cloudflare' && tunnelRaw !== 'ngrok') {
    throw new ConfigError('--tunnel must be "cloudflare" or "ngrok".');
  }

  return {
    root,
    host,
    port,
    mode,
    token,
    tokenWasGenerated: envToken === undefined,
    roomId: generateRoomId(),
    devClientUrl: devClientUrl ? devClientUrl.replace(/\/$/, '') : undefined,
    allowedOrigins: [...new Set(allowedOrigins)],
    saveDebounceMs: Number(env.CODE_PAIR_SAVE_DEBOUNCE_MS ?? 300),
    maxFileBytes: Number(env.CODE_PAIR_MAX_FILE_BYTES ?? 5 * 1024 * 1024),
    terminalEnabled: !flags['no-terminal'] && env.CODE_PAIR_TERMINAL !== 'off',
    iceServers: parseIceServers(flagValue(flags, 'ice-servers') ?? env.CODE_PAIR_ICE_SERVERS),
    tunnelProvider: tunnelRaw as TunnelProvider | undefined,
    clientDist: path.resolve(
      env.CODE_PAIR_CLIENT_DIST ??
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist'),
    ),
    quiet: Boolean(flags.quiet),
  };
}

function flagValue(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function parseFlags(argv: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || !arg.startsWith('--')) continue;
    const equals = arg.indexOf('=');
    if (equals !== -1) {
      result[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      if (name === 'allow-origin' && typeof result[name] === 'string') {
        result[name] = `${result[name]},${next}`;
      } else {
        result[name] = next;
      }
      index += 1;
    } else {
      result[name] = true;
    }
  }
  return result;
}

function assertOrigin(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`Invalid ${label}: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${label} must use http(s): ${value}`);
  }
  if (parsed.origin === 'null') throw new ConfigError(`Invalid ${label}: ${value}`);
}

const MAX_ICE_SERVERS = 8;

function parseIceServers(raw: string | undefined): IceServerConfig[] {
  const fallback: IceServerConfig[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (!raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('CODE_PAIR_ICE_SERVERS must be a JSON array of RTCIceServer objects.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ICE_SERVERS) {
    throw new ConfigError(`CODE_PAIR_ICE_SERVERS must be an array with 1..${MAX_ICE_SERVERS} entries.`);
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`CODE_PAIR_ICE_SERVERS[${index}] must be an object.`);
    }
    const candidate = entry as Record<string, unknown>;
    const urls = candidate.urls;
    const validUrls =
      (typeof urls === 'string' && urls.length > 0) ||
      (Array.isArray(urls) && urls.length > 0 && urls.every((url) => typeof url === 'string' && url.length > 0));
    if (!validUrls) {
      throw new ConfigError(`CODE_PAIR_ICE_SERVERS[${index}].urls must be a non-empty string or string array.`);
    }
    const server: IceServerConfig = { urls: urls as string | string[] };
    if (candidate.username !== undefined) {
      if (typeof candidate.username !== 'string') {
        throw new ConfigError(`CODE_PAIR_ICE_SERVERS[${index}].username must be a string.`);
      }
      server.username = candidate.username;
    }
    if (candidate.credential !== undefined) {
      if (typeof candidate.credential !== 'string') {
        throw new ConfigError(`CODE_PAIR_ICE_SERVERS[${index}].credential must be a string.`);
      }
      server.credential = candidate.credential;
    }
    return server;
  });
}

export function normalizeMode(value: string | undefined): AccessMode {
  return value === 'read-only' ? 'read-only' : 'read-write';
}
