import { getHeaderString } from '../src/utils/headers';

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
