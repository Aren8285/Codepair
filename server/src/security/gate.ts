import type { NextFunction, Request, Response } from 'express';
import { forbidden } from '../errors.js';
import { can, type Capability, type Principal } from './principal.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the API authentication middleware; never stored globally. */
      principal?: Principal;
    }
  }
}

/** Tags a `requireCap` middleware with the capability it enforces (route audit). */
export const CAPABILITY_GATE: unique symbol = Symbol.for('codepair.capabilityGate');

/**
 * Capability gate for HTTP routes. A missing or insufficient capability is
 * denied with a generic 403 that names neither the capability nor the path.
 */
export type CapabilityGate = ((request: Request, _response: Response, next: NextFunction) => void) & {
  [CAPABILITY_GATE]: Capability;
};

export function requireCap(capability: Capability): CapabilityGate {
  return Object.assign(
    (request: Request, _response: Response, next: NextFunction): void => {
      if (!can(request.principal, capability)) {
        next(forbidden());
        return;
      }
      next();
    },
    { [CAPABILITY_GATE]: capability },
  );
}
