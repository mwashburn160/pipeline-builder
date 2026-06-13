// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import type { Request, Response } from 'express';

const { readinessGuard, isReady, setReady } = await import('../src/api/readiness.js');

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
  };
  return res as unknown as Response & { statusCode: number; headers: Record<string, string> };
}

describe('readiness state', () => {
  afterAll(() => setReady(true)); // restore default so other suites aren't gated

  it('defaults to ready (so unstarted apps / route tests are never blocked)', () => {
    expect(isReady()).toBe(true);
  });

  it('setReady flips the flag', () => {
    setReady(false);
    expect(isReady()).toBe(false);
    setReady(true);
    expect(isReady()).toBe(true);
  });
});

describe('readinessGuard', () => {
  const guard = readinessGuard();

  beforeEach(() => setReady(true));
  afterAll(() => setReady(true));

  it('calls next() for business routes when ready', () => {
    const next = jest.fn();
    const res = mockRes();
    guard({ path: '/plugins' } as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it('503s business routes when NotReady, with Retry-After', () => {
    setReady(false);
    const next = jest.fn();
    const res = mockRes();
    guard({ path: '/plugins' } as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('5');
  });

  it.each([
    '/health', '/ready', '/metrics', '/warmup',
    '/docs', '/docs/openapi.json', '/logs/abc-123',
  ])('always lets infra endpoint %s through even when NotReady', (path) => {
    setReady(false);
    const next = jest.fn();
    const res = mockRes();
    guard({ path } as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it('honors a custom (narrower) allowlist — e.g. platform gates its /logs business route', () => {
    // platform serves a tenant log API at /logs, so it passes an infra-only
    // allowlist; /logs must be gated while NotReady, unlike the default list.
    const narrow = readinessGuard(['/health', '/ready', '/metrics']);
    setReady(false);

    const res503 = mockRes();
    const next503 = jest.fn();
    narrow({ path: '/logs' } as Request, res503, next503);
    expect(next503).not.toHaveBeenCalled();
    expect(res503.statusCode).toBe(503);

    // …while its real infra endpoints still pass through.
    const resOk = mockRes();
    const nextOk = jest.fn();
    narrow({ path: '/metrics' } as Request, resOk, nextOk);
    expect(nextOk).toHaveBeenCalledTimes(1);
    expect(resOk.statusCode).toBe(0);
  });
});
