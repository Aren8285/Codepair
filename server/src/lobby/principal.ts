import { capabilitiesForRole, type Capability, type Principal, type Role } from '../security/principal.js';
import type { SeatRole } from './lobby.js';

/**
 * Apply a lobby seat to a token's principal.
 *
 * The result holds only capabilities both the token and the seat grant, so a
 * Host's "admit as viewer" genuinely restricts an editor token, and a seat can
 * never upgrade a viewer. Used by the HTTP gate and by every socket handler.
 */
export function seatPrincipal(principal: Principal, seat: SeatRole): Principal {
  const seatCapabilities = capabilitiesForRole(seat as Role);
  const capabilities = new Set<Capability>();
  for (const capability of principal.capabilities) {
    if (seatCapabilities.has(capability)) capabilities.add(capability);
  }
  return { id: principal.id, role: seat, capabilities };
}
