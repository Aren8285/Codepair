import os from 'node:os';
import { ConfigError, parseConfig } from './config.js';
import { createAccessUrl, createCodepairServer } from './server.js';
import { startTunnel, type Tunnel } from './tunnel.js';

const HELP = `CodePair — hybrid local-host collaborative IDE

Usage: codepair [options]

Options:
  --root <dir>              Directory to expose (default: current directory)
  --host <host>             Bind address (default: 127.0.0.1, use 0.0.0.0 for LAN)
  --port <port>             Port (default: 7420)
  --mode <mode>             "read-write" (default) or "read-only"
  --token <token>           Primary token: owner access, or viewer with --mode read-only
                            (default: random per start)
  --editor-token <token>    Extra token with editor access (not read-only)
  --viewer-token <token>    Extra token with view-only access
  --allow-origin <origin>   Extra WebSocket origin allowed (repeatable)
  --no-terminal             Disable the remote terminal (explicit opt-out)
  --tunnel <provider>       "cloudflare" or "ngrok" public tunnel
  --ice-servers <json>      JSON array of RTCIceServer objects (STUN/TURN)
  --dev-client <url>        Vite dev server origin, used in the printed link
  --quiet                   Less startup output
  --help                    Show this help
  --version                 Print the version

Environment:
  CODE_PAIR_MODE, CODE_PAIR_TOKEN, CODE_PAIR_PORT, CODE_PAIR_HOST,
  CODE_PAIR_ALLOW_ORIGINS, CODE_PAIR_DEV_CLIENT, CODE_PAIR_TERMINAL=off,
  CODE_PAIR_TUNNEL, CODE_PAIR_ICE_SERVERS, CODE_PAIR_MAX_FILE_BYTES,
  CODE_PAIR_SAVE_DEBOUNCE_MS, CODE_PAIR_IGNORE

Security note:
  Holding the access token is equivalent to being allowed to edit this project
  and, unless --no-terminal is used, to run commands as your user on this
  machine. Only share the link with people you trust, or run read-only.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version')) {
    process.stdout.write('0.3.0\n');
    return;
  }

  const config = parseConfig(argv);
  const server = await createCodepairServer(config);
  const { port } = await server.start();

  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const localBase = config.devClientUrl ?? `http://${formatHost(displayHost)}:${port}`;

  let tunnel: Tunnel | undefined;
  if (config.tunnelProvider) {
    try {
      tunnel = await startTunnel(config.tunnelProvider, port);
    } catch (error) {
      console.error(
        `\n  [codepair] Public tunnel unavailable: ${error instanceof Error ? error.message : String(error)}\n` +
          '  The Host is still reachable on the LAN only.\n',
      );
    }
  }

  if (!config.quiet) {
    const lines: string[] = [];
    lines.push('');
    lines.push('  \u001b[38;5;39mCodePair\u001b[0m  \u001b[38;5;242mv0.3.0\u001b[0m');
    lines.push('');
    lines.push(`  Project   ${server.guard.root}`);
    lines.push(`  Room      ${config.roomId}`);
    lines.push(`  Mode      ${config.tokens[0]?.role === 'viewer' ? 'read-only' : 'read-write'}`);
    lines.push(
      `  Terminal  ${
        config.terminalEnabled
          ? '\u001b[33menabled\u001b[0m — remote clients with terminal access get a real shell as ' +
            (process.env.USER ?? 'you')
          : 'disabled (--no-terminal)'
      }`,
    );
    lines.push('');
    // One access URL per token, labelled by the role it grants. A raw token is
    // never printed outside the URL fragment (and only a generated one at all).
    for (const grant of config.tokens) {
      const url = createAccessUrl(tunnel?.publicUrl ?? localBase, grant.token, config.roomId);
      lines.push(`  Open      \u001b[4m${url}\u001b[0m  \u001b[38;5;242m(${grant.role})\u001b[0m`);
    }
    lines.push('');
    if (config.host === '0.0.0.0' || config.host === '::') {
      const lanPort = config.devClientUrl ? new URL(config.devClientUrl).port || port : port;
      const lanProtocol = config.devClientUrl?.startsWith('https') ? 'https' : 'http';
      for (const grant of config.tokens) {
        for (const url of networkUrls(grant.token, Number(lanPort), config.roomId, lanProtocol)) {
          lines.push(`  Network   ${url}  \u001b[38;5;242m(${grant.role})\u001b[0m`);
        }
      }
      lines.push('');
      lines.push('  \u001b[33mAnyone on this network with the link has the access you granted.\u001b[0m');
      lines.push('  \u001b[33mUse read-only mode for demos; prefer a VPN or trusted LAN.\u001b[0m');
    } else {
      lines.push('  Bound to loopback. Use --host 0.0.0.0 to share on your LAN.');
    }
    if (tunnel) {
      lines.push('');
      for (const grant of config.tokens) {
        const url = createAccessUrl(tunnel.publicUrl, grant.token, config.roomId);
        lines.push(`  Public    \u001b[4m${url}\u001b[0m  \u001b[38;5;242m(${grant.role})\u001b[0m`);
      }
      lines.push('  \u001b[33mThe tunnel URL is temporary; it disappears when this process stops.\u001b[0m');
    }
    lines.push('');
    lines.push('  Ctrl+C to stop. The token dies with the process.');
    lines.push('');
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!config.quiet) process.stdout.write(`\n  ${signal}: saving open files and shutting down…\n`);
    try {
      await tunnel?.stop();
      await server.close();
      process.exit(0);
    } catch (error) {
      console.error('[codepair] shutdown failed:', error);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
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

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`\n  Configuration error: ${error.message}\n`);
    process.exit(1);
  }
  console.error('\n  CodePair failed to start:\n', error);
  process.exit(1);
});
