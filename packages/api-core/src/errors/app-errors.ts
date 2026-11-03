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
    /** Structured context sent with the error response (e.g. the failing gates). */
    public readonly details?: Record<string, unknown>,
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
 *  (e.g. `PLUGIN_VERSION_FROZEN`); it must be a 409-mapped code. `details`
 *  carries what the client needs to resolve it — for a taken pipeline slot,
 *  the NORMALIZED names that collided and the id to PUT instead. */
export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = ErrorCode.CONFLICT, details?: Record<string, unknown>) {
    super(getStatusForErrorCode(ErrorCode.CONFLICT), code, message, details);
    this.name = 'ConflictError';
  }
}

/** 403 — the organization's administrators switched AI features off. */
export class AIDisabledError extends AppError {
  constructor(message = 'AI features are turned off for this organization. An organization administrator can turn them back on in Settings.') {
    super(getStatusForErrorCode(ErrorCode.AI_DISABLED), ErrorCode.AI_DISABLED, message);
    this.name = 'AIDisabledError';
  }
}

/**
 * An AI request could not be served AS ASKED — the org's own provider key could not
 * be loaded, a bring-your-own key named a keyless provider, nothing is configured.
 * The message is written by us and names configuration, never a secret, so it is
 * safe to show; `handleAIError` surfaces it verbatim with this status. Thrown
 * INSTEAD of silently serving the request on the platform's key.
 */
export class AIConfigurationError extends AppError {
  constructor(message: string, statusCode = 503, code: ErrorCode = ErrorCode.SERVICE_UNAVAILABLE) {
    super(statusCode, code, message);
    this.name = 'AIConfigurationError';
  }
}
