import {
  getParam,
  getRequiredParam,
  getParams,
  getOrgId,
  getAuthHeader,
  parseQueryBoolean,
  parseQueryInt,
  parseQueryString,
} from '../src/utils/params';

// ---------------------------------------------------------------------------
// Mock Express Request
// ---------------------------------------------------------------------------
function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    headers: {},
    query: {},
    user: undefined,
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getParam', () => {
  it('should return string value', () => {
    expect(getParam({ id: 'abc' }, 'id')).toBe('abc');
  });

  it('should return first element from array', () => {
    expect(getParam({ id: ['first', 'second'] }, 'id')).toBe('first');
  });

  it('should return undefined for missing key', () => {
    expect(getParam({}, 'id')).toBeUndefined();
  });
});

describe('getRequiredParam', () => {
  it('should return string value', () => {
    expect(getRequiredParam({ id: 'abc' }, 'id')).toBe('abc');
  });

  it('should throw for missing parameter', () => {
    expect(() => getRequiredParam({}, 'id')).toThrow('Missing required parameter: id');
  });

  it('should throw for empty string', () => {
    expect(() => getRequiredParam({ id: '' }, 'id')).toThrow('Missing required parameter: id');
  });

  it('should return first element from array', () => {
    expect(getRequiredParam({ id: ['val'] }, 'id')).toBe('val');
  });
});

describe('getParams', () => {
  it('should extract multiple params', () => {
    const params = { orgId: 'org-1', pluginId: 'plug-1' };
    const result = getParams(params, ['orgId', 'pluginId']);
    expect(result).toEqual({ orgId: 'org-1', pluginId: 'plug-1' });
  });

  it('should return undefined for missing params', () => {
    const result = getParams({}, ['orgId']);
    expect(result.orgId).toBeUndefined();
  });
});

describe('getOrgId', () => {
  it('should return orgId from route params', () => {
    const req = mockReq({ params: { orgId: 'org-from-params' } });
    expect(getOrgId(req)).toBe('org-from-params');
  });

  it('should return orgId from x-org-id header', () => {
    const req = mockReq({ headers: { 'x-org-id': 'org-from-header' } });
    expect(getOrgId(req)).toBe('org-from-header');
  });

  it('should return orgId from authenticated user', () => {
    const req = mockReq({ user: { organizationId: 'org-from-user' } });
    expect(getOrgId(req)).toBe('org-from-user');
  });

  it('should prefer params over header and user', () => {
    const req = mockReq({
      params: { orgId: 'from-params' },
      headers: { 'x-org-id': 'from-header' },
      user: { organizationId: 'from-user' },
    });
    expect(getOrgId(req)).toBe('from-params');
  });

  it('should prefer header over user', () => {
    const req = mockReq({
      headers: { 'x-org-id': 'from-header' },
      user: { organizationId: 'from-user' },
    });
    expect(getOrgId(req)).toBe('from-header');
  });

  it('should return undefined when no org available', () => {
    const req = mockReq();
    expect(getOrgId(req)).toBeUndefined();
  });

  it('should trim whitespace from header org id', () => {
    const req = mockReq({ headers: { 'x-org-id': '  org-1  ' } });
    expect(getOrgId(req)).toBe('org-1');
  });
});

describe('getAuthHeader', () => {
  it('should return authorization header', () => {
    const req = mockReq({ headers: { authorization: 'Bearer token123' } });
    expect(getAuthHeader(req)).toBe('Bearer token123');
  });

  it('should return empty string when missing', () => {
    const req = mockReq();
    expect(getAuthHeader(req)).toBe('');
  });
});

describe('parseQueryBoolean', () => {
  it('should parse "true" string', () => {
    expect(parseQueryBoolean('true')).toBe(true);
    expect(parseQueryBoolean('TRUE')).toBe(true);
    expect(parseQueryBoolean('True')).toBe(true);
  });

  it('should parse "false" string', () => {
    expect(parseQueryBoolean('false')).toBe(false);
    expect(parseQueryBoolean('FALSE')).toBe(false);
  });

  it('should parse "1" and "0"', () => {
    expect(parseQueryBoolean('1')).toBe(true);
    expect(parseQueryBoolean('0')).toBe(false);
  });

  it('should return boolean values as-is', () => {
    expect(parseQueryBoolean(true)).toBe(true);
    expect(parseQueryBoolean(false)).toBe(false);
  });

  it('should return undefined for empty/null/undefined', () => {
    expect(parseQueryBoolean(undefined)).toBeUndefined();
    expect(parseQueryBoolean(null)).toBeUndefined();
    expect(parseQueryBoolean('')).toBeUndefined();
  });

  it('should return undefined for invalid strings', () => {
    expect(parseQueryBoolean('yes')).toBeUndefined();
    expect(parseQueryBoolean('no')).toBeUndefined();
  });
});

describe('parseQueryInt', () => {
  it('should parse valid integers', () => {
    expect(parseQueryInt('10', 5)).toBe(10);
    expect(parseQueryInt('0', 5)).toBe(0);
    expect(parseQueryInt('-3', 5)).toBe(-3);
  });

  it('should return default for undefined/null/empty', () => {
    expect(parseQueryInt(undefined, 10)).toBe(10);
    expect(parseQueryInt(null, 10)).toBe(10);
    expect(parseQueryInt('', 10)).toBe(10);
  });

  it('should return default for NaN', () => {
    expect(parseQueryInt('abc', 10)).toBe(10);
    expect(parseQueryInt('not-a-number', 0)).toBe(0);
  });

  it('should parse integer part of float string', () => {
    expect(parseQueryInt('3.7', 0)).toBe(3);
  });
});

describe('parseQueryString', () => {
  it('should return string value', () => {
    expect(parseQueryString('hello')).toBe('hello');
  });

  it('should convert non-string values to string', () => {
    expect(parseQueryString(123)).toBe('123');
    expect(parseQueryString(true)).toBe('true');
  });

  it('should return undefined for empty/null/undefined', () => {
    expect(parseQueryString(undefined)).toBeUndefined();
    expect(parseQueryString(null)).toBeUndefined();
    expect(parseQueryString('')).toBeUndefined();
  });
});
