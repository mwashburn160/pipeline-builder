import { ErrorCode } from '../src/types/error-codes';
import {
  sendSuccess,
  sendError,
  sendQuotaExceeded,
  sendPaginated,
  extractDbError,
  errorMessage,
  sendBadRequest,
  sendInternalError,
  parsePaginationParams,
} from '../src/utils/response';

// ---------------------------------------------------------------------------
// Mock Express Response
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    expect(res.body.quota).toEqual(quota);
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

describe('sendPaginated', () => {
  it('should send paginated response', () => {
    const res = mockRes();
    sendPaginated(res, [1, 2, 3], { limit: 10, offset: 0 });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([1, 2, 3]);
    expect(res.body.count).toBe(3);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  it('should include total when provided', () => {
    const res = mockRes();
    sendPaginated(res, [1], { limit: 10, offset: 0, total: 50 });

    expect(res.body.total).toBe(50);
  });

  it('should include message when provided', () => {
    const res = mockRes();
    sendPaginated(res, [], { limit: 10, offset: 0, message: 'OK' });

    expect(res.body.message).toBe('OK');
  });

  it('should use custom statusCode', () => {
    const res = mockRes();
    sendPaginated(res, [], { limit: 10, offset: 0, statusCode: 206 });

    expect(res.statusCode).toBe(206);
    expect(res.body.statusCode).toBe(206);
  });

  it('should omit total and message when not provided', () => {
    const res = mockRes();
    sendPaginated(res, [], { limit: 10, offset: 0 });

    expect(res.body.total).toBeUndefined();
    expect(res.body.message).toBeUndefined();
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
    expect(res.body.dbCode).toBe('42601');
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

  it('should clamp limit to 1-100', () => {
    // 0 is falsy so falls through to default 10, then clamped to max(10,1)=10
    expect(parsePaginationParams({ limit: '0' }).limit).toBe(10);
    // -5 is truthy so goes through Math.max(-5,1)=1
    expect(parsePaginationParams({ limit: '-5' }).limit).toBe(1);
    expect(parsePaginationParams({ limit: '200' }).limit).toBe(100);
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
