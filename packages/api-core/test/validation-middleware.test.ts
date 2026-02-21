import { z } from 'zod';
import { ErrorCode } from '../src/types/error-codes';
import {
  validateQuery,
  validateBody,
  validateParams,
  validateQueryMiddleware,
  validateBodyMiddleware,
  validateParamsMiddleware,
} from '../src/validation/middleware';

// ---------------------------------------------------------------------------
// Mock Request / Response / Next
// ---------------------------------------------------------------------------
function mockReq(overrides: Record<string, unknown> = {}) {
  return { query: {}, body: {}, params: {}, ...overrides } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 0,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(data: any) { res.body = data; return res; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const TestSchema = z.object({
  name: z.string().min(1),
  age: z.coerce.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateQuery', () => {
  it('should return ok with parsed value for valid query', () => {
    const req = mockReq({ query: { name: 'Alice', age: '25' } });
    const result = validateQuery(req, TestSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('Alice');
      expect(result.value.age).toBe(25);
    }
  });

  it('should return error for invalid query', () => {
    const req = mockReq({ query: { name: '' } });
    const result = validateQuery(req, TestSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('name');
      expect(result.zodError).toBeDefined();
    }
  });

  it('should return generic message for non-Zod errors', () => {
    const badSchema = { parse: () => { throw new Error('boom'); } } as any;
    const req = mockReq();
    const result = validateQuery(req, badSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Validation failed');
    }
  });
});

describe('validateBody', () => {
  it('should return ok with parsed value for valid body', () => {
    const req = mockReq({ body: { name: 'Bob' } });
    const result = validateBody(req, TestSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('Bob');
    }
  });

  it('should return error for invalid body', () => {
    const req = mockReq({ body: {} });
    const result = validateBody(req, TestSchema);
    expect(result.ok).toBe(false);
  });
});

describe('validateParams', () => {
  const IdSchema = z.object({ id: z.string().uuid() });

  it('should return ok with parsed value for valid params', () => {
    const req = mockReq({ params: { id: '550e8400-e29b-41d4-a716-446655440000' } });
    const result = validateParams(req, IdSchema);
    expect(result.ok).toBe(true);
  });

  it('should return error for invalid params', () => {
    const req = mockReq({ params: { id: 'not-uuid' } });
    const result = validateParams(req, IdSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('id');
    }
  });
});

describe('validateQueryMiddleware', () => {
  it('should call next() for valid query', () => {
    const req = mockReq({ query: { name: 'Alice' } });
    const res = mockRes();
    const next = jest.fn();

    const middleware = validateQueryMiddleware(TestSchema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.validatedQuery).toBeDefined();
    expect(req.validatedQuery.name).toBe('Alice');
  });

  it('should send 400 for invalid query', () => {
    const req = mockReq({ query: { name: '' } });
    const res = mockRes();
    const next = jest.fn();

    const middleware = validateQueryMiddleware(TestSchema);
    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe('validateBodyMiddleware', () => {
  it('should call next() for valid body', () => {
    const req = mockReq({ body: { name: 'Bob' } });
    const res = mockRes();
    const next = jest.fn();

    const middleware = validateBodyMiddleware(TestSchema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.validatedBody.name).toBe('Bob');
  });

  it('should send 400 for invalid body', () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    const next = jest.fn();

    const middleware = validateBodyMiddleware(TestSchema);
    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });
});

describe('validateParamsMiddleware', () => {
  const IdSchema = z.object({ id: z.string().min(1) });

  it('should call next() for valid params', () => {
    const req = mockReq({ params: { id: 'abc' } });
    const res = mockRes();
    const next = jest.fn();

    const middleware = validateParamsMiddleware(IdSchema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.validatedParams.id).toBe('abc');
  });

  it('should send 400 for invalid params', () => {
    const req = mockReq({ params: { id: '' } });
    const res = mockRes();
    const next = jest.fn();

    const middleware = validateParamsMiddleware(IdSchema);
    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });
});
