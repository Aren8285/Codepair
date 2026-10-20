import { spawn, type ChildProcess } from 'node:child_process';
import type { TunnelProvider } from './config.js';

export interface Tunnel {
  publicUrl: string;
  provider: TunnelProvider;
  stop(): Promise<void>;
}

interface TunnelCommand {
  command: string;
  args: string[];
  urlPattern: RegExp;
  installHint: string;
}

const START_TIMEOUT_MS = 25_000;

function commandFor(provider: TunnelProvider, port: number): TunnelCommand {
  if (provider === 'cloudflare') {
    return {
      command: 'cloudflared',
      args: ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
      urlPattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
      installHint: 'Install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    };
  }
  return {
    command: 'ngrok',
    args: ['http', `${port}`, '--log', 'stdout'],
    urlPattern: /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.app/,
    installHint: 'Install ngrok from https://ngrok.com/download and run `ngrok config add-authtoken <token>` first.',
  };
}

/**
 * Starts a provider CLI as a child process and waits for it to print the
 * public HTTPS URL. The tunnel stays authenticated by the same session token
 * as LAN access: the public link still needs the token hash. Tunnel
 * credentials belong to the CLI's own config and are never read here.
 */
export async function startTunnel(provider: TunnelProvider, port: number, logger: Pick<Console, 'error'> = console): Promise<Tunnel> {
  const spec = commandFor(provider, port);
  const child = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await terminate(child);
  };

  const publicUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      void stop();
      reject(new Error(`${provider} tunnel did not report a URL within ${START_TIMEOUT_MS / 1000}s.\n${tail(output)}`));
    }, START_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 16_000) output = output.slice(-8_000);
      const match = spec.urlPattern.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new Error(`${spec.command} is not installed. ${spec.installHint}`));
        return;
      }
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!stopped) reject(new Error(`${provider} tunnel exited with code ${code ?? 'unknown'}.\n${tail(output)}`));
    });
  }).catch((error: unknown) => {
    logger.error(`[codepair] tunnel failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });

  return { publicUrl, provider, stop };
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(force);
      resolve();
    }
  });
}

function tail(output: string): string {
  return output.trim().split('\n').slice(-6).join('\n');
}
