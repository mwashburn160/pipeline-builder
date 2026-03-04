import { z } from 'zod';
import {
  validateQuery,
  validateBody,
  validateParams,
} from '../src/validation/middleware';

// Mock Request / Response / Next
function mockReq(overrides: Record<string, unknown> = {}) {
  return { query: {}, body: {}, params: {}, ...overrides } as any;
}

// Schemas
const TestSchema = z.object({
  name: z.string().min(1),
  age: z.coerce.number().int().min(0).optional(),
});

// Tests

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
