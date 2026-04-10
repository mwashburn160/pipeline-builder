// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getFieldValue, evaluateOperator, validateRegexPattern } from '../src/engine/rule-operators';

// ============================================
// getFieldValue
// ============================================

describe('getFieldValue', () => {
  describe('dot-notation traversal', () => {
    it('returns top-level field', () => {
      expect(getFieldValue({ name: 'test' }, 'name')).toBe('test');
    });

    it('returns nested field', () => {
      expect(getFieldValue({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
    });

    it('returns undefined for missing path', () => {
      expect(getFieldValue({ a: 1 }, 'b')).toBeUndefined();
    });

    it('returns undefined for deep missing path', () => {
      expect(getFieldValue({ a: { b: 1 } }, 'a.c.d')).toBeUndefined();
    });

    it('returns undefined when traversing through null', () => {
      expect(getFieldValue({ a: null }, 'a.b')).toBeUndefined();
    });

    it('returns undefined when traversing through primitive', () => {
      expect(getFieldValue({ a: 'string' }, 'a.b')).toBeUndefined();
    });

    it('returns array values', () => {
      expect(getFieldValue({ items: [1, 2, 3] }, 'items')).toEqual([1, 2, 3]);
    });

    it('returns boolean false (not undefined)', () => {
      expect(getFieldValue({ active: false }, 'active')).toBe(false);
    });

    it('returns zero (not undefined)', () => {
      expect(getFieldValue({ count: 0 }, 'count')).toBe(0);
    });
  });

  describe('computed fields', () => {
    it('$count returns array length', () => {
      expect(getFieldValue({ secrets: [1, 2, 3] }, '$count(secrets)')).toBe(3);
    });

    it('$count returns 0 for empty array', () => {
      expect(getFieldValue({ secrets: [] }, '$count(secrets)')).toBe(0);
    });

    it('$count returns object key count', () => {
      expect(getFieldValue({ env: { A: '1', B: '2' } }, '$count(env)')).toBe(2);
    });

    it('$count returns 0 for non-array/object', () => {
      expect(getFieldValue({ name: 'test' }, '$count(name)')).toBe(0);
    });

    it('$count returns 0 for missing field', () => {
      expect(getFieldValue({}, '$count(missing)')).toBe(0);
    });

    it('$length returns string length', () => {
      expect(getFieldValue({ name: 'hello' }, '$length(name)')).toBe(5);
    });

    it('$length returns 0 for non-string', () => {
      expect(getFieldValue({ num: 42 }, '$length(num)')).toBe(0);
    });

    it('$keys returns object keys', () => {
      expect(getFieldValue({ env: { A: '1', B: '2' } }, '$keys(env)')).toEqual(['A', 'B']);
    });

    it('$keys returns empty array for non-object', () => {
      expect(getFieldValue({ name: 'test' }, '$keys(name)')).toEqual([]);
    });

    it('$keys returns empty array for array', () => {
      expect(getFieldValue({ arr: [1, 2] }, '$keys(arr)')).toEqual([]);
    });

    it('$lines returns line count', () => {
      expect(getFieldValue({ dockerfile: 'FROM node\nRUN npm install\nCMD ["node"]' }, '$lines(dockerfile)')).toBe(3);
    });

    it('$lines returns 1 for single-line string', () => {
      expect(getFieldValue({ s: 'hello' }, '$lines(s)')).toBe(1);
    });

    it('$lines returns 0 for non-string', () => {
      expect(getFieldValue({ num: 42 }, '$lines(num)')).toBe(0);
    });

    it('unknown computed function returns undefined', () => {
      expect(getFieldValue({ a: 1 }, '$unknown(a)')).toBeUndefined();
    });

    it('$count with nested path', () => {
      expect(getFieldValue({ props: { stages: [1, 2] } }, '$count(props.stages)')).toBe(2);
    });
  });
});

// ============================================
// evaluateOperator
// ============================================

describe('evaluateOperator', () => {
  describe('eq / neq', () => {
    it('eq: same string', () => {
      expect(evaluateOperator('eq', 'hello', 'hello')).toBe(true);
    });

    it('eq: different string', () => {
      expect(evaluateOperator('eq', 'hello', 'world')).toBe(false);
    });

    it('eq: number coercion', () => {
      expect(evaluateOperator('eq', 42, '42')).toBe(true);
    });

    it('neq: different values', () => {
      expect(evaluateOperator('neq', 'a', 'b')).toBe(true);
    });

    it('neq: same values', () => {
      expect(evaluateOperator('neq', 'a', 'a')).toBe(false);
    });
  });

  describe('contains / notContains', () => {
    it('contains: string in string (case-insensitive)', () => {
      expect(evaluateOperator('contains', 'Hello World', 'hello')).toBe(true);
    });

    it('contains: string not in string', () => {
      expect(evaluateOperator('contains', 'Hello', 'xyz')).toBe(false);
    });

    it('contains: value in array', () => {
      expect(evaluateOperator('contains', ['a', 'b', 'c'], 'b')).toBe(true);
    });

    it('contains: value not in array', () => {
      expect(evaluateOperator('contains', ['a', 'b'], 'z')).toBe(false);
    });

    it('contains: returns false for non-string/non-array', () => {
      expect(evaluateOperator('contains', 42, 'test')).toBe(false);
    });

    it('notContains: inverse of contains', () => {
      expect(evaluateOperator('notContains', 'Hello', 'xyz')).toBe(true);
    });
  });

  describe('regex', () => {
    it('matches valid pattern', () => {
      expect(evaluateOperator('regex', 'hello-world', '^hello')).toBe(true);
    });

    it('fails non-matching pattern', () => {
      expect(evaluateOperator('regex', 'goodbye', '^hello')).toBe(false);
    });

    it('handles null fieldValue', () => {
      expect(evaluateOperator('regex', null, '^test')).toBe(false);
    });

    it('returns false for non-string ruleValue', () => {
      expect(evaluateOperator('regex', 'test', 42)).toBe(false);
    });

    it('returns false for invalid regex', () => {
      expect(evaluateOperator('regex', 'test', '[')).toBe(false);
    });
  });

  describe('numeric comparisons', () => {
    it('gt: 10 > 5', () => expect(evaluateOperator('gt', 10, 5)).toBe(true));
    it('gt: 5 > 10', () => expect(evaluateOperator('gt', 5, 10)).toBe(false));
    it('gte: 10 >= 10', () => expect(evaluateOperator('gte', 10, 10)).toBe(true));
    it('lt: 5 < 10', () => expect(evaluateOperator('lt', 5, 10)).toBe(true));
    it('lte: 10 <= 10', () => expect(evaluateOperator('lte', 10, 10)).toBe(true));
    it('handles string numbers', () => expect(evaluateOperator('gt', '10', '5')).toBe(true));
  });

  describe('in / notIn', () => {
    it('in: value in array', () => {
      expect(evaluateOperator('in', 'SMALL', ['SMALL', 'MEDIUM', 'LARGE'])).toBe(true);
    });

    it('in: value not in array', () => {
      expect(evaluateOperator('in', 'XLARGE', ['SMALL', 'MEDIUM'])).toBe(false);
    });

    it('in: returns false for non-array ruleValue', () => {
      expect(evaluateOperator('in', 'test', 'not-array')).toBe(false);
    });

    it('notIn: value not in array', () => {
      expect(evaluateOperator('notIn', 'XLARGE', ['SMALL', 'MEDIUM'])).toBe(true);
    });

    it('notIn: value in array', () => {
      expect(evaluateOperator('notIn', 'SMALL', ['SMALL', 'MEDIUM'])).toBe(false);
    });
  });

  describe('exists / notExists', () => {
    it('exists: non-null value', () => expect(evaluateOperator('exists', 'hello', null)).toBe(true));
    it('exists: null', () => expect(evaluateOperator('exists', null, null)).toBe(false));
    it('exists: undefined', () => expect(evaluateOperator('exists', undefined, null)).toBe(false));
    it('exists: zero is truthy for exists', () => expect(evaluateOperator('exists', 0, null)).toBe(true));
    it('exists: empty string is truthy', () => expect(evaluateOperator('exists', '', null)).toBe(true));
    it('notExists: null', () => expect(evaluateOperator('notExists', null, null)).toBe(true));
    it('notExists: non-null', () => expect(evaluateOperator('notExists', 'hello', null)).toBe(false));
  });

  describe('count/length operators', () => {
    it('countGt', () => expect(evaluateOperator('countGt', 5, 3)).toBe(true));
    it('countLt', () => expect(evaluateOperator('countLt', 2, 5)).toBe(true));
    it('lengthGt', () => expect(evaluateOperator('lengthGt', 100, 50)).toBe(true));
    it('lengthLt', () => expect(evaluateOperator('lengthLt', 10, 50)).toBe(true));
  });

  describe('unknown operator', () => {
    it('returns false (fail-closed)', () => {
      expect(evaluateOperator('unknownOp' as any, 'a', 'b')).toBe(false);
    });
  });
});

// ============================================
// validateRegexPattern
// ============================================

describe('validateRegexPattern', () => {
  it('returns null for valid pattern', () => {
    expect(validateRegexPattern('^hello')).toBeNull();
  });

  it('returns error for pattern exceeding max length', () => {
    const longPattern = 'a'.repeat(201);
    expect(validateRegexPattern(longPattern)).toContain('maximum length');
  });

  it('returns error for nested quantifiers', () => {
    expect(validateRegexPattern('(a+)+')).toContain('nested quantifiers');
  });

  it('returns error for invalid regex', () => {
    expect(validateRegexPattern('[')).toContain('Invalid regex');
  });

  it('accepts pattern at max length', () => {
    expect(validateRegexPattern('a'.repeat(200))).toBeNull();
  });
});
