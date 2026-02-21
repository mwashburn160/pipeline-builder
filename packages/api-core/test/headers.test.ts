import { getHeaderString, getRequiredHeader, getHeaders } from '../src/utils/headers';

describe('getHeaderString', () => {
  it('should return string value as-is', () => {
    expect(getHeaderString('value')).toBe('value');
  });

  it('should return first element from array', () => {
    expect(getHeaderString(['first', 'second'])).toBe('first');
  });

  it('should return undefined for undefined', () => {
    expect(getHeaderString(undefined)).toBeUndefined();
  });

  it('should return empty string as-is', () => {
    expect(getHeaderString('')).toBe('');
  });
});

describe('getRequiredHeader', () => {
  it('should return string value', () => {
    expect(getRequiredHeader('value', 'X-Test')).toBe('value');
  });

  it('should return first element from array', () => {
    expect(getRequiredHeader(['first', 'second'], 'X-Test')).toBe('first');
  });

  it('should throw for undefined', () => {
    expect(() => getRequiredHeader(undefined, 'X-Test')).toThrow(
      'Missing required header: X-Test',
    );
  });

  it('should throw for empty string', () => {
    expect(() => getRequiredHeader('', 'Authorization')).toThrow(
      'Missing required header: Authorization',
    );
  });
});

describe('getHeaders', () => {
  it('should extract multiple headers', () => {
    const headers = {
      'authorization': 'Bearer token',
      'x-org-id': 'org-1',
      'x-other': undefined,
    };
    const result = getHeaders(headers, ['authorization', 'x-org-id', 'x-other']);
    expect(result).toEqual({
      'authorization': 'Bearer token',
      'x-org-id': 'org-1',
      'x-other': undefined,
    });
  });

  it('should handle array header values', () => {
    const headers = { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] };
    const result = getHeaders(headers, ['x-forwarded-for']);
    expect(result['x-forwarded-for']).toBe('1.1.1.1');
  });

  it('should return undefined for missing headers', () => {
    const result = getHeaders({}, ['missing']);
    expect(result.missing).toBeUndefined();
  });
});
