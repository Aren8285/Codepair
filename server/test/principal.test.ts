import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  can,
  makePrincipal,
  type Capability,
  type Role,
} from '../src/security/principal.js';

const ROLES: Role[] = ['owner', 'editor', 'viewer', 'host'];

describe('principals', () => {
  it('maps each role to exactly the documented capabilities', () => {
    for (const role of ROLES) {
      const principal = makePrincipal(role);
      expect(principal.role).toBe(role);
      expect([...principal.capabilities].sort()).toEqual([...ROLE_CAPABILITIES[role]].sort());
    }

    // The Host principal is the only one that administers the session; the
    // owner token is a guest role and must never carry `session.admin`.
    expect([...ROLE_CAPABILITIES.owner].sort()).toEqual(
      ['fs.read', 'fs.write', 'fs.delete', 'term.use', 'call.join', 'call.moderate'].sort(),
    );
    expect([...ROLE_CAPABILITIES.editor].sort()).toEqual(
      ['fs.read', 'fs.write', 'fs.delete', 'term.use', 'call.join'].sort(),
    );
    expect([...ROLE_CAPABILITIES.viewer].sort()).toEqual(['fs.read', 'call.join'].sort());
    expect([...ROLE_CAPABILITIES.host]).toEqual(['session.admin']);
  });

  it('never grants a capability outside CAPABILITIES', () => {
    const known = new Set<string>(CAPABILITIES);
    for (const role of ROLES) {
      for (const capability of ROLE_CAPABILITIES[role]) {
        expect(known.has(capability)).toBe(true);
      }
    }
  });

  it('gives every principal a fresh id', () => {
    const first = makePrincipal('owner');
    const second = makePrincipal('owner');
    expect(first.id).not.toBe(second.id);
    expect(first.id.length).toBeGreaterThan(0);
  });

  it('fails closed when there is no principal', () => {
    expect(can(null, 'fs.read')).toBe(false);
    expect(can(undefined, 'fs.read')).toBe(false);
    expect(can(null, 'session.admin')).toBe(false);
    expect(can(undefined, 'call.join')).toBe(false);
  });

  it('fails closed for a capability that does not exist', () => {
    const owner = makePrincipal('owner');
    expect(can(owner, 'fs.teleport' as Capability)).toBe(false);
    expect(can(owner, '' as Capability)).toBe(false);
    expect(can(owner, 'FS.WRITE' as Capability)).toBe(false);
  });

  it('denies write, delete, terminal and admin to viewers', () => {
    const viewer = makePrincipal('viewer');
    for (const capability of ['fs.write', 'fs.delete', 'term.use', 'session.admin'] as const) {
      expect(can(viewer, capability)).toBe(false);
    }
    expect(can(viewer, 'fs.read')).toBe(true);
    expect(can(viewer, 'call.join')).toBe(true);
  });

  it('denies admin to editors but grants the editing capabilities', () => {
    const editor = makePrincipal('editor');
    expect(can(editor, 'session.admin')).toBe(false);
    for (const capability of ['fs.read', 'fs.write', 'fs.delete', 'term.use', 'call.join'] as const) {
      expect(can(editor, capability)).toBe(true);
    }
  });

  it('grants owners every guest capability but never session.admin', () => {
    const owner = makePrincipal('owner');
    for (const capability of CAPABILITIES) {
      if (capability === 'session.admin') continue;
      expect(can(owner, capability)).toBe(true);
    }
    expect(can(owner, 'session.admin')).toBe(false);
  });

  it('gives the host principal session.admin and nothing else', () => {
    const host = makePrincipal('host');
    expect([...host.capabilities]).toEqual(['session.admin']);
    expect(can(host, 'session.admin')).toBe(true);
    for (const capability of ['fs.read', 'fs.write', 'fs.delete', 'term.use', 'call.join'] as const) {
      expect(can(host, capability)).toBe(false);
    }
  });
});
