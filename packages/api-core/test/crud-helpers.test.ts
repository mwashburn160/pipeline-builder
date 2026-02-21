import {
  normalizeArrayFields,
  createOrderByResolver,
  validateAccessModifier,
  initUpdateData,
  sendEntityNotFound,
} from '../src/helpers/crud-helpers';

// ---------------------------------------------------------------------------
// Mock Response
// ---------------------------------------------------------------------------
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
// Tests
// ---------------------------------------------------------------------------

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

describe('createOrderByResolver', () => {
  it('should return ascending sort for asc order', () => {
    const ascFn = jest.fn((col) => `ASC(${col})`);
    const descFn = jest.fn((col) => `DESC(${col})`);
    const columns = { name: 'nameCol', createdAt: 'createdAtCol' };
    const resolver = createOrderByResolver(columns, 'createdAtCol', ascFn, descFn);

    const result = resolver('name', 'asc');
    expect(ascFn).toHaveBeenCalledWith('nameCol');
    expect(result).toBe('ASC(nameCol)');
  });

  it('should return descending sort for desc order', () => {
    const ascFn = jest.fn();
    const descFn = jest.fn((col) => `DESC(${col})`);
    const columns = { name: 'nameCol' };
    const resolver = createOrderByResolver(columns, 'defaultCol', ascFn, descFn);

    const result = resolver('name', 'desc');
    expect(descFn).toHaveBeenCalledWith('nameCol');
    expect(result).toBe('DESC(nameCol)');
  });

  it('should use default column for unknown sortBy', () => {
    const ascFn = jest.fn((col) => `ASC(${col})`);
    const descFn = jest.fn();
    const columns = { name: 'nameCol' };
    const resolver = createOrderByResolver(columns, 'defaultCol', ascFn, descFn);

    resolver('unknown', 'asc');
    expect(ascFn).toHaveBeenCalledWith('defaultCol');
  });
});

describe('validateAccessModifier', () => {
  it('should accept "public"', () => {
    expect(validateAccessModifier('public')).toEqual({ valid: true });
  });

  it('should accept "private"', () => {
    expect(validateAccessModifier('private')).toEqual({ valid: true });
  });

  it('should reject invalid values', () => {
    const result = validateAccessModifier('protected');
    expect(result).toEqual({ valid: false, error: 'accessModifier must be "public" or "private"' });
  });

  it('should reject non-string values', () => {
    expect(validateAccessModifier(123)).toEqual(
      expect.objectContaining({ valid: false }),
    );
    expect(validateAccessModifier(undefined)).toEqual(
      expect.objectContaining({ valid: false }),
    );
  });
});

describe('initUpdateData', () => {
  it('should create update data with timestamp and userId', () => {
    const result = initUpdateData('user-123');
    expect(result.updatedBy).toBe('user-123');
    expect(result.updatedAt).toBeInstanceOf(Date);
  });

  it('should use "system" when userId is empty', () => {
    const result = initUpdateData('');
    expect(result.updatedBy).toBe('system');
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
