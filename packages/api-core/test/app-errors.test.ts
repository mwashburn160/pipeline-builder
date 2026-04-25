// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  AppError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
} from '../src/errors/app-errors';
import { ErrorCode } from '../src/types/error-codes';

describe('AppError', () => {
  it('exposes statusCode, code, and message', () => {
    const err = new AppError(418, ErrorCode.INTERNAL_ERROR, "I'm a teapot");
    expect(err.statusCode).toBe(418);
    expect(err.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(err.message).toBe("I'm a teapot");
    expect(err.name).toBe('AppError');
  });

  it('is throwable and catchable as Error', () => {
    expect(() => { throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'boom'); })
      .toThrow(Error);
  });
});

describe('NotFoundError', () => {
  it('returns status 404 and NOT_FOUND code', () => {
    const err = new NotFoundError('plugin not found');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
    expect(err.message).toBe('plugin not found');
    expect(err.name).toBe('NotFoundError');
  });

  it('is an AppError', () => {
    expect(new NotFoundError('x')).toBeInstanceOf(AppError);
  });
});

describe('ForbiddenError', () => {
  it('returns status 403 and INSUFFICIENT_PERMISSIONS code', () => {
    const err = new ForbiddenError('admin required');
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe(ErrorCode.INSUFFICIENT_PERMISSIONS);
    expect(err.name).toBe('ForbiddenError');
  });
});

describe('ValidationError', () => {
  it('returns status 400 and VALIDATION_ERROR code', () => {
    const err = new ValidationError('name is required');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(err.name).toBe('ValidationError');
  });
});

describe('ConflictError', () => {
  it('returns status 409 and CONFLICT code', () => {
    const err = new ConflictError('duplicate slug');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe(ErrorCode.CONFLICT);
    expect(err.name).toBe('ConflictError');
  });
});

describe('UnauthorizedError', () => {
  it('returns status 401 and UNAUTHORIZED code', () => {
    const err = new UnauthorizedError('token expired');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(err.name).toBe('UnauthorizedError');
  });
});
