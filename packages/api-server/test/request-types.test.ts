// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const mockGetIdentity = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  getIdentity: mockGetIdentity,
  createLogger: () => ({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: jest.fn(),
  }),
}));

jest.mock('uuid', () => ({
  v7: () => 'generated-uuid',
}));

import { createRequestContext } from '../src/api/request-types';

function mockReq(overrides: Record<string, unknown> = {}): any {
  return { headers: {}, ...overrides };
}

function fakeSse(): any {
  return { send: jest.fn() };
}

describe('createRequestContext', () => {
  beforeEach(() => {
    mockGetIdentity.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
  });

  it('returns context with identity from getIdentity', () => {
    mockGetIdentity.mockReturnValue({ orgId: 'org-x', userId: 'u1' });
    const ctx = createRequestContext(mockReq(), fakeSse());
    expect(ctx.identity).toEqual({ orgId: 'org-x', userId: 'u1' });
  });

  it('prefers req.requestId over identity.requestId', () => {
    mockGetIdentity.mockReturnValue({ requestId: 'identity-id' });
    const ctx = createRequestContext(mockReq({ requestId: 'app-id' }), fakeSse());
    expect(ctx.requestId).toBe('app-id');
  });

  it('falls back to identity.requestId when req.requestId is absent', () => {
    mockGetIdentity.mockReturnValue({ requestId: 'identity-id' });
    const ctx = createRequestContext(mockReq(), fakeSse());
    expect(ctx.requestId).toBe('identity-id');
  });

  it('generates a uuid when neither requestId is present', () => {
    mockGetIdentity.mockReturnValue({});
    const ctx = createRequestContext(mockReq(), fakeSse());
    expect(ctx.requestId).toBe('generated-uuid');
  });

  it('log function dispatches to winston error for ERROR type', () => {
    mockGetIdentity.mockReturnValue({});
    const sse = fakeSse();
    const ctx = createRequestContext(mockReq(), sse);
    ctx.log('ERROR', 'failure', { x: 1 });
    expect(mockLoggerError).toHaveBeenCalledWith('failure', expect.any(Object));
    expect(sse.send).toHaveBeenCalledWith('generated-uuid', 'ERROR', 'failure', { x: 1 });
  });

  it('log function dispatches to winston warn for WARN type', () => {
    mockGetIdentity.mockReturnValue({});
    const sse = fakeSse();
    const ctx = createRequestContext(mockReq(), sse);
    ctx.log('WARN', 'careful');
    expect(mockLoggerWarn).toHaveBeenCalledWith('careful', expect.any(Object));
  });

  it('log function dispatches to winston info for INFO type', () => {
    mockGetIdentity.mockReturnValue({});
    const sse = fakeSse();
    const ctx = createRequestContext(mockReq(), sse);
    ctx.log('INFO', 'hello');
    expect(mockLoggerInfo).toHaveBeenCalledWith('hello', expect.any(Object));
  });
});
