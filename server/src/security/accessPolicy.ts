import { AppError } from '../errors.js';
import { compileGlob, normalizeForMatch, normalizePathForMatch, type CompiledGlob } from './glob.js';
import type { Capability } from './principal.js';

export type Access = 'hidden' | 'r' | 'rw';

export interface Rule {
  readonly pattern: string;
  readonly access: Access;
}

export interface EffectiveAccess {
  readonly read: boolean;
  readonly write: boolean;
  readonly visible: boolean;
}

/** Secrets that are hidden in every session unless the Host confirms otherwise. */
export const DEFAULT_SECRET_RULES: readonly Rule[] = [
  { pattern: '.env', access: 'hidden' },
  { pattern: '.env.*', access: 'hidden' },
  { pattern: '*.pem', access: 'hidden' },
  { pattern: '*.key', access: 'hidden' },
  { pattern: '*.p12', access: 'hidden' },
  { pattern: '*.pfx', access: 'hidden' },
  { pattern: 'id_rsa*', access: 'hidden' },
  { pattern: 'id_ed25519*', access: 'hidden' },
  { pattern: 'id_ecdsa*', access: 'hidden' },
  { pattern: '.npmrc', access: 'hidden' },
  { pattern: '.netrc', access: 'hidden' },
  { pattern: '.pypirc', access: 'hidden' },
  { pattern: '.aws/**', access: 'hidden' },
  { pattern: '.ssh/**', access: 'hidden' },
  { pattern: '.gnupg/**', access: 'hidden' },
  { pattern: '.git/config', access: 'hidden' },
  { pattern: '*.kdbx', access: 'hidden' },
  { pattern: 'credentials.json', access: 'hidden' },
  { pattern: '.docker/config.json', access: 'hidden' },
];

/**
 * Representative paths a rule must not lift unless the Host confirmed unhiding.
 * Checked against host rules only (the floor depends on the session's confirmed
 * state), so `docs/**=r` is allowed while `.env=r` and `**=rw` are not.
 */
export const DEFAULT_SECRET_SAMPLES: readonly string[] = [
  '.env',
  'a/.env.local',
  '.env.production',
  'server.pem',
  'private.key',
  'cert.p12',
  'bundle.pfx',
  'id_rsa',
  'id_rsa.pub',
  'id_ed25519',
  'id_ecdsa',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.aws/credentials',
  '.ssh/config',
  '.gnupg/secring.gpg',
  '.git/config',
  'db.kdbx',
  'credentials.json',
  '.docker/config.json',
];

export const MAX_RULE_PATTERN = 256;
export const MAX_API_RULES = 200;
export const MAX_STARTUP_RULES = 50;

export const ACCESS_VALUES: readonly Access[] = ['hidden', 'r', 'rw'];

const RANK: Record<Access, number> = { hidden: 0, r: 1, rw: 2 };

function stricter(left: Access, right: Access): Access {
  return RANK[left] <= RANK[right] ? left : right;
}

function invalid(message: string): AppError {
  return new AppError(400, 'INVALID_RULE', message);
}

function validateRule(entry: unknown, label: string): Rule {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw invalid(`${label} must be an object with "pattern" and "access".`);
  }
  const extra = Object.keys(entry).filter((key) => key !== 'pattern' && key !== 'access');
  if (extra.length > 0) throw invalid(`${label} has unknown field(s): ${extra.join(', ')}.`);

  const { pattern, access } = entry as { pattern?: unknown; access?: unknown };
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw invalid(`${label}.pattern must be a non-empty string.`);
  }
  if (pattern.length > MAX_RULE_PATTERN) {
    throw invalid(`${label}.pattern must be at most ${MAX_RULE_PATTERN} characters.`);
  }
  if (pattern.includes('\u0000') || pattern.includes('\\')) {
    throw invalid(`${label}.pattern contains an invalid character.`);
  }
  if (typeof access !== 'string' || !ACCESS_VALUES.includes(access as Access)) {
    throw invalid(`${label}.access must be "hidden", "r" or "rw".`);
  }
  return { pattern, access: access as Access };
}

/** Validate a rule list from the admin API. Throws a 400 AppError; fail closed. */
export function validateRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) throw new AppError(400, 'BAD_REQUEST', '"rules" must be an array.');
  if (value.length > MAX_API_RULES) {
    throw new AppError(400, 'TOO_MANY_RULES', `At most ${MAX_API_RULES} rules are allowed.`);
  }
  return value.map((entry, index) => validateRule(entry, `rules[${index}]`));
}

