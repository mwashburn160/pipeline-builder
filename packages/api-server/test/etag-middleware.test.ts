// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { etagMiddleware } from '../src/api/etag-middleware';

function mockReq(method = 'GET', headers: Record<string, unknown> = {}): any {
  return { method, headers };
}

function mockRes(): any {
  const res: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    ended: false,
    endedWith: undefined as unknown,
  };
  res.setHeader = jest.fn((name: string, value: string) => { res.headers[name] = value; });
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.end = jest.fn((data?: unknown) => { res.ended = true; res.endedWith = data; return res; });
  res.json = jest.fn((body: unknown) => { res.endedWith = body; return res; });
  return res;
}

describe('etagMiddleware', () => {
  it('skips non-GET requests', () => {
    const middleware = etagMiddleware();
    const req = mockReq('POST');
    const res = mockRes();
    const originalJson = res.json;
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.json).toBe(originalJson);
  });

  it('overrides res.json for GET requests', () => {
    const middleware = etagMiddleware();
    const req = mockReq('GET');
    const res = mockRes();
    const originalJson = res.json;
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.json).not.toBe(originalJson);
  });

  it('sets ETag header when res.json is called', () => {
    const middleware = etagMiddleware();
    const req = mockReq('GET');
    const res = mockRes();
    middleware(req, res, jest.fn());
    res.json({ hello: 'world' });
    expect(res.setHeader).toHaveBeenCalledWith('ETag', expect.stringMatching(/^W\/"[a-f0-9]{16}"$/));
  });

  it('returns 304 when If-None-Match matches', () => {
    const middleware = etagMiddleware();
    // First, compute the etag for body { x: 1 }
    const probe = mockRes();
    middleware(mockReq('GET'), probe, jest.fn());
    probe.json({ x: 1 });
    const etag = probe.headers.ETag;

    // Now, second request with matching If-None-Match
    const req = mockReq('GET', { 'if-none-match': etag });
    const res = mockRes();
    middleware(req, res, jest.fn());
    res.json({ x: 1 });
    expect(res.status).toHaveBeenCalledWith(304);
  });

  it('sends body when If-None-Match does not match', () => {
    const middleware = etagMiddleware();
    const req = mockReq('GET', { 'if-none-match': 'W/"different"' });
    const res = mockRes();
    middleware(req, res, jest.fn());
    res.json({ value: 42 });
    expect(res.status).not.toHaveBeenCalledWith(304);
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ value: 42 }));
  });

  it('sets Content-Type to application/json on full response', () => {
    const middleware = etagMiddleware();
    const req = mockReq('GET');
    const res = mockRes();
    middleware(req, res, jest.fn());
    res.json({ a: 'b' });
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
  });
});
