import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Docker probe for the candidate interview terminal. It never installs or pulls
 * anything: both the daemon and the configured image must already be present.
 */

export const DEFAULT_INTERVIEW_SANDBOX_IMAGE = 'node:22-bookworm-slim';

export interface InterviewSandboxStatus {
  readonly available: boolean;
  readonly image: string;
  readonly reason?: string;
}

export interface DockerInvocation {
  readonly file: 'docker';
  readonly args: string[];
}

export interface InterviewSandboxSpecInput {
  readonly root: string;
  readonly candidateDir: string;
  readonly image: string;
}

function runDocker(args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(detail || error.message));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

export async function probeInterviewSandbox(image: string): Promise<InterviewSandboxStatus> {
  if (!image.trim()) {
    return { available: false, image, reason: 'No sandbox image is configured.' };
  }
  try {
    await runDocker(['version', '--format', '{{.Server.Version}}']);
  } catch (error) {
    return {
      available: false,
      image,
      reason: `Docker is not available: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    await runDocker(['image', 'inspect', image]);
  } catch {
    return {
      available: false,
      image,
      reason: `The sandbox image ${image} is not present locally. Pull it separately; CodePair never pulls images.`,
    };
  }
  return { available: true, image };
}

/**
 * A fresh, unprivileged container with no network and only the interview
 * workspace writable. The root is read-only; the candidate folder is mounted
 * read-write over it. The container is removed by `--rm` when the shell exits.
 */
export function buildInterviewSandboxInvocation(input: InterviewSandboxSpecInput): DockerInvocation {
  const candidateDir = normalizeCandidateDir(input.candidateDir);
  const hostSolution = path.resolve(input.root, candidateDir);
  const containerSolution = `/workspace/${candidateDir}`;
  return {
    file: 'docker',
    args: [
      'run',
      '--rm',
      '--interactive',
      '--tty',
      '--network',
      'none',
      '--cpus',
      '1',
      '--memory',
      '512m',
      '--pids-limit',
      '128',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '1000:1000',
      '--workdir',
      '/workspace',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--env',
      'HOME=/tmp',
      '--volume',
      `${input.root}:/workspace:ro`,
      '--volume',
      `${hostSolution}:${containerSolution}:rw`,
      input.image,
      '/bin/sh',
      '-l',
    ],
  };
}

export function normalizeCandidateDir(candidateDir: string): string {
  const normalized = candidateDir.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('candidateDir must be a relative directory inside the project.');
  }
  return normalized;
}
