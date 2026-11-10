import { buildBanner } from './banner.js';
import { ConfigError, parseConfig } from './config.js';
import { createCodepairServer } from './server.js';
import { startTunnel, type Tunnel } from './tunnel.js';
import { createTunnelState, detectCloudflaredInstalled } from './tunnelStatus.js';

const HELP = `CodePair — hybrid local-host collaborative IDE

Usage: codepair [options]

Options:
  --root <dir>              Directory to expose (default: current directory)
  --host <host>             Bind address (default: 127.0.0.1, use 0.0.0.0 for LAN)
  --port <port>             Port (default: 7420)
  --admin-port <port>       Loopback-only Host console port (default: port + 1)
  --mode <mode>             "read-write" (default) or "read-only"
  --token <token>           Primary token: owner access, or viewer with --mode read-only
                            (default: random per start)
  --editor-token <token>    Extra token with editor access (not read-only)
  --viewer-token <token>    Extra token with view-only access
  --no-lobby                Admit every authenticated guest immediately
  --lobby-timeout <sec>     Pending request lifetime, 1-3600 (default: 120)
  --allow-origin <origin>   Extra WebSocket origin allowed (repeatable)
  --no-terminal             Disable the remote terminal (explicit opt-out)
  --rule <glob=access>      Path rule: hidden, r or rw (repeatable, max 50)
  --confirm-unhide          Let --rule lift a built-in secret default
  --tunnel <provider>       "cloudflare" or "ngrok" public tunnel
  --ice-servers <json>      JSON array of RTCIceServer objects (STUN/TURN)
  --dev-client <url>        Vite dev server origin, used in the printed link
  --quiet                   Less startup output
  --help                    Show this help
  --version                 Print the version

Environment:
  CODE_PAIR_MODE, CODE_PAIR_TOKEN, CODE_PAIR_PORT, CODE_PAIR_ADMIN_PORT, CODE_PAIR_HOST,
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
    process.stdout.write('0.5.0\n');
    return;
  }

  const config = parseConfig(argv);
  const tunnelState = createTunnelState(config.tunnelProvider, () => detectCloudflaredInstalled());
  const server = await createCodepairServer(config, { tunnelStatus: () => tunnelState.status() });
  const { port, adminPort } = await server.start();

  let tunnel: Tunnel | undefined;
  if (config.tunnelProvider) {
    try {
      tunnel = await startTunnel(config.tunnelProvider, port);
      tunnelState.setPublicUrl(tunnel.publicUrl);
    } catch (error) {
      tunnelState.setPublicUrl(null);
      console.error(
        `\n  [codepair] Public tunnel unavailable: ${error instanceof Error ? error.message : String(error)}\n` +
          '  The Host is still reachable on the LAN only.\n',
      );
    }
  }

  if (!config.quiet) {
    process.stdout.write(
      buildBanner(config, {
        root: server.root,
        port,
        adminPort,
        adminToken: server.admin.token,
        tunnelUrl: tunnel?.publicUrl,
      }),
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!config.quiet) process.stdout.write(`\n  ${signal}: saving open files and shutting down…\n`);
    try {
      await tunnel?.stop();
      tunnelState.setPublicUrl(null);
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

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`\n  Configuration error: ${error.message}\n`);
    process.exit(1);
  }
  console.error('\n  CodePair failed to start:\n', error);
  process.exit(1);
});
