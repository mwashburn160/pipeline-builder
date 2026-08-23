// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, afterEach } from '@jest/globals';

import { ValidationError, NetworkError, handleError, ERROR_CODES } from '../src/utils/error-handler.js';

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
});

describe('handleError — standard exit codes', () => {
  afterEach(() => jest.restoreAllMocks());

  // Run handleError and capture the code it exits with (process.exit is mocked to
  // throw a sentinel so the test process survives; console.error is silenced).
  function exitCodeFor(err: unknown, fallback: number = ERROR_CODES.API_REQUEST): number {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`__exit__${c}`); }) as never);
    try {
      handleError(err, fallback as never);
    } catch (e) {
      const m = (e as Error).message.match(/^__exit__(\d+)$/);
      if (m) return Number(m[1]);
    }
    throw new Error('handleError did not exit');
  }

  const axios = (status?: number) => ({ isAxiosError: true, ...(status ? { response: { status } } : {}) });
  const sysErr = (code: string) => Object.assign(new Error(code), { code });

  it('typed CLI errors → their canonical code', () => {
    expect(exitCodeFor(new ValidationError('bad'))).toBe(ERROR_CODES.VALIDATION);          // 2
    expect(exitCodeFor(new NetworkError('down'))).toBe(ERROR_CODES.NETWORK);               // 7
    expect(exitCodeFor(new NetworkError('slow', undefined, undefined, 5000))).toBe(ERROR_CODES.TIMEOUT); // 10
  });

  it('HTTP status → code', () => {
    expect(exitCodeFor(axios(400))).toBe(ERROR_CODES.VALIDATION);      // 2
    expect(exitCodeFor(axios(401))).toBe(ERROR_CODES.AUTHENTICATION);  // 4
    expect(exitCodeFor(axios(403))).toBe(ERROR_CODES.AUTHORIZATION);   // 5
    expect(exitCodeFor(axios(404))).toBe(ERROR_CODES.NOT_FOUND);       // 6
    expect(exitCodeFor(axios(504))).toBe(ERROR_CODES.TIMEOUT);         // 10
    expect(exitCodeFor(axios(500))).toBe(ERROR_CODES.API_REQUEST);    // 3
    expect(exitCodeFor(axios())).toBe(ERROR_CODES.NETWORK);            // 7 (no response = never reached server)
  });

  it('Node system errors → FILE_SYSTEM / NETWORK / TIMEOUT', () => {
    expect(exitCodeFor(sysErr('ENOENT'))).toBe(ERROR_CODES.FILE_SYSTEM);   // 9
    expect(exitCodeFor(sysErr('EACCES'))).toBe(ERROR_CODES.FILE_SYSTEM);   // 9
    expect(exitCodeFor(sysErr('ECONNREFUSED'))).toBe(ERROR_CODES.NETWORK); // 7
    expect(exitCodeFor(sysErr('ETIMEDOUT'))).toBe(ERROR_CODES.TIMEOUT);    // 10
  });

  it('unclassifiable errors fall back to the caller-supplied code', () => {
    expect(exitCodeFor(new Error('boom'), ERROR_CODES.API_REQUEST)).toBe(ERROR_CODES.API_REQUEST); // 3
    expect(exitCodeFor(new Error('boom'), ERROR_CODES.GENERAL)).toBe(ERROR_CODES.GENERAL);         // 1
  });
});
