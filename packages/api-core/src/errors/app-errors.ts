// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, getStatusForErrorCode } from '../types/error-codes.js';

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

/** 409 — Conflict / duplicate. `code` narrows the conflict for clients
 *  (e.g. `PLUGIN_VERSION_FROZEN`); it must be a 409-mapped code. */
export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = ErrorCode.CONFLICT) {
    super(getStatusForErrorCode(ErrorCode.CONFLICT), code, message);
    this.name = 'ConflictError';
  }
}
