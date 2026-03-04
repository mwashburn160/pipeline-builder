import { ErrorCode, getStatusForErrorCode } from '../types/error-codes';

/**
 * Base application error with HTTP status code and error code.
 * Extend this for domain-specific error types.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 404 — Resource not found. */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(getStatusForErrorCode(ErrorCode.NOT_FOUND), ErrorCode.NOT_FOUND, message);
    this.name = 'NotFoundError';
  }
}

/** 403 — Insufficient permissions. */
export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(getStatusForErrorCode(ErrorCode.INSUFFICIENT_PERMISSIONS), ErrorCode.INSUFFICIENT_PERMISSIONS, message);
    this.name = 'ForbiddenError';
  }
}

/** 400 — Validation / bad request. */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(getStatusForErrorCode(ErrorCode.VALIDATION_ERROR), ErrorCode.VALIDATION_ERROR, message);
    this.name = 'ValidationError';
  }
}

/** 409 — Conflict / duplicate. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(getStatusForErrorCode(ErrorCode.CONFLICT), ErrorCode.CONFLICT, message);
    this.name = 'ConflictError';
  }
}

/** 401 — Unauthorized / authentication required. */
export class UnauthorizedError extends AppError {
  constructor(message: string) {
    super(getStatusForErrorCode(ErrorCode.UNAUTHORIZED), ErrorCode.UNAUTHORIZED, message);
    this.name = 'UnauthorizedError';
  }
}
