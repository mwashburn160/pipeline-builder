// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `parsePagination` is now a back-compat shim around api-core's
 * `parsePaginationParams`. The shim intentionally ignores the legacy
 * `{ defaultLimit, maxLimit }` overrides — api-core uses a fixed default
 * of 10 and clamps to `MAX_PAGE_LIMIT` (1000 unless overridden by env).
 * Comprehensive parsing tests live in `packages/api-core/test/response.test.ts`;
 * this file just smoke-tests that the shim forwards correctly.
 */

import { parsePagination } from '../src/utils/pagination.js';

describe('parsePagination (shim)', () => {
  it('returns defaults for undefined inputs (limit=10, offset=0)', () => {
    expect(parsePagination(undefined, undefined)).toEqual({ offset: 0, limit: 10 });
  });

  it('parses valid string numbers', () => {
    expect(parsePagination('10', '50')).toEqual({ offset: 10, limit: 50 });
  });

  it('parses numeric inputs', () => {
    expect(parsePagination(5, 25)).toEqual({ offset: 5, limit: 25 });
  });

  it('clamps limit to MAX_PAGE_LIMIT (1000 by default)', () => {
    // Above the cap — clamped down. Default cap is 1000 (env-overridable).
    expect(parsePagination(0, 999999).limit).toBeLessThanOrEqual(1000);
  });

  it('clamps limit to minimum of 1', () => {
    // Non-positive limit falls back to default (10), not to 0.
    expect(parsePagination(0, 0)).toEqual({ offset: 0, limit: 10 });
  });

  it('clamps offset to minimum 0', () => {
    expect(parsePagination(-10, 10)).toEqual({ offset: 0, limit: 10 });
  });

  it('falls back to default for non-numeric input', () => {
    expect(parsePagination('garbage', 'junk')).toEqual({ offset: 0, limit: 10 });
  });

  it('ignores the legacy `defaults` override (shim no longer threads it)', () => {
    // The 3rd arg used to let callers override defaultLimit/maxLimit; the
    // shim accepts-and-ignores it now. Callers needing custom bounds should
    // import parsePaginationParams from api-core directly.
    const result = parsePagination(undefined, undefined, { defaultLimit: 5, maxLimit: 10 });
    expect(result).toEqual({ offset: 0, limit: 10 });
  });
});
