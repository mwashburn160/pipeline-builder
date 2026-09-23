// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for utility functions in lib/constants.ts:
 * formatError, formatJSON.
 */
import { describe, it, expect } from '@jest/globals';
import { formatError, formatJSON } from '../src/lib/constants';

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------
describe('formatError', () => {
  it('should extract message from Error instance', () => {
    expect(formatError(new Error('something broke'))).toBe('something broke');
  });

  it('should return string errors as-is', () => {
    expect(formatError('plain string error')).toBe('plain string error');
  });

  it('should return fallback for non-string, non-Error values', () => {
    expect(formatError(42)).toBe('An error occurred');
    expect(formatError(null)).toBe('An error occurred');
    expect(formatError(undefined)).toBe('An error occurred');
    expect(formatError({ code: 500 })).toBe('An error occurred');
  });

  it('should use custom fallback when provided', () => {
    expect(formatError(42, 'custom fallback')).toBe('custom fallback');
  });
});

// ---------------------------------------------------------------------------
// An API envelope is NOT an Error, so formatError falls back on one and hides
// the server's reason. That is why envelope sites read `res.message` directly
// rather than passing the envelope here.
// ---------------------------------------------------------------------------
describe('formatError on an API envelope', () => {
  it('falls back rather than reaching into the envelope', () => {
    const res = { success: false as const, statusCode: 409, message: 'Name already taken' };
    expect(formatError(res, 'Failed')).toBe('Failed');
    expect(res.message || 'Failed').toBe('Name already taken');
  });
});

// ---------------------------------------------------------------------------
// formatJSON
// ---------------------------------------------------------------------------
describe('formatJSON', () => {
  it('should pretty-print an object with 2-space indentation', () => {
    const obj = { a: 1, b: 'hello' };
    expect(formatJSON(obj)).toBe(JSON.stringify(obj, null, 2));
  });

  it('should handle arrays', () => {
    expect(formatJSON([1, 2, 3])).toBe('[\n  1,\n  2,\n  3\n]');
  });

  it('should handle null', () => {
    expect(formatJSON(null)).toBe('null');
  });

  it('should handle nested objects', () => {
    const nested = { a: { b: { c: 1 } } };
    expect(formatJSON(nested)).toContain('      "c": 1');
  });
});

