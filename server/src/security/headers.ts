import type { NextFunction, Request, Response } from 'express';

/** Security headers shared by the guest app and the loopback admin app. */
export function securityHeaders(request: Request, response: Response, next: NextFunction): void {
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob: mediastream:",
      "connect-src 'self' ws: wss:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // WebRTC needs camera/mic/display capture, but only same-origin pages may ask.
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  if (request.path.startsWith('/api')) response.setHeader('Cache-Control', 'no-store');
  next();
}
