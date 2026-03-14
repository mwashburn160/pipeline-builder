import { ErrorCode, ErrorCodeStatus, getStatusForErrorCode } from '../src/types/error-codes';

describe('ErrorCode enum', () => {
  it('should have authentication error codes', () => {
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCode.TOKEN_EXPIRED).toBe('TOKEN_EXPIRED');
    expect(ErrorCode.TOKEN_INVALID).toBe('TOKEN_INVALID');
    expect(ErrorCode.TOKEN_MISSING).toBe('TOKEN_MISSING');
  });

  it('should have authorization error codes', () => {
    expect(ErrorCode.INSUFFICIENT_PERMISSIONS).toBe('INSUFFICIENT_PERMISSIONS');
    expect(ErrorCode.ORG_MISMATCH).toBe('ORG_MISMATCH');
  });

  it('should have not-found error codes', () => {
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.ORG_NOT_FOUND).toBe('ORG_NOT_FOUND');
  });

  it('should have validation error codes', () => {
    expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ErrorCode.MISSING_REQUIRED_FIELD).toBe('MISSING_REQUIRED_FIELD');
  });

  it('should have quota/rate-limit error codes', () => {
    expect(ErrorCode.QUOTA_EXCEEDED).toBe('QUOTA_EXCEEDED');
    expect(ErrorCode.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('should have conflict error codes', () => {
    expect(ErrorCode.CONFLICT).toBe('CONFLICT');
    expect(ErrorCode.DUPLICATE_ENTRY).toBe('DUPLICATE_ENTRY');
  });

  it('should have server error codes', () => {
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ErrorCode.DATABASE_ERROR).toBe('DATABASE_ERROR');
  });
});

describe('ErrorCodeStatus', () => {
  it('should map auth codes to 401', () => {
    expect(ErrorCodeStatus[ErrorCode.UNAUTHORIZED]).toBe(401);
    expect(ErrorCodeStatus[ErrorCode.TOKEN_EXPIRED]).toBe(401);
    expect(ErrorCodeStatus[ErrorCode.TOKEN_INVALID]).toBe(401);
    expect(ErrorCodeStatus[ErrorCode.TOKEN_MISSING]).toBe(401);
  });

  it('should map authorization codes to 403', () => {
    expect(ErrorCodeStatus[ErrorCode.INSUFFICIENT_PERMISSIONS]).toBe(403);
    expect(ErrorCodeStatus[ErrorCode.ORG_MISMATCH]).toBe(403);
  });

  it('should map not-found codes to 404', () => {
    expect(ErrorCodeStatus[ErrorCode.NOT_FOUND]).toBe(404);
    expect(ErrorCodeStatus[ErrorCode.ORG_NOT_FOUND]).toBe(404);
  });

  it('should map validation codes to 400', () => {
    expect(ErrorCodeStatus[ErrorCode.VALIDATION_ERROR]).toBe(400);
    expect(ErrorCodeStatus[ErrorCode.MISSING_REQUIRED_FIELD]).toBe(400);
  });

  it('should map quota codes to 429', () => {
    expect(ErrorCodeStatus[ErrorCode.QUOTA_EXCEEDED]).toBe(429);
    expect(ErrorCodeStatus[ErrorCode.RATE_LIMIT_EXCEEDED]).toBe(429);
  });

  it('should map conflict codes to 409', () => {
    expect(ErrorCodeStatus[ErrorCode.CONFLICT]).toBe(409);
    expect(ErrorCodeStatus[ErrorCode.DUPLICATE_ENTRY]).toBe(409);
  });

  it('should map server errors to 500', () => {
    expect(ErrorCodeStatus[ErrorCode.INTERNAL_ERROR]).toBe(500);
    expect(ErrorCodeStatus[ErrorCode.DATABASE_ERROR]).toBe(500);
  });

  it('should have a mapping for every ErrorCode', () => {
    const codes = Object.values(ErrorCode);
    for (const code of codes) {
      expect(ErrorCodeStatus[code]).toBeDefined();
    }
  });
});

describe('getStatusForErrorCode', () => {
  it('should return correct status for known codes', () => {
    expect(getStatusForErrorCode(ErrorCode.UNAUTHORIZED)).toBe(401);
    expect(getStatusForErrorCode(ErrorCode.NOT_FOUND)).toBe(404);
    expect(getStatusForErrorCode(ErrorCode.QUOTA_EXCEEDED)).toBe(429);
    expect(getStatusForErrorCode(ErrorCode.INTERNAL_ERROR)).toBe(500);
  });

  it('should default to 500 for unknown codes', () => {
    expect(getStatusForErrorCode('UNKNOWN_CODE' as ErrorCode)).toBe(500);
  });
});
