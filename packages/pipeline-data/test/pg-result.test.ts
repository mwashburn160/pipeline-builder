// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, jest } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { executeRows, isUniqueViolation, resultRows } from '../src/database/pg-result.js';

describe('isUniqueViolation', () => {
  it('matches a top-level 23505', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });
  it('matches a wrapped driver error via cause', () => {
    expect(isUniqueViolation(new Error('wrap', { cause: { code: '23505' } }))).toBe(true);
  });
  it('rejects other codes and non-objects', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

describe('resultRows / executeRows', () => {
  it('normalises { rows } and bare arrays', () => {
    expect(resultRows<number>({ rows: [1, 2] })).toEqual([1, 2]);
    expect(resultRows<number>([3])).toEqual([3]);
    expect(resultRows<number>(undefined)).toEqual([]);
    expect(resultRows<number>({ rows: 'x' })).toEqual([]);
  });
  it('executes and returns rows', async () => {
    const executor = { execute: jest.fn(async () => ({ rows: [{ a: 1 }] })) };
    await expect(executeRows<{ a: number }>(executor, sql`SELECT 1 AS a`)).resolves.toEqual([{ a: 1 }]);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
