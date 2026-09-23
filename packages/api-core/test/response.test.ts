// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { ErrorCode } from '../src/types/error-codes.js';
import {
  sendSuccess,
  sendError,
  sendQuotaExceeded,
  sendPaginatedNested,
  paginationMeta,
  extractDbError,
  errorMessage,
  sendBadRequest,
  sendInternalError,
  parsePaginationParams,
} from '../src/utils/response.js';

// Mock Express Response
function mockRes() {
  const res: any = {
    statusCode: 0,
    body: null as any,
    headers: {} as Record<string, string | number>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
    setHeader(name: string, value: string | number) {
      res.headers[name] = value;
    },
  };
  return res;
}

// Tests

describe('sendSuccess', () => {
  it('should send success response with data', () => {
    const res = mockRes();
    sendSuccess(res, 200, { id: '123' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.statusCode).toBe(200);
    expect(res.body.data).toEqual({ id: '123' });
  });

  it('should send success with message', () => {
    const res = mockRes();
    sendSuccess(res, 201, { id: '1' }, 'Created');
    expect(res.statusCode).toBe(201);
    expect(res.body.message).toBe('Created');
  });

  it('should omit data when undefined', () => {
    const res = mockRes();
    sendSuccess(res, 204);
    expect(res.body.data).toBeUndefined();
  });

  it('should omit message when not provided', () => {
    const res = mockRes();
    sendSuccess(res, 200, {});
    expect(res.body.message).toBeUndefined();
  });
});

describe('sendError', () => {
  it('should send error response', () => {
    const res = mockRes();
    sendError(res, 404, 'Not found', ErrorCode.NOT_FOUND);
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.statusCode).toBe(404);
    expect(res.body.message).toBe('Not found');
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('should include details when provided', () => {
    const res = mockRes();
    sendError(res, 400, 'Validation error', ErrorCode.VALIDATION_ERROR, { field: 'name' });
    expect(res.body.details).toEqual({ field: 'name' });
  });

  it('should omit code and details when not provided', () => {
    const res = mockRes();
    sendError(res, 500, 'Error');
    expect(res.body.code).toBeUndefined();
    expect(res.body.details).toBeUndefined();
  });
});

describe('sendQuotaExceeded', () => {
  it('should send 429 with quota headers', () => {
    const res = mockRes();
    const quota = { type: 'apiCalls' as any, limit: 100, used: 100, remaining: 0 };
    const futureDate = new Date(Date.now() + 60000).toISOString();
    sendQuotaExceeded(res, 'apiCalls', quota, futureDate);

    expect(res.statusCode).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe(ErrorCode.QUOTA_EXCEEDED);
    expect(res.body.details).toEqual({ quota });
    expect(res.headers['X-Quota-Limit']).toBe(100);
    expect(res.headers['X-Quota-Used']).toBe(100);
    expect(res.headers['X-Quota-Remaining']).toBe(0);
    expect(res.headers['X-Quota-Reset']).toBe(futureDate);
    expect(res.headers['Retry-After']).toBeGreaterThan(0);
  });

  it('should set Retry-After to 0 for past reset dates', () => {
    const res = mockRes();
    const quota = { type: 'plugins' as any, limit: 10, used: 10, remaining: 0 };
    const pastDate = new Date(Date.now() - 60000).toISOString();
    sendQuotaExceeded(res, 'plugins', quota, pastDate);

    expect(res.headers['Retry-After']).toBe(0);
  });

  it('should handle missing resetAt', () => {
    const res = mockRes();
    const quota = { type: 'plugins' as any, limit: 10, used: 10, remaining: 0 };
    sendQuotaExceeded(res, 'plugins', quota);

    expect(res.statusCode).toBe(429);
    expect(res.headers['X-Quota-Reset']).toBeUndefined();
  });

  it('should include quota type in message', () => {
    const res = mockRes();
    const quota = { type: 'pipelines' as any, limit: 5, used: 5, remaining: 0 };
    sendQuotaExceeded(res, 'pipelines', quota);

    expect(res.body.message).toContain('pipelines');
    expect(res.body.message).toContain('5/5');
  });
});

describe('sendPaginatedNested', () => {
  it('should nest data under the given key with pagination metadata', () => {
    const res = mockRes();
    sendPaginatedNested(res, 'pipelines', [{ id: '1' }, { id: '2' }], {
      total: 50, limit: 25, offset: 0, hasMore: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.pipelines).toEqual([{ id: '1' }, { id: '2' }]);
    expect(res.body.data.pagination).toEqual({ total: 50, limit: 25, offset: 0, hasMore: true });
  });

  it('should omit total when not provided', () => {
    const res = mockRes();
    sendPaginatedNested(res, 'rows', [], { limit: 10, offset: 0, hasMore: false });
    expect(res.body.data.pagination.total).toBeUndefined();
    expect(res.body.data.pagination).toEqual({ limit: 10, offset: 0, hasMore: false });
  });

  it('should include nextCursor when provided', () => {
    const res = mockRes();
    sendPaginatedNested(res, 'rows', [], {
      limit: 10, offset: 0, hasMore: true, nextCursor: 'abc123',
    });
    expect(res.body.data.pagination.nextCursor).toBe('abc123');
  });

  it('should use custom statusCode', () => {
    const res = mockRes();
    sendPaginatedNested(res, 'rows', [], { limit: 10, offset: 0, hasMore: false, statusCode: 206 });
    expect(res.statusCode).toBe(206);
  });

  it('derives hasMore from the row count when the caller omits it', () => {
    // `offset + rows.length < total` was the single most-repeated expression in
    // the API; deriving it here is what stops one route spelling it wrong.
    const res = mockRes();
    sendPaginatedNested(res, 'rows', [{ id: '1' }, { id: '2' }], { total: 50, limit: 2, offset: 0 });
    expect(res.body.data.pagination).toEqual({ total: 50, limit: 2, offset: 0, hasMore: true });
  });

  it('derives hasMore=false on the last page', () => {
    const res = mockRes();
    sendPaginatedNested(res, 'rows', [{ id: '49' }, { id: '50' }], { total: 50, limit: 25, offset: 48 });
    expect(res.body.data.pagination.hasMore).toBe(false);
  });

  it('derives hasMore=false for an empty page past the end', () => {
    const res = mockRes();
    sendPaginatedNested(res, 'rows', [], { total: 50, limit: 25, offset: 50 });
    expect(res.body.data.pagination.hasMore).toBe(false);
  });

  it('keeps an explicit hasMore=false rather than re-deriving it', () => {
    // `??` must not treat `false` as "unset" — a limit+1 peek-ahead route knows
    // better than the row count does.
    const res = mockRes();
    sendPaginatedNested(res, 'rows', [{ id: '1' }], { total: 50, limit: 25, offset: 0, hasMore: false });
    expect(res.body.data.pagination.hasMore).toBe(false);
  });

  it('falls back to "a cursor was issued" when there is no total', () => {
    const withCursor = mockRes();
    sendPaginatedNested(withCursor, 'rows', [{ id: '1' }], { limit: 10, offset: 0, nextCursor: 'abc123' });
    expect(withCursor.body.data.pagination.hasMore).toBe(true);

    const last = mockRes();
    sendPaginatedNested(last, 'rows', [{ id: '1' }], { limit: 10, offset: 0 });
    expect(last.body.data.pagination.hasMore).toBe(false);
  });
});

describe('paginationMeta', () => {
  it('builds the envelope and derives hasMore from a full page', () => {
    expect(paginationMeta({ total: 50, offset: 0, limit: 10 }))
      .toEqual({ total: 50, offset: 0, limit: 10, hasMore: true });
  });

  it('reports no more once the window reaches the total', () => {
    expect(paginationMeta({ total: 50, offset: 40, limit: 10 }).hasMore).toBe(false);
    expect(paginationMeta({ total: 50, offset: 45, limit: 10 }).hasMore).toBe(false);
  });

  it('honours `returned` for a short page', () => {
    // A route whose page can be shorter than its limit (filtered after the
    // query) would otherwise claim the window covered rows it never returned.
    expect(paginationMeta({ total: 50, offset: 0, limit: 25, returned: 3 }).hasMore).toBe(true);
    expect(paginationMeta({ total: 3, offset: 0, limit: 25, returned: 3 }).hasMore).toBe(false);
  });

  it('reports no more for an unpaged "everything" answer', () => {
    expect(paginationMeta({ total: 7, offset: 0, limit: 7 }).hasMore).toBe(false);
  });

  it('reports no more for an empty result set', () => {
    expect(paginationMeta({ total: 0, offset: 0, limit: 10 })).toEqual({ total: 0, offset: 0, limit: 10, hasMore: false });
  });
});

describe('extractDbError', () => {
  it('should extract PostgreSQL error fields', () => {
    const error = {
      code: '23505',
      detail: 'Key (name)=(test) already exists.',
      hint: 'Use upsert instead',
      constraint: 'plugins_name_key',
      table: 'plugins',
      column: 'name',
    };
    const result = extractDbError(error);
    expect(result.dbCode).toBe('23505');
    expect(result.dbDetail).toBe('Key (name)=(test) already exists.');
    expect(result.dbHint).toBe('Use upsert instead');
    expect(result.constraint).toBe('plugins_name_key');
    expect(result.table).toBe('plugins');
    expect(result.column).toBe('name');
  });

  it('should skip missing fields', () => {
    const result = extractDbError({ code: '42601' });
    expect(result).toEqual({ dbCode: '42601' });
  });

  it('should return empty object for null', () => {
    expect(extractDbError(null)).toEqual({});
  });

  it('should return empty object for non-object', () => {
    expect(extractDbError('string error')).toEqual({});
    expect(extractDbError(undefined)).toEqual({});
  });

  it('should unwrap a pg error nested under .cause (drizzle)', () => {
    const result = extractDbError(new Error('Failed query: insert ...', {
      cause: { code: '23505', constraint: 'plugins_name_key' },
    }));
    expect(result).toEqual({ dbCode: '23505', constraint: 'plugins_name_key' });
  });

  it('should NOT report a transport error code as a dbCode', () => {
    // A socket error carries `.code` too. Reporting it as `dbCode` sent readers
    // hunting through (clean) Postgres logs for a failure that was really the
    // pooler dropping out of the Service endpoints.
    // EPIPE and E2BIG are five uppercase characters — SQLSTATE-shaped by length
    // alone, so the leading-E rule is what actually rejects them.
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'E2BIG', 'EHOSTUNREACH']) {
      expect(extractDbError({ code })).toEqual({});
    }
  });

  it('should NOT report a nested transport error code as a dbCode', () => {
    // undici/fetch wraps the socket error in `.cause`, which lands on the same
    // unwrap path drizzle uses for real pg errors.
    const result = extractDbError(new Error('fetch failed', { cause: { code: 'ECONNRESET' } }));
    expect(result).toEqual({});
  });

  it('should reject codes that are not SQLSTATE-shaped', () => {
    expect(extractDbError({ code: '2350' })).toEqual({}); // too short
    expect(extractDbError({ code: '235055' })).toEqual({}); // too long
    expect(extractDbError({ code: '23e05' })).toEqual({}); // lowercase
    expect(extractDbError({ code: 23505 })).toEqual({}); // not a string
  });

  it('should accept every SQLSTATE shape Postgres actually emits', () => {
    expect(extractDbError({ code: '23505' }).dbCode).toBe('23505'); // unique_violation
    expect(extractDbError({ code: '42P01' }).dbCode).toBe('42P01'); // undefined_table
    expect(extractDbError({ code: '57014' }).dbCode).toBe('57014'); // query_canceled
    expect(extractDbError({ code: '08006' }).dbCode).toBe('08006'); // connection_failure
    expect(extractDbError({ code: 'P0001' }).dbCode).toBe('P0001'); // raise_exception
  });

  it('should still extract pg field details when the code is absent', () => {
    // Fields that only a pg error carries stay useful on their own.
    const result = extractDbError({ constraint: 'plugins_name_key', table: 'plugins' });
    expect(result).toEqual({ constraint: 'plugins_name_key', table: 'plugins' });
  });
});

describe('errorMessage', () => {
  it('should extract message from Error instances', () => {
    expect(errorMessage(new Error('test error'))).toBe('test error');
  });

  it('should convert non-Error to string', () => {
    expect(errorMessage('string error')).toBe('string error');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });

  it('falls back to .code when message is empty (socket ErrnoException)', () => {
    // Node socket errors (ECONNREFUSED/ETIMEDOUT) can carry only a code.
    const err = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    expect(errorMessage(err)).toBe('ECONNREFUSED');
  });

  it('falls back to .code for an empty-message AggregateError (dual-stack connect)', () => {
    // Node's IPv4+IPv6 connect failures surface as an AggregateError whose own
    // message is blank — this is exactly what produced the silent `error:""`.
    const agg = Object.assign(new Error(''), {
      name: 'AggregateError',
      code: 'ETIMEDOUT',
      errors: [new Error('connect ETIMEDOUT 172.18.0.13:3000')],
    });
    expect(errorMessage(agg)).toBe('ETIMEDOUT');
  });

  it('joins sub-errors when an empty-message AggregateError has no code', () => {
    const agg = Object.assign(new Error(''), {
      name: 'AggregateError',
      errors: [new Error('v6 refused'), new Error('v4 refused')],
    });
    expect(errorMessage(agg)).toBe('v6 refused; v4 refused');
  });

  it('falls back to the error name when nothing else is present', () => {
    expect(errorMessage(new Error(''))).toBe('Error');
  });
});

describe('sendBadRequest', () => {
  it('should send 400 with validation error code', () => {
    const res = mockRes();
    sendBadRequest(res, 'Invalid input');
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Invalid input');
    expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('should accept custom error code', () => {
    const res = mockRes();
    sendBadRequest(res, 'Missing field', ErrorCode.MISSING_REQUIRED_FIELD);
    expect(res.body.code).toBe(ErrorCode.MISSING_REQUIRED_FIELD);
  });
});

describe('sendInternalError', () => {
  it('should send 500 with internal error code', () => {
    const res = mockRes();
    sendInternalError(res, 'Something broke');
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Something broke');
    expect(res.body.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it('should include details when provided', () => {
    const res = mockRes();
    sendInternalError(res, 'DB error', { dbCode: '42601' });
    expect(res.body.details).toEqual({ dbCode: '42601' });
  });
});

describe('parsePaginationParams', () => {
  it('should parse valid params', () => {
    const result = parsePaginationParams({ limit: '20', offset: '10', sortBy: 'name', sortOrder: 'asc' });
    expect(result).toEqual({ limit: 20, offset: 10, sortBy: 'name', sortOrder: 'asc' });
  });

  it('should use defaults for missing params', () => {
    const result = parsePaginationParams({});
    expect(result).toEqual({ limit: 10, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' });
  });

  it('should clamp limit to 1-MAX_PAGE_LIMIT', () => {
    // Out-of-range values clamp to [1, MAX_PAGE_LIMIT]; junk falls back to 10.
    expect(parsePaginationParams({ limit: '0' }).limit).toBe(1);
    expect(parsePaginationParams({ limit: '-5' }).limit).toBe(1);
    expect(parsePaginationParams({ limit: 'abc' }).limit).toBe(10);
    // MAX_PAGE_LIMIT defaults to 1000
    expect(parsePaginationParams({ limit: '200' }).limit).toBe(200);
    expect(parsePaginationParams({ limit: '5000' }).limit).toBe(1000);
  });

  it('should clamp offset to minimum 0', () => {
    expect(parsePaginationParams({ offset: '-5' }).offset).toBe(0);
  });

  it('should default sortOrder to desc for non-asc values', () => {
    expect(parsePaginationParams({ sortOrder: 'invalid' }).sortOrder).toBe('desc');
    expect(parsePaginationParams({ sortOrder: 'DESC' }).sortOrder).toBe('desc');
  });

  it('should parse asc sortOrder case-insensitively', () => {
    expect(parsePaginationParams({ sortOrder: 'ASC' }).sortOrder).toBe('asc');
    expect(parsePaginationParams({ sortOrder: 'Asc' }).sortOrder).toBe('asc');
  });
});
