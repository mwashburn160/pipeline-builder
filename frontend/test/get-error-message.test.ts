// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `getErrorMessage` — now a thin alias over the app-wide `formatError`
 * (so error text is consistent everywhere). Since `ApiError extends Error`, an
 * `ApiError` and a plain `Error` both yield their `.message`; a thrown string
 * passes through; any other throwable falls back to `formatError`'s default
 * message (previously this was `String(err)`, which diverged from the rest of
 * the app).
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

  it('passes a thrown string through', () => {
    expect(getErrorMessage('nope')).toBe('nope');
  });

  it('falls back to the default message for a non-Error, non-string throwable', () => {
    expect(getErrorMessage(undefined)).toBe('An error occurred');
  });
});
