import { SandboxError } from './security/pathGuard.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function badRequest(message: string): AppError {
  return new AppError(400, 'BAD_REQUEST', message);
}

export function unauthorized(): AppError {
  return new AppError(401, 'UNAUTHORIZED', 'A valid access token is required.');
}

export function notFound(message = 'Not found.'): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function readOnlyViolation(action = 'Editing'): AppError {
  return new AppError(403, 'READ_ONLY', `${action} is disabled because this session is read-only.`);
}

export function toErrorPayload(error: unknown): {
  status: number;
  payload: { error: { code: string; message: string } };
} {
  if (error instanceof SandboxError) {
    return {
      status: error.code === 'INVALID_PATH' ? 400 : 403,
      payload: { error: { code: error.code, message: error.message } },
    };
  }
  if (error instanceof AppError) {
    return {
      status: error.status,
      payload: { error: { code: error.code, message: error.message } },
    };
  }
  const nodeError = error as NodeJS.ErrnoException | undefined;
  if (nodeError?.code === 'ENOENT') {
    return { status: 404, payload: { error: { code: 'NOT_FOUND', message: 'That path does not exist.' } } };
  }
  if (nodeError?.code === 'EACCES' || nodeError?.code === 'EPERM') {
    return { status: 403, payload: { error: { code: 'PERMISSION_DENIED', message: 'The host denied access to that path.' } } };
  }
  if (nodeError?.code === 'ENOTDIR' || nodeError?.code === 'EISDIR') {
    return { status: 400, payload: { error: { code: 'INVALID_PATH', message: 'That path has the wrong type.' } } };
  }
  return {
    status: 500,
    payload: { error: { code: 'INTERNAL', message: 'Something went wrong on the host.' } },
  };
}
