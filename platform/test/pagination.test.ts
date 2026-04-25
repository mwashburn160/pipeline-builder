// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('../src/config', () => ({
  config: {
    pagination: {
      defaultLimit: 20,
      maxLimit: 100,
    },
  },
}));

import { parsePagination } from '../src/utils/pagination';

describe('parsePagination', () => {
  it('should return defaults for undefined inputs', () => {
    expect(parsePagination(undefined, undefined)).toEqual({ offset: 0, limit: 20 });
  });

  it('should parse valid string numbers', () => {
    expect(parsePagination('10', '50')).toEqual({ offset: 10, limit: 50 });
  });

  it('should parse numeric inputs', () => {
    expect(parsePagination(5, 25)).toEqual({ offset: 5, limit: 25 });
  });

  it('should clamp limit to maxLimit', () => {
    expect(parsePagination(0, 500)).toEqual({ offset: 0, limit: 100 });
  });

  it('should clamp limit to minimum of 1', () => {
    expect(parsePagination(0, 0)).toEqual({ offset: 0, limit: 20 });
    expect(parsePagination(0, -5)).toEqual({ offset: 0, limit: 1 });
  });

  it('should clamp offset to minimum 0', () => {
    expect(parsePagination(-10, 10)).toEqual({ offset: 0, limit: 10 });
  });

  it('should fall back to default for non-numeric input', () => {
    expect(parsePagination('garbage', 'junk')).toEqual({ offset: 0, limit: 20 });
  });

  it('should respect overridden defaults', () => {
    const result = parsePagination(undefined, undefined, { defaultLimit: 5, maxLimit: 10 });
    expect(result).toEqual({ offset: 0, limit: 5 });
  });

  it('should respect overridden maxLimit', () => {
    const result = parsePagination(0, 999, { maxLimit: 50 });
    expect(result.limit).toBe(50);
  });
});
