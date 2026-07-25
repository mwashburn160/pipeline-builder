// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: {
    getAny: () => ({ serviceName: 'test-service' }),
  },
}));

const { metricsMiddleware, metricsHandler } = await import('../src/api/metrics.js');

function mockReq(path = '/api/things', method = 'GET'): any {
  return { path, method, headers: {}, baseUrl: '', route: undefined };
}

function mockRes(): any {
  const listeners: Record<string, () => void> = {};
  const res: any = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, string>,
  };
  res.on = jest.fn((event: string, cb: () => void) => { listeners[event] = cb; });
  res.set = jest.fn((name: string, value: string) => { res.headers[name] = value; });
  res.end = jest.fn((data?: string) => { res.body = data ?? ''; });
  res.emit = (event: string) => listeners[event]?.();
  return res;
}

describe('metricsMiddleware', () => {
  it('no longer special-cases /metrics or /health (dead branch removed)', () => {
    // /metrics and /health are registered in app-factory BEFORE this middleware
    // and terminate the response, so they never reach it. The former in-handler
    // skip was dead code and was removed — the middleware now treats these paths
    // like any other (registers a finish listener) if it ever does see them.
    const middleware = metricsMiddleware();
    for (const path of ['/metrics', '/health']) {
      const req = mockReq(path);
      const res = mockRes();
      const next = jest.fn();
      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
    }
  });

  it('registers a finish listener for normal paths', () => {
    const middleware = metricsMiddleware();
    const req = mockReq('/api/items');
    const res = mockRes();
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  it('records metrics on finish without throwing', () => {
    const middleware = metricsMiddleware();
    const req = mockReq('/api/items');
    const res = mockRes();
    middleware(req, res, jest.fn());
    expect(() => res.emit('finish')).not.toThrow();
  });
});

describe('metricsHandler', () => {
  it('returns a function', () => {
    expect(typeof metricsHandler()).toBe('function');
  });

  it('writes prometheus content-type and metrics body', async () => {
    const handler = metricsHandler();
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.set).toHaveBeenCalledWith('Content-Type', expect.any(String));
    expect(res.end).toHaveBeenCalled();
  });
});
