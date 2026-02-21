import { ValidationError, NetworkError } from '../src/utils/error.handler';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('should create error with message', () => {
    const err = new ValidationError('Invalid value');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('Invalid value');
  });

  it('should store all optional fields', () => {
    const err = new ValidationError('bad field', 'email', 'not-email', 'format', 'user@example.com');
    expect(err.field).toBe('email');
    expect(err.value).toBe('not-email');
    expect(err.rule).toBe('format');
    expect(err.expected).toBe('user@example.com');
  });

  it('should leave optional fields undefined when not provided', () => {
    const err = new ValidationError('oops');
    expect(err.field).toBeUndefined();
    expect(err.value).toBeUndefined();
    expect(err.rule).toBeUndefined();
    expect(err.expected).toBeUndefined();
  });

  describe('toDetails', () => {
    it('should return details object', () => {
      const err = new ValidationError('bad', 'name', 123, 'min', '>0');
      const details = err.toDetails();
      expect(details).toEqual({
        field: 'name',
        value: 123,
        rule: 'min',
        expected: '>0',
      });
    });

    it('should return undefined fields when not set', () => {
      const err = new ValidationError('bad');
      const details = err.toDetails();
      expect(details.field).toBeUndefined();
      expect(details.value).toBeUndefined();
    });
  });
});

describe('NetworkError', () => {
  it('should create error with message', () => {
    const err = new NetworkError('Connection refused');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NetworkError');
    expect(err.message).toBe('Connection refused');
  });

  it('should store all optional fields', () => {
    const cause = new Error('ECONNREFUSED');
    const err = new NetworkError('timeout', 'https://api.example.com', cause, 5000, true, false);
    expect(err.url).toBe('https://api.example.com');
    expect(err.cause).toBe(cause);
    expect(err.timeout).toBe(5000);
    expect(err.requestMade).toBe(true);
    expect(err.responseReceived).toBe(false);
  });

  it('should default requestMade to true and responseReceived to false', () => {
    const err = new NetworkError('error');
    expect(err.requestMade).toBe(true);
    expect(err.responseReceived).toBe(false);
  });

  describe('toDetails', () => {
    it('should return details object with all fields', () => {
      const cause = new Error('DNS failed');
      const err = new NetworkError('dns', 'https://example.com', cause, 3000, false, false);
      const details = err.toDetails();
      expect(details).toEqual({
        url: 'https://example.com',
        timeout: 3000,
        requestMade: false,
        responseReceived: false,
        cause,
      });
    });

    it('should return undefined for unset optional fields', () => {
      const err = new NetworkError('failed');
      const details = err.toDetails();
      expect(details.url).toBeUndefined();
      expect(details.timeout).toBeUndefined();
      expect(details.cause).toBeUndefined();
    });
  });
});
