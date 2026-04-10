// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for jwt.ts: decodeJwt, formatTimestamp, isExpired, expiresIn.
 */

// base64UrlDecode uses atob which isn't available in Node — provide a polyfill
(globalThis as any).atob = (str: string) => Buffer.from(str, 'base64').toString('binary');

import { decodeJwt, formatTimestamp, isExpired, expiresIn } from '../src/lib/jwt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a JSON object as a base64url string (mimics JWT segment). */
function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** Build a fake JWT with the given payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(payload);
  return `${header}.${body}.fakesig`;
}

// ---------------------------------------------------------------------------
// decodeJwt
// ---------------------------------------------------------------------------
describe('decodeJwt', () => {
  it('should decode a valid JWT', () => {
    const token = fakeJwt({ sub: '123', role: 'admin' });
    const result = decodeJwt(token);
    expect(result).not.toBeNull();
    expect(result!.payload.sub).toBe('123');
    expect(result!.payload.role).toBe('admin');
    expect(result!.signature).toBe('fakesig');
  });

  it('should return null for token with wrong number of parts', () => {
    expect(decodeJwt('only.two')).toBeNull();
    expect(decodeJwt('one')).toBeNull();
    expect(decodeJwt('')).toBeNull();
  });

  it('should return null for invalid base64', () => {
    expect(decodeJwt('!!!.@@@.###')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------
describe('formatTimestamp', () => {
  it('should return null for non-number values', () => {
    expect(formatTimestamp('not a number')).toBeNull();
    expect(formatTimestamp(null)).toBeNull();
    expect(formatTimestamp(undefined)).toBeNull();
  });

  it('should format epoch seconds', () => {
    const result = formatTimestamp(1700000000); // seconds
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('should format epoch milliseconds', () => {
    const result = formatTimestamp(1700000000000); // milliseconds
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// isExpired
// ---------------------------------------------------------------------------
describe('isExpired', () => {
  it('should return true for expired tokens', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    expect(isExpired({ exp: pastExp })).toBe(true);
  });

  it('should return false for valid tokens', () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    expect(isExpired({ exp: futureExp })).toBe(false);
  });

  it('should return false when exp is not a number', () => {
    expect(isExpired({ exp: 'not a number' })).toBe(false);
    expect(isExpired({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// expiresIn
// ---------------------------------------------------------------------------
describe('expiresIn', () => {
  it('should return null when exp is not a number', () => {
    expect(expiresIn({})).toBeNull();
    expect(expiresIn({ exp: 'string' })).toBeNull();
  });

  it('should return "Expired" for past tokens', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    expect(expiresIn({ exp: pastExp })).toBe('Expired');
  });

  it('should return minutes for short durations', () => {
    const exp = Math.floor(Date.now() / 1000) + 300; // 5 minutes
    const result = expiresIn({ exp });
    expect(result).toMatch(/^\d+m$/);
  });

  it('should return hours and minutes for medium durations', () => {
    const exp = Math.floor(Date.now() / 1000) + 7200; // 2 hours
    const result = expiresIn({ exp });
    expect(result).toMatch(/^\d+h \d+m$/);
  });

  it('should return days and hours for long durations', () => {
    const exp = Math.floor(Date.now() / 1000) + 172800; // 2 days
    const result = expiresIn({ exp });
    expect(result).toMatch(/^\d+d \d+h$/);
  });
});
