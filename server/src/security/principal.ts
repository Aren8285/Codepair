import { randomUUID } from 'node:crypto';

export const CAPABILITIES = [
  'fs.read',
  'fs.write',
  'fs.delete',
  'term.use',
  'call.join',
  'session.admin',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type Role = 'owner' | 'editor' | 'viewer';

export interface Principal {
  /** Assigned per connection; never shared between requests or sockets. */
  readonly id: string;
  readonly role: Role;
  readonly capabilities: ReadonlySet<Capability>;
}

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  owner: ['fs.read', 'fs.write', 'fs.delete', 'term.use', 'call.join', 'session.admin'],
  editor: ['fs.read', 'fs.write', 'fs.delete', 'term.use', 'call.join'],
  viewer: ['fs.read', 'call.join'],
};

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>(CAPABILITIES);

/**
 * Resolve a role to its capability set. Unknown roles and capabilities are
 * dropped rather than granted, so a bad table entry can never widen access.
 */
export function capabilitiesForRole(role: Role): ReadonlySet<Capability> {
  const declared = ROLE_CAPABILITIES[role] as readonly Capability[] | undefined;
  const granted = new Set<Capability>();
  if (!declared) return granted;
  for (const capability of declared) {
    if (KNOWN_CAPABILITIES.has(capability)) granted.add(capability);
  }
  return granted;
}

export function makePrincipal(role: Role): Principal {
  return { id: randomUUID(), role, capabilities: capabilitiesForRole(role) };
}

/**
 * The single authority every gate consults. Capabilities are read from the
 * principal itself (never re-derived from its role) and anything missing,
 * unknown or absent is denied: fail closed.
 */
export function can(principal: Principal | null | undefined, capability: Capability): boolean {
  if (!principal || !principal.capabilities) return false;
  if (typeof capability !== 'string' || !KNOWN_CAPABILITIES.has(capability)) return false;
  return principal.capabilities.has(capability);
}
