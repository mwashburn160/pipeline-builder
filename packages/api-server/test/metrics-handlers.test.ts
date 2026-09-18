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

describe('secret_rotation_previous_set gauge', () => {

  async function scrape(): Promise<string> {
    const res = mockRes();
    await metricsHandler()(mockReq(), res);
    return res.body;
  }

  it('reports 0 for SERVICE_SIGNING_KEY outside a rotation and 1 while the retiring key is still published', async () => {
    // #14: the internal-token overlap is not an env value — it is the retiring
    // PUBLIC key still sitting in the shared bundle, so the drill is a bundle
    // rewrite rather than a `*_PREVIOUS` assignment.
    const { installTestServiceKeys } = await import('@pipeline-builder/api-core/lib/testing/service-tokens.js');
    const keys = installTestServiceKeys(['test-service', 'test-service-next']);
    try {
      keys.becomeService('test-service');
      keys.publish(['test-service']);
      expect(await scrape()).toMatch(/secret_rotation_previous_set\{secret="SERVICE_SIGNING_KEY",service="test-service"\} 0/);
      keys.publishKeys({ 'test-service': [keys.keys.get('test-service')!, keys.keys.get('test-service-next')!] });
      expect(await scrape()).toMatch(/secret_rotation_previous_set\{secret="SERVICE_SIGNING_KEY",service="test-service"\} 1/);
    } finally {
      keys.uninstall();
    }
  });

  it('exports probes registered by the service', async () => {
    const { registerPreviousSecretProbe } = await import('@pipeline-builder/api-core');
    registerPreviousSecretProbe('REGISTRY_TOKEN_CERTIFICATE', () => true);
    expect(await scrape()).toMatch(/secret_rotation_previous_set\{secret="REGISTRY_TOKEN_CERTIFICATE",service="test-service"\} 1/);
  });
});
