// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  getParam,
  getOrgId,
  getAuthHeader,
  parseQueryBoolean,
  parseQueryInt,
  parseQueryString,
  parseQueryIntClamped,
  validateBulkArray,
  parseDateRange,
  REPORT_INTERVALS,
} from '../src/utils/params.js';

// Mock Express Request
function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    headers: {},
    query: {},
    user: undefined,
    ...overrides,
  } as any;
}

// Tests

describe('getParam', () => {
  it('should return string value', () => {
    expect(getParam({ id: 'abc' }, 'id')).toBe('abc');
  });

  it('should return first element from array', () => {
    expect(getParam({ id: ['first', 'second'] }, 'id')).toBe('first');
  });

  it('should return undefined for missing key', () => {
    expect(getParam({}, 'id')).toBeUndefined();
  });
});

describe('getOrgId', () => {
  it('should return orgId from route params', () => {
    const req = mockReq({ params: { orgId: 'org-from-params' } });
    expect(getOrgId(req)).toBe('org-from-params');
  });

  it('should return orgId from x-org-id header', () => {
    const req = mockReq({ headers: { 'x-org-id': 'org-from-header' } });
    expect(getOrgId(req)).toBe('org-from-header');
  });

  it('should return orgId from authenticated user', () => {
    const req = mockReq({ user: { organizationId: 'org-from-user' } });
    expect(getOrgId(req)).toBe('org-from-user');
  });

  it('should prefer params over header and user', () => {
    const req = mockReq({
      params: { orgId: 'from-params' },
      headers: { 'x-org-id': 'from-header' },
      user: { organizationId: 'from-user' },
    });
    expect(getOrgId(req)).toBe('from-params');
  });

  it('should prefer header over user', () => {
    const req = mockReq({
      headers: { 'x-org-id': 'from-header' },
      user: { organizationId: 'from-user' },
    });
    expect(getOrgId(req)).toBe('from-header');
  });

  it('should return undefined when no org available', () => {
    const req = mockReq();
    expect(getOrgId(req)).toBeUndefined();
  });

  it('should trim whitespace from header org id', () => {
    const req = mockReq({ headers: { 'x-org-id': '  org-1  ' } });
    expect(getOrgId(req)).toBe('org-1');
  });
});

describe('getAuthHeader', () => {
  it('should return authorization header', () => {
    const req = mockReq({ headers: { authorization: 'Bearer token123' } });
    expect(getAuthHeader(req)).toBe('Bearer token123');
  });

  it('should return empty string when missing', () => {
    const req = mockReq();
    expect(getAuthHeader(req)).toBe('');
  });
});

describe('parseQueryBoolean', () => {
  it('should parse "true" string', () => {
    expect(parseQueryBoolean('true')).toBe(true);
    expect(parseQueryBoolean('TRUE')).toBe(true);
    expect(parseQueryBoolean('True')).toBe(true);
  });

  it('should parse "false" string', () => {
    expect(parseQueryBoolean('false')).toBe(false);
    expect(parseQueryBoolean('FALSE')).toBe(false);
  });

  it('should parse "1" and "0"', () => {
    expect(parseQueryBoolean('1')).toBe(true);
    expect(parseQueryBoolean('0')).toBe(false);
  });

  it('should return boolean values as-is', () => {
    expect(parseQueryBoolean(true)).toBe(true);
    expect(parseQueryBoolean(false)).toBe(false);
  });

  it('should return undefined for empty/null/undefined', () => {
    expect(parseQueryBoolean(undefined)).toBeUndefined();
    expect(parseQueryBoolean(null)).toBeUndefined();
    expect(parseQueryBoolean('')).toBeUndefined();
  });

  it('should return undefined for invalid strings', () => {
    expect(parseQueryBoolean('yes')).toBeUndefined();
    expect(parseQueryBoolean('no')).toBeUndefined();
  });
});

