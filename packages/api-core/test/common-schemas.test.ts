import {
  AccessModifierSchema,
  SortOrderSchema,
  PaginationSchema,
  BooleanQuerySchema,
  UUIDSchema,
  UUIDPrefixSchema,
  BaseFilterSchema,
} from '../src/validation/common-schemas';

describe('AccessModifierSchema', () => {
  it('should accept "public"', () => {
    expect(AccessModifierSchema.parse('public')).toBe('public');
  });

  it('should accept "private"', () => {
    expect(AccessModifierSchema.parse('private')).toBe('private');
  });

  it('should reject invalid values', () => {
    expect(() => AccessModifierSchema.parse('protected')).toThrow();
    expect(() => AccessModifierSchema.parse('')).toThrow();
  });
});

describe('SortOrderSchema', () => {
  it('should accept asc and desc', () => {
    expect(SortOrderSchema.parse('asc')).toBe('asc');
    expect(SortOrderSchema.parse('desc')).toBe('desc');
  });

  it('should reject invalid values', () => {
    expect(() => SortOrderSchema.parse('ascending')).toThrow();
  });
});

describe('PaginationSchema', () => {
  it('should parse valid pagination params', () => {
    const result = PaginationSchema.parse({ limit: '10', offset: '0', sortBy: 'name', sortOrder: 'asc' });
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
    expect(result.sortBy).toBe('name');
    expect(result.sortOrder).toBe('asc');
  });

  it('should allow all fields to be optional', () => {
    const result = PaginationSchema.parse({});
    expect(result.limit).toBeUndefined();
    expect(result.offset).toBeUndefined();
  });

  it('should reject limit < 1', () => {
    expect(() => PaginationSchema.parse({ limit: '0' })).toThrow();
  });

  it('should reject limit > 1000', () => {
    expect(() => PaginationSchema.parse({ limit: '1001' })).toThrow();
  });

  it('should reject negative offset', () => {
    expect(() => PaginationSchema.parse({ offset: '-1' })).toThrow();
  });
});

describe('BooleanQuerySchema', () => {
  it('should accept boolean values', () => {
    expect(BooleanQuerySchema.parse(true)).toBe(true);
    expect(BooleanQuerySchema.parse(false)).toBe(false);
  });

  it('should transform "true"/"false" strings', () => {
    expect(BooleanQuerySchema.parse('true')).toBe(true);
    expect(BooleanQuerySchema.parse('false')).toBe(false);
  });

  it('should transform other strings based on "true" equality', () => {
    expect(BooleanQuerySchema.parse('yes')).toBe(false);
    expect(BooleanQuerySchema.parse('1')).toBe(false);
  });
});

describe('UUIDSchema', () => {
  it('should accept valid UUIDs', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(UUIDSchema.parse(uuid)).toBe(uuid);
  });

  it('should reject invalid UUIDs', () => {
    expect(() => UUIDSchema.parse('not-a-uuid')).toThrow('Invalid UUID format');
  });
});

describe('UUIDPrefixSchema', () => {
  it('should accept valid UUID prefixes', () => {
    expect(UUIDPrefixSchema.parse('550e8400')).toBe('550e8400');
    expect(UUIDPrefixSchema.parse('550e8400-e29b')).toBe('550e8400-e29b');
  });

  it('should reject invalid characters', () => {
    expect(() => UUIDPrefixSchema.parse('xyz!')).toThrow();
  });
});

describe('BaseFilterSchema', () => {
  it('should parse valid base filter', () => {
    const result = BaseFilterSchema.parse({
      accessModifier: 'public',
      isActive: true,
      isDefault: 'false',
    });
    expect(result.accessModifier).toBe('public');
    expect(result.isActive).toBe(true);
    expect(result.isDefault).toBe(false);
  });

  it('should accept UUID for id', () => {
    const result = BaseFilterSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should accept UUID prefix for id', () => {
    const result = BaseFilterSchema.parse({ id: '550e8400' });
    expect(result.id).toBe('550e8400');
  });

  it('should accept array of UUIDs for id', () => {
    const ids = ['550e8400-e29b-41d4-a716-446655440000', '660e8400-e29b-41d4-a716-446655440000'];
    const result = BaseFilterSchema.parse({ id: ids });
    expect(result.id).toEqual(ids);
  });

  it('should allow all fields to be optional', () => {
    const result = BaseFilterSchema.parse({});
    expect(result.id).toBeUndefined();
    expect(result.accessModifier).toBeUndefined();
  });
});