/** Parse one `--rule "<glob>=<hidden|r|rw>"` argument. */
export function parseRuleArgument(raw: string): Rule {
  const at = raw.lastIndexOf('=');
  if (at <= 0) throw invalid('--rule must look like "<glob>=<hidden|r|rw>".');
  return validateRule({ pattern: raw.slice(0, at), access: raw.slice(at + 1) }, '--rule');
}

/** Would this list lift a built-in secret default? Then the Host must confirm. */
export function rulesUnhideDefaults(rules: readonly Rule[]): boolean {
  const compiled = rules.map((rule) => ({ rule, glob: compileGlob(rule.pattern) }));
  return compiled.some(
    ({ rule, glob }) =>
      rule.access !== 'hidden' && DEFAULT_SECRET_SAMPLES.some((sample) => glob.match(sample)),
  );
}

interface CompiledRule {
  readonly rule: Rule;
  readonly glob: CompiledGlob;
}

/**
 * One policy per session.
 *
 * Built-in secret defaults are a floor: until this session's Host confirms
 * unhiding, a path that matches a default is `hidden` whatever the host rules
 * say. With confirmation, host rules apply first-match-wins and may lift a
 * default. In both modes the result is intersected with the principal's
 * capabilities, so a rule can narrow access but never widen it.
 */
export class AccessPolicy {
  private hostRules: Rule[] = [];
  private compiledHost: CompiledRule[] = [];
  private readonly compiledDefaults: CompiledRule[];
  private confirmed = false;

  constructor(
    hostRules: readonly Rule[] = [],
    private readonly defaults: readonly Rule[] = DEFAULT_SECRET_RULES,
  ) {
    this.compiledDefaults = defaults.map((rule) => ({ rule, glob: compileGlob(rule.pattern) }));
    this.setRules(hostRules, false);
  }

  get rules(): readonly Rule[] {
    return this.hostRules;
  }

  get secretDefaults(): readonly Rule[] {
    return this.defaults;
  }

  get confirmUnhide(): boolean {
    return this.confirmed;
  }

  setRules(rules: readonly Rule[], confirmUnhide = false): void {
    this.hostRules = [...rules];
    this.compiledHost = rules.map((rule) => ({ rule, glob: compileGlob(rule.pattern) }));
    this.confirmed = confirmUnhide;
  }

  /** Pure, synchronous. Most restrictive of the requested and canonical path. */
  resolve(relPath: string, canonicalRelPath?: string): Access {
    const requested = this.resolveOne(relPath);
    if (canonicalRelPath === undefined) return requested;
    return stricter(requested, this.resolveOne(canonicalRelPath));
  }

  private resolveOne(relPath: string): Access {
    const path = normalizePathForMatch(relPath);
    const byDefault = this.match(this.compiledDefaults, path);
    // The floor: a built-in secret stays hidden until this session confirms.
    if (byDefault === 'hidden' && !this.confirmed) return 'hidden';
    return this.match(this.compiledHost, path) ?? byDefault ?? 'rw';
  }

  private match(rules: readonly CompiledRule[], path: string): Access | undefined {
    const normalized = normalizeForMatch(path);
    for (const { rule, glob } of rules) {
      if (glob.match(normalized)) return rule.access;
    }
    return undefined;
  }

  effective(
    capabilities: ReadonlySet<Capability>,
    relPath: string,
    canonicalRelPath?: string,
  ): EffectiveAccess {
    const access = this.resolve(relPath, canonicalRelPath);
    const visible = access !== 'hidden';
    return {
      visible,
      read: visible && capabilities.has('fs.read'),
      write: access === 'rw' && capabilities.has('fs.write'),
    };
  }
}

/** A policy bound to one principal: what routes and document sockets receive. */
export class AccessView {
  constructor(
    private readonly policy: AccessPolicy,
    readonly capabilities: ReadonlySet<Capability>,
  ) {}

  access(): AccessPolicy {
    return this.policy;
  }

  decide(relPath: string, canonicalRelPath?: string): Access {
    return this.policy.resolve(relPath, canonicalRelPath);
  }

  read(relPath: string, canonicalRelPath?: string): boolean {
    return this.policy.effective(this.capabilities, relPath, canonicalRelPath).read;
  }

  write(relPath: string, canonicalRelPath?: string): boolean {
    return this.policy.effective(this.capabilities, relPath, canonicalRelPath).write;
  }

  visible(relPath: string, canonicalRelPath?: string): boolean {
    return this.policy.effective(this.capabilities, relPath, canonicalRelPath).visible;
  }
}
