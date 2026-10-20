import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ShellSetup {
  shell: string;
  args: string[];
  env: Record<string, string>;
  rcDir: string;
  shellName: 'zsh' | 'bash' | 'sh';
}

/**
 * Build a minimal environment for the PTY. The server's own environment is
 * intentionally not inherited: API keys and tokens belonging to the host must
 * never leak through `env` in the remote terminal.
 */
export function createShellSetup(projectRoot: string): ShellSetup {
  const rcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepair-shell-'));
  fs.chmodSync(rcDir, 0o700);
  const shell = chooseShell();
  const shellName = detectShell(shell);
  const root = shellSingleQuote(projectRoot);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? os.homedir(),
    USER: process.env.USER ?? 'codepair',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'codepair',
    SHELL: shell,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    PWD: projectRoot,
    CODE_PAIR_ROOT: projectRoot,
  };

  if (shellName === 'zsh') {
    fs.writeFileSync(path.join(rcDir, '.zshrc'), zshRc(root), { mode: 0o600 });
    env.ZDOTDIR = rcDir;
    return { shell, args: ['-i'], env, rcDir, shellName };
  }

  if (shellName === 'bash') {
    const rcFile = path.join(rcDir, 'bashrc');
    fs.writeFileSync(rcFile, bashRc(root), { mode: 0o600 });
    return { shell, args: ['--noprofile', '--rcfile', rcFile, '-i'], env, rcDir, shellName };
  }

  const rcFile = path.join(rcDir, 'profile');
  fs.writeFileSync(rcFile, shRc(root), { mode: 0o600 });
  env.ENV = rcFile;
  return { shell, args: ['-i'], env, rcDir, shellName };
}

export function cleanupShellSetup(setup: ShellSetup | undefined): void {
  if (!setup) return;
  fs.rmSync(setup.rcDir, { recursive: true, force: true });
}

/** Quote a value for safe embedding inside a POSIX shell script. */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function chooseShell(): string {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next shell.
    }
  }
  return '/bin/sh';
}

function detectShell(shell: string): 'zsh' | 'bash' | 'sh' {
  const name = path.basename(shell);
  if (name.includes('zsh')) return 'zsh';
  if (name.includes('bash')) return 'bash';
  return 'sh';
}

function zshRc(quotedRoot: string): string {
  return `# Managed by CodePair. Do not edit; regenerated per server start.
unset HISTFILE
HISTSIZE=1000
SAVEHIST=0
setopt HIST_IGNORE_ALL_DUPS 2>/dev/null
export CODE_PAIR_ROOT=${quotedRoot}
export TERM=xterm-256color
export CLICOLOR=1

_codepair_outside() {
  local resolved="\${PWD:A}"
  if [[ "$resolved" != "$CODE_PAIR_ROOT" && "$resolved" != "$CODE_PAIR_ROOT"/* ]]; then
    print -u2 ""
    print -u2 $'\\033[31mcodepair: blocked: '"$resolved"' is outside the project root\\033[0m'
    print -u2 $'\\033[38;5;242mcodepair: the shell is not a security boundary; do not paste untrusted commands.\\033[0m'
    return 1
  fi
  return 0
}

_codepair_prompt() {
  local rel="\${PWD#$CODE_PAIR_ROOT}"
  if [[ -z "$rel" ]]; then rel="~"; else rel="~$rel"; fi
  PROMPT=$'%F{39}codepair%f %F{242}'"\${rel//\\%/%%}"$'%f %# '
  printf '\\033]7;file://%s%s\\007' "$(hostname)" "$PWD"
}

_codepair_prompt

autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook precmd _codepair_prompt
else
  precmd_functions+=(_codepair_prompt)
fi

cd() {
  builtin cd -- "\${1:-$CODE_PAIR_ROOT}" || return 1
  if ! _codepair_outside; then
    builtin cd -- "$OLDPWD" >/dev/null 2>&1
    return 1
  fi
  return 0
}

pushd() {
  builtin pushd "$@" >/dev/null 2>&1 || return 1
  if ! _codepair_outside; then
    builtin cd -- "$CODE_PAIR_ROOT" >/dev/null 2>&1
    return 1
  fi
  builtin dirs
}
`;
}

function bashRc(quotedRoot: string): string {
  return `# Managed by CodePair. Do not edit; regenerated per server start.
unset HISTFILE
HISTSIZE=1000
HISTCONTROL=ignoredups
export CODE_PAIR_ROOT=${quotedRoot}
export TERM=xterm-256color
PS1='\\[\\e[38;5;39m\\]codepair\\[\\e[0m\\] \\[\\e[38;5;242m\\]~\\[\\e[0m\\] \\$ '
# Keep host paths out of the prompt and prevent a crafted filename from
# being evaluated as a command substitution when PS1 is expanded.
shopt -u promptvars 2>/dev/null

_codepair_outside() {
  case "$(pwd -P)" in
    "$CODE_PAIR_ROOT"|"$CODE_PAIR_ROOT"/*) return 0 ;;
    *)
      printf '\\n\\033[31mcodepair: blocked: %s is outside the project root\\033[0m\\n' "$(pwd -P)" >&2
      printf '\\033[38;5;242mcodepair: the shell is not a security boundary; do not paste untrusted commands.\\033[0m\\n' >&2
      return 1
      ;;
  esac
}

_codepair_prompt() {
  local rel="\${PWD#$CODE_PAIR_ROOT}"
  if [ -z "$rel" ]; then rel="~"; else rel="~$rel"; fi
  rel="\${rel//\\\\/\\\\\\\\}"
  PS1='\\[\\e[38;5;39m\\]codepair\\[\\e[0m\\] \\[\\e[38;5;242m\\]'"$rel"'\\[\\e[0m\\] \\$ '
  printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-localhost}" "$PWD"
}
_codepair_prompt
PROMPT_COMMAND="_codepair_prompt\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"

cd() {
  builtin cd -- "\${1:-$CODE_PAIR_ROOT}" || return 1
  if ! _codepair_outside; then
    builtin cd -- "$OLDPWD" >/dev/null 2>&1
    return 1
  fi
  return 0
}

pushd() {
  builtin pushd "$@" >/dev/null 2>&1 || return 1
  if ! _codepair_outside; then
    builtin cd -- "$CODE_PAIR_ROOT" >/dev/null 2>&1
    return 1
  fi
  dirs
}
`;
}

function shRc(quotedRoot: string): string {
  return `# Managed by CodePair. Do not edit; regenerated per server start.
CODE_PAIR_ROOT=${quotedRoot}
export CODE_PAIR_ROOT
PS1='codepair $ '
cd() {
  builtin cd -- "\${1:-$CODE_PAIR_ROOT}" || return 1
  case "$(pwd -P)" in
    "$CODE_PAIR_ROOT"|"$CODE_PAIR_ROOT"/*) return 0 ;;
    *)
      builtin cd -- "$OLDPWD" >/dev/null 2>&1
      printf '\\ncodepair: blocked: outside the project root\\n' >&2
      return 1
      ;;
  esac
}
`;
}

export function newTerminalId(): string {
  return randomUUID();
}
