// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  getIdentity: jest.fn(() => ({ orgId: 'org-1', userId: 'user-1' })),
}));

jest.mock('uuid', () => ({
  v7: () => 'mock-uuid-v7',
}));

import { attachRequestContext } from '../src/api/context-middleware';

function mockReq(): any {
  return { headers: {}, requestId: 'req-from-app' };
}

function mockRes(): any {
  return {};
}

function fakeSseManager(): any {
  return { send: jest.fn() };
}

describe('attachRequestContext', () => {
  it('returns a function that calls next()', () => {
    const middleware = attachRequestContext(fakeSseManager());
    const next = jest.fn();
    middleware(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('attaches a context object to req.context', () => {
    const middleware = attachRequestContext(fakeSseManager());
    const req = mockReq();
    middleware(req, mockRes(), jest.fn());
    expect(req.context).toBeDefined();
    expect(typeof req.context.log).toBe('function');
    expect(req.context.requestId).toBeDefined();
  });

  it('uses requestId already present on req from app-factory', () => {
    const middleware = attachRequestContext(fakeSseManager());
    const req = mockReq();
    req.requestId = 'preset-id';
    middleware(req, mockRes(), jest.fn());
    expect(req.context.requestId).toBe('preset-id');
  });

  it('exposes identity from getIdentity on context', () => {
    const middleware = attachRequestContext(fakeSseManager());
    const req = mockReq();
    middleware(req, mockRes(), jest.fn());
    expect(req.context.identity.orgId).toBe('org-1');
    expect(req.context.identity.userId).toBe('user-1');
  });
});
