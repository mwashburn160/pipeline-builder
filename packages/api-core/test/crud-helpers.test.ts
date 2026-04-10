// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeArrayFields,
  sendEntityNotFound,
} from '../src/helpers/crud-helpers';

// Mock Response
function mockRes() {
  const res: any = {
    statusCode: 0,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(data: any) { res.body = data; return res; },
  };
  return res;
}

// Tests

describe('normalizeArrayFields', () => {
  it('should convert non-array fields to empty arrays', () => {
    const record = { name: 'test', tags: 'not-an-array', items: null };
    const result = normalizeArrayFields(record, ['tags', 'items']);
    expect(result.tags).toEqual([]);
    expect(result.items).toEqual([]);
    expect(result.name).toBe('test');
  });

  it('should leave existing arrays unchanged', () => {
    const record = { tags: ['a', 'b'] };
    const result = normalizeArrayFields(record, ['tags']);
    expect(result.tags).toEqual(['a', 'b']);
  });

  it('should not mutate the original record', () => {
    const record = { tags: 'not-array' };
    const result = normalizeArrayFields(record, ['tags']);
    expect(record.tags).toBe('not-array');
    expect(result.tags).toEqual([]);
  });

  it('should ignore fields not present in the record', () => {
    const record = { name: 'test' };
    const result = normalizeArrayFields(record, ['missing' as any]);
    expect(result).toEqual({ name: 'test' });
  });
});

describe('sendEntityNotFound', () => {
  it('should send 404 with entity name', () => {
    const res = mockRes();
    sendEntityNotFound(res, 'Pipeline');
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Pipeline not found.');
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