describe('parseQueryInt', () => {
  it('should parse valid integers', () => {
    expect(parseQueryInt('10', 5)).toBe(10);
    expect(parseQueryInt('0', 5)).toBe(0);
    expect(parseQueryInt('-3', 5)).toBe(-3);
  });

  it('should return default for undefined/null/empty', () => {
    expect(parseQueryInt(undefined, 10)).toBe(10);
    expect(parseQueryInt(null, 10)).toBe(10);
    expect(parseQueryInt('', 10)).toBe(10);
  });

  it('should return default for NaN', () => {
    expect(parseQueryInt('abc', 10)).toBe(10);
    expect(parseQueryInt('not-a-number', 0)).toBe(0);
  });

  it('should parse integer part of float string', () => {
    expect(parseQueryInt('3.7', 0)).toBe(3);
  });
});

describe('parseQueryString', () => {
  it('should return string value', () => {
    expect(parseQueryString('hello')).toBe('hello');
  });

  it('should convert non-string values to string', () => {
    expect(parseQueryString(123)).toBe('123');
    expect(parseQueryString(true)).toBe('true');
  });

  it('should return undefined for empty/null/undefined', () => {
    expect(parseQueryString(undefined)).toBeUndefined();
    expect(parseQueryString(null)).toBeUndefined();
    expect(parseQueryString('')).toBeUndefined();
  });
});

describe('parseQueryIntClamped', () => {
  it('should return integer within range', () => {
    expect(parseQueryIntClamped('50', 10, 100)).toBe(50);
    expect(parseQueryIntClamped('1', 10, 100)).toBe(1);
    expect(parseQueryIntClamped('100', 10, 100)).toBe(100);
  });

  it('should return default for undefined/null/empty', () => {
    expect(parseQueryIntClamped(undefined, 25, 100)).toBe(25);
    expect(parseQueryIntClamped(null, 25, 100)).toBe(25);
    expect(parseQueryIntClamped('', 25, 100)).toBe(25);
  });

  it('should clamp values above max down to max', () => {
    expect(parseQueryIntClamped('500', 10, 100)).toBe(100);
    expect(parseQueryIntClamped('9999', 10, 100)).toBe(100);
  });

  it('should clamp values below 1 up to 1', () => {
    expect(parseQueryIntClamped('0', 10, 100)).toBe(1);
    expect(parseQueryIntClamped('-50', 10, 100)).toBe(1);
  });

  it('should fall back to clamped default for invalid input', () => {
    // 'abc' is invalid → defaults to 50, which is within [1, 100]
    expect(parseQueryIntClamped('abc', 50, 100)).toBe(50);
    // Default itself is also clamped: defaultValue=500 clamps to max 100
    expect(parseQueryIntClamped('abc', 500, 100)).toBe(100);
    // Default below 1 also clamps up
    expect(parseQueryIntClamped('abc', 0, 100)).toBe(1);
  });
});

describe('validateBulkArray', () => {
  it('should return value for valid non-empty array', () => {
    const result = validateBulkArray<string>(['a', 'b', 'c'], 'ids');
    expect(result).toEqual({ value: ['a', 'b', 'c'] });
  });

  it('should return error for non-array input', () => {
    const result = validateBulkArray('not-array', 'ids');
    expect(result).toEqual({ error: 'Request body must include a non-empty "ids" array' });
  });

  it('should return error for null/undefined', () => {
    expect(validateBulkArray(null, 'ids')).toEqual({
      error: 'Request body must include a non-empty "ids" array',
    });
    expect(validateBulkArray(undefined, 'ids')).toEqual({
      error: 'Request body must include a non-empty "ids" array',
    });
  });

  it('should return error for empty array', () => {
    const result = validateBulkArray([], 'ids');
    expect(result).toEqual({ error: 'Request body must include a non-empty "ids" array' });
  });

  it('should return error when array exceeds maxItems', () => {
    const big = new Array(11).fill('x');
    const result = validateBulkArray(big, 'ids', 10);
    expect(result).toEqual({ error: 'Maximum 10 items per bulk operation' });
  });

  it('should allow array equal to maxItems', () => {
    const exact = new Array(10).fill('x');
    const result = validateBulkArray(exact, 'ids', 10);
    expect('value' in result).toBe(true);
  });

  it('should have no upper bound when maxItems is undefined', () => {
    const big = new Array(10000).fill('x');
    const result = validateBulkArray(big, 'ids');
    expect('value' in result).toBe(true);
    if ('value' in result) {
      expect(result.value).toHaveLength(10000);
    }
  });

  it('should use fieldName in error message', () => {
    const result = validateBulkArray([], 'pluginIds');
    expect(result).toEqual({
      error: 'Request body must include a non-empty "pluginIds" array',
    });
  });
});

