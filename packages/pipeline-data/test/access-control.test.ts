import {
  getAccessBehavior,
  parseBooleanFilter,
  normalizeStringFilter,
  escapeLikeWildcards,
} from '../src/api/access-control-builder';

describe('getAccessBehavior', () => {
  it('should return "org-and-public" when undefined', () => {
    expect(getAccessBehavior(undefined)).toBe('org-and-public');
  });

  it('should return "public" for "public"', () => {
    expect(getAccessBehavior('public')).toBe('public');
  });

  it('should return "private" for "private"', () => {
    expect(getAccessBehavior('private')).toBe('private');
  });

  it('should be case-insensitive', () => {
    expect(getAccessBehavior('PUBLIC')).toBe('public');
    expect(getAccessBehavior('Public')).toBe('public');
    expect(getAccessBehavior('PRIVATE')).toBe('private');
  });

  it('should return "org-and-public" for unknown values', () => {
    expect(getAccessBehavior('protected')).toBe('org-and-public');
    expect(getAccessBehavior('')).toBe('org-and-public');
  });
});

describe('parseBooleanFilter', () => {
  it('should return boolean values as-is', () => {
    expect(parseBooleanFilter(true)).toBe(true);
    expect(parseBooleanFilter(false)).toBe(false);
  });

  it('should parse "true" string to true', () => {
    expect(parseBooleanFilter('true')).toBe(true);
  });

  it('should parse other strings to false', () => {
    expect(parseBooleanFilter('false')).toBe(false);
    expect(parseBooleanFilter('yes')).toBe(false);
    expect(parseBooleanFilter('')).toBe(false);
  });

  it('should use Boolean() for non-string non-boolean', () => {
    expect(parseBooleanFilter(1)).toBe(true);
    expect(parseBooleanFilter(0)).toBe(false);
    expect(parseBooleanFilter(null)).toBe(false);
  });
});

describe('normalizeStringFilter', () => {
  it('should lowercase string values', () => {
    expect(normalizeStringFilter('PUBLIC')).toBe('public');
    expect(normalizeStringFilter('Hello')).toBe('hello');
  });

  it('should convert non-strings and lowercase', () => {
    expect(normalizeStringFilter(123)).toBe('123');
    expect(normalizeStringFilter(true)).toBe('true');
  });
});

describe('escapeLikeWildcards', () => {
  it('should escape % characters', () => {
    expect(escapeLikeWildcards('100%')).toBe('100\\%');
    expect(escapeLikeWildcards('%match%')).toBe('\\%match\\%');
  });

  it('should escape _ characters', () => {
    expect(escapeLikeWildcards('some_value')).toBe('some\\_value');
    expect(escapeLikeWildcards('_start')).toBe('\\_start');
  });

  it('should escape backslash characters', () => {
    expect(escapeLikeWildcards('path\\to')).toBe('path\\\\to');
    expect(escapeLikeWildcards('\\')).toBe('\\\\');
  });

  it('should return string unchanged when no wildcards', () => {
    expect(escapeLikeWildcards('hello')).toBe('hello');
    expect(escapeLikeWildcards('abc123')).toBe('abc123');
    expect(escapeLikeWildcards('')).toBe('');
  });

  it('should handle mixed wildcards and normal text', () => {
    expect(escapeLikeWildcards('50%_off\\deal')).toBe('50\\%\\_off\\\\deal');
    expect(escapeLikeWildcards('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});
