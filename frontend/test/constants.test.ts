/**
 * Tests for utility functions in lib/constants.ts:
 * formatError, formatJSON, safeJSONParse.
 */
import { formatError, formatJSON, safeJSONParse } from '../src/lib/constants';

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

// ---------------------------------------------------------------------------
// safeJSONParse
// ---------------------------------------------------------------------------
describe('safeJSONParse', () => {
  it('should parse valid JSON', () => {
    expect(safeJSONParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('should parse valid JSON arrays', () => {
    expect(safeJSONParse('[1,2,3]', [])).toEqual([1, 2, 3]);
  });

  it('should return fallback for invalid JSON', () => {
    expect(safeJSONParse('not json', 'default')).toBe('default');
  });

  it('should return fallback for empty string', () => {
    expect(safeJSONParse('', null)).toBe(null);
  });

  it('should return fallback for undefined-like values', () => {
    expect(safeJSONParse('undefined', {})).toEqual({});
  });

  it('should preserve the fallback type', () => {
    const fallback = { key: 'value' };
    expect(safeJSONParse('{bad', fallback)).toBe(fallback);
  });
});
