import fs from 'node:fs';
import path from 'node:path';
export type TunnelProvider = 'cloudflare' | 'ngrok';

export interface TunnelStatus {
  configured: boolean;
  provider: TunnelProvider | null;
  running: boolean;
  publicUrl: string | null;
  cloudflaredInstalled: boolean;
  installInstructions: string | null;
}

/**
 * Cheap, local detection only. This never spawns cloudflared and never fetches
 * anything: it checks the executable paths a normal install uses.
 */
export function detectCloudflaredInstalled(_env: NodeJS.ProcessEnv = process.env): boolean {
  const candidates = [
    ...(_env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'cloudflared')),
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // Try the next known location.
    }
  }
  return false;
}

export interface TunnelState {
  status(): TunnelStatus;
  setPublicUrl(publicUrl: string | null): void;
}

/** Mutable state owned by the daemon; the admin API only reads a snapshot. */
export function createTunnelState(
  provider: TunnelProvider | undefined,
  detect: () => boolean = () => detectCloudflaredInstalled(),
): TunnelState {
  let publicUrl: string | null = null;
  return {
    status(): TunnelStatus {
      const installed = detect();
      return {
        configured: provider !== undefined,
        provider: provider ?? null,
        running: publicUrl !== null,
        publicUrl,
        cloudflaredInstalled: installed,
        installInstructions: tunnelInstructions(provider ?? null, installed, publicUrl !== null),
      };
    },
    setPublicUrl(next: string | null): void {
      publicUrl = next;
    },
  };
}

export function tunnelInstructions(
  provider: TunnelProvider | null,
  installed: boolean,
  running: boolean,
): string | null {
  if (provider === null) {
    return [
      installed
        ? 'cloudflared is installed, but this daemon was started without a tunnel.'
        : 'cloudflared is not installed. Install it first (for example: brew install cloudflared).',
      'Restart CodePair with --tunnel cloudflare (or CODE_PAIR_TUNNEL=cloudflare) to publish a public URL.',
      'Docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    ].join(' ');
  }

  if (running) return null;
  if (!installed) {
    return [
      `cloudflared is not installed, so the ${provider} tunnel could not start.`,
      'Install it (for example: brew install cloudflared), then restart CodePair with --tunnel cloudflare.',
      'Docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    ].join(' ');
  }
  return `The ${provider} tunnel is configured but not running. Check the startup output, then restart CodePair with --tunnel ${provider}.`;
}