describe('parseDateRange', () => {
  it('should return both from and to when provided as ISO strings', () => {
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-01-31T23:59:59.999Z';
    const result = parseDateRange({ from, to });
    expect(result).toEqual({ from, to });
  });

  it('should default to ~30 days back when from/to omitted', () => {
    const before = Date.now();
    const result = parseDateRange({});
    const after = Date.now();

    expect('from' in result).toBe(true);
    if ('from' in result) {
      const fromMs = Date.parse(result.from);
      const toMs = Date.parse(result.to);
      // to should be ~now
      expect(toMs).toBeGreaterThanOrEqual(before);
      expect(toMs).toBeLessThanOrEqual(after);
      // from should be ~30 days before now
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(toMs - fromMs).toBeGreaterThanOrEqual(thirtyDaysMs - 5);
      expect(toMs - fromMs).toBeLessThanOrEqual(thirtyDaysMs + 5);
    }
  });

  it('should respect custom defaultDaysBack option', () => {
    const result = parseDateRange({}, { defaultDaysBack: 7 });
    expect('from' in result).toBe(true);
    if ('from' in result) {
      const span = Date.parse(result.to) - Date.parse(result.from);
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(Math.abs(span - sevenDaysMs)).toBeLessThan(100);
    }
  });

  it('should return error when from is not a string (string[] case)', () => {
    const result = parseDateRange({ from: ['a', 'b'] as unknown as string });
    expect(result).toEqual({ error: '"from" must be a single ISO timestamp string' });
  });

  it('should return error when to is not a string', () => {
    const result = parseDateRange({ to: 123 as unknown as string });
    expect(result).toEqual({ error: '"to" must be a single ISO timestamp string' });
  });

  it('should return error for invalid ISO from', () => {
    const result = parseDateRange({ from: 'not-a-date', to: '2026-01-01T00:00:00.000Z' });
    expect(result).toEqual({ error: '"from" is not a valid ISO timestamp' });
  });

  it('should return error for invalid ISO to', () => {
    const result = parseDateRange({ from: '2026-01-01T00:00:00.000Z', to: 'garbage' });
    expect(result).toEqual({ error: '"to" is not a valid ISO timestamp' });
  });

  it('should return error for inverted range (from > to)', () => {
    const result = parseDateRange({
      from: '2026-12-31T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });
    expect(result).toEqual({ error: '"from" must be earlier than "to"' });
  });

  it('should return error when range exceeds maxRangeMs', () => {
    const result = parseDateRange(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' },
      { maxRangeMs: 30 * 24 * 60 * 60 * 1000 },
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/Date range exceeds maximum of 30 days/);
    }
  });

  it('should accept range exactly at maxRangeMs', () => {
    const from = '2026-01-01T00:00:00.000Z';
    const to = new Date(Date.parse(from) + 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = parseDateRange(
      { from, to },
      { maxRangeMs: 7 * 24 * 60 * 60 * 1000 },
    );
    expect('from' in result).toBe(true);
  });
});

describe('REPORT_INTERVALS', () => {
  it('should be a tuple of known interval names', () => {
    expect(REPORT_INTERVALS).toEqual(['day', 'week', 'month']);
  });

  it('should be a readonly array', () => {
    // Compile-time `as const` enforces readonly; assert runtime length is fixed
    expect(REPORT_INTERVALS).toHaveLength(3);
    expect(Array.isArray(REPORT_INTERVALS)).toBe(true);
  });

  it('should contain only string values', () => {
    for (const interval of REPORT_INTERVALS) {
      expect(typeof interval).toBe('string');
    }
  });
});
