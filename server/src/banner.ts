import os from 'node:os';
import { TERMINAL_BYPASS_WARNING, terminalBypassesRules, type ServerConfig } from './config.js';
import { SERVER_VERSION, createAccessUrl } from './server.js';

export interface BannerInfo {
  root: string;
  port: number;
  adminPort: number;
  adminToken: string;
  /** Public tunnel URL, when one was started. */
  tunnelUrl?: string;
}

/**
 * The startup banner. Extracted from `index.ts` so the terminal warning can be
 * asserted directly: a shell is not subject to the path access policy, and the
 * Host must not be told otherwise by silence.
 */
export function buildBanner(config: ServerConfig, info: BannerInfo): string {
  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const localBase = config.devClientUrl ?? `http://${formatHost(displayHost)}:${info.port}`;
  const roomId = config.roomId;

  const lines: string[] = [];
  lines.push('');
  lines.push(`  \u001b[38;5;39mCodePair\u001b[0m  \u001b[38;5;242mv${SERVER_VERSION}\u001b[0m`);
  lines.push('');
  lines.push(`  Project   ${info.root}`);
  // The Host console token is printed exactly once, in this URL fragment.
  lines.push('');
  lines.push(`  Host console: \u001b[4mhttp://127.0.0.1:${info.adminPort}/host#admin=${info.adminToken}\u001b[0m`);
  lines.push(
    '  \u001b[38;5;242m(console UI arrives in 0.4; until then use the value after #admin= as a Bearer token)\u001b[0m',
  );
  lines.push('');
  lines.push(`  Room      ${roomId}`);
  lines.push(`  Mode      ${config.tokens[0]?.role === 'viewer' ? 'read-only' : 'read-write'}`);
  lines.push(
    `  Terminal  ${
      config.terminalEnabled
        ? '\u001b[33menabled\u001b[0m — remote clients with terminal access get a real shell as ' +
          (process.env.USER ?? 'you')
        : 'disabled (--no-terminal)'
    }`,
  );
  if (terminalBypassesRules(config)) {
    lines.push(`  \u001b[33m${TERMINAL_BYPASS_WARNING}\u001b[0m`);
  }
  lines.push('');
  // One access URL per token, labelled by the role it grants. A raw token is
  // never printed outside the URL fragment (and only a generated one at all).
  for (const grant of config.tokens) {
    const url = createAccessUrl(info.tunnelUrl ?? localBase, grant.token, roomId);
    lines.push(`  Open      \u001b[4m${url}\u001b[0m  \u001b[38;5;242m(${grant.role})\u001b[0m`);
  }
  lines.push('');
  if (config.host === '0.0.0.0' || config.host === '::') {
    const lanPort = config.devClientUrl ? new URL(config.devClientUrl).port || info.port : info.port;
    const lanProtocol = config.devClientUrl?.startsWith('https') ? 'https' : 'http';
    for (const grant of config.tokens) {
      for (const url of networkUrls(grant.token, Number(lanPort), roomId, lanProtocol)) {
        lines.push(`  Network   ${url}  \u001b[38;5;242m(${grant.role})\u001b[0m`);
      }
    }
    lines.push('');
    lines.push('  \u001b[33mAnyone on this network with the link has the access you granted.\u001b[0m');
    lines.push('  \u001b[33mUse read-only mode for demos; prefer a VPN or trusted LAN.\u001b[0m');
  } else {
    lines.push('  Bound to loopback. Use --host 0.0.0.0 to share on your LAN.');
  }
  if (info.tunnelUrl) {
    lines.push('');
    for (const grant of config.tokens) {
      const url = createAccessUrl(info.tunnelUrl, grant.token, roomId);
      lines.push(`  Public    \u001b[4m${url}\u001b[0m  \u001b[38;5;242m(${grant.role})\u001b[0m`);
    }
    lines.push('  \u001b[33mThe tunnel URL is temporary; it disappears when this process stops.\u001b[0m');
  }
  lines.push('');
  lines.push('  Ctrl+C to stop. The token dies with the process.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function networkUrls(token: string, port: number, roomId: string, protocol = 'http'): string[] {
  const urls: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.push(createAccessUrl(`${protocol}://${address.address}:${port}`, token, roomId));
      }
    }
  }
  return urls;
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
