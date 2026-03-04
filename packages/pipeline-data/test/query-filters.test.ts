import {
  validateCommonFilter,
  validatePluginFilter,
  validatePipelineFilter,
} from '../src/core/query-filters';

// Validation
describe('validateCommonFilter', () => {
  it('should pass for valid filter', () => {
    expect(() => validateCommonFilter({ limit: 10, offset: 0, sort: 'name:asc' })).not.toThrow();
  });

  it('should pass for empty filter', () => {
    expect(() => validateCommonFilter({})).not.toThrow();
  });

  it('should reject limit < 1', () => {
    expect(() => validateCommonFilter({ limit: 0 })).toThrow('limit must be an integer between 1 and 1000');
  });

  it('should reject limit > 1000', () => {
    expect(() => validateCommonFilter({ limit: 1001 })).toThrow('limit must be an integer between 1 and 1000');
  });

  it('should reject negative offset', () => {
    expect(() => validateCommonFilter({ offset: -1 })).toThrow('offset must be a non-negative integer');
  });

  it('should reject invalid sort format', () => {
    expect(() => validateCommonFilter({ sort: 'invalid' })).toThrow('sort must be in format');
  });

  it('should accept valid sort format', () => {
    expect(() => validateCommonFilter({ sort: 'createdAt:desc' })).not.toThrow();
    expect(() => validateCommonFilter({ sort: 'name:asc' })).not.toThrow();
  });

  it('should accept string limit (coerced)', () => {
    expect(() => validateCommonFilter({ limit: '10' as any })).not.toThrow();
  });
});

describe('validatePluginFilter', () => {
  it('should validate common and plugin-specific fields', () => {
    expect(() => validatePluginFilter({ name: 'test', version: '1.0.0' })).not.toThrow();
  });

  it('should reject invalid version format', () => {
    expect(() => validatePluginFilter({ version: 'not-semver' })).toThrow('Invalid version format');
  });

  it('should accept semantic versions with prefix', () => {
    expect(() => validatePluginFilter({ version: '^2.0.0' })).not.toThrow();
    expect(() => validatePluginFilter({ version: '~1.2.3' })).not.toThrow();
  });
});

describe('validatePipelineFilter', () => {
  it('should validate common filter properties', () => {
    expect(() => validatePipelineFilter({ limit: 10 })).not.toThrow();
    expect(() => validatePipelineFilter({ limit: 0 })).toThrow();
  });
});
