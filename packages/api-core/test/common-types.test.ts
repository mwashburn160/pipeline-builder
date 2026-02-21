import {
  isValidQuotaType,
  validateQuotaType,
  VALID_QUOTA_TYPES,
} from '../src/types/common';

describe('VALID_QUOTA_TYPES', () => {
  it('should contain plugins, pipelines, apiCalls', () => {
    expect(VALID_QUOTA_TYPES).toEqual(['plugins', 'pipelines', 'apiCalls']);
  });
});

describe('isValidQuotaType', () => {
  it('should return true for valid quota types', () => {
    expect(isValidQuotaType('plugins')).toBe(true);
    expect(isValidQuotaType('pipelines')).toBe(true);
    expect(isValidQuotaType('apiCalls')).toBe(true);
  });

  it('should return false for invalid strings', () => {
    expect(isValidQuotaType('invalid')).toBe(false);
    expect(isValidQuotaType('PLUGINS')).toBe(false);
    expect(isValidQuotaType('')).toBe(false);
  });

  it('should return false for non-string values', () => {
    expect(isValidQuotaType(123)).toBe(false);
    expect(isValidQuotaType(null)).toBe(false);
    expect(isValidQuotaType(undefined)).toBe(false);
    expect(isValidQuotaType(true)).toBe(false);
  });
});

describe('validateQuotaType', () => {
  it('should return valid quota type', () => {
    expect(validateQuotaType('plugins')).toBe('plugins');
    expect(validateQuotaType('pipelines')).toBe('pipelines');
    expect(validateQuotaType('apiCalls')).toBe('apiCalls');
  });

  it('should throw for invalid values', () => {
    expect(() => validateQuotaType('invalid')).toThrow(
      'Invalid quotaType: "invalid". Must be one of: plugins, pipelines, apiCalls',
    );
  });

  it('should use custom field name in error message', () => {
    expect(() => validateQuotaType('bad', 'type')).toThrow(
      'Invalid type: "bad". Must be one of: plugins, pipelines, apiCalls',
    );
  });

  it('should throw for null/undefined', () => {
    expect(() => validateQuotaType(null)).toThrow();
    expect(() => validateQuotaType(undefined)).toThrow();
  });
});
