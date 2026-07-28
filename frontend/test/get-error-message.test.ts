// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `getErrorMessage`, the centralized replacement for the
 * copy-pasted `err instanceof ApiError ? err.message : (err as Error).message`
 * idiom. Since `ApiError extends Error`, an `ApiError` and a plain `Error`
 * must both yield their `.message`, while non-`Error` throwables fall back to
 * `String(err)`.
 */
import { getErrorMessage, ApiError } from '../src/lib/api/errors';

describe('getErrorMessage', () => {
  it('returns the message from an ApiError', () => {
    const err = new ApiError('quota exceeded', 429, 'QUOTA');
    expect(getErrorMessage(err)).toBe('quota exceeded');
  });

  it('returns the message from a plain Error', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('falls back to String(err) for a thrown string', () => {
    expect(getErrorMessage('nope')).toBe('nope');
  });

  it('falls back to String(err) for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });
});
