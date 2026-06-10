// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level tests for the observability controllers.
 *
 * Mocks the prom/loki client modules and asserts:
 *  - sysadmin gate (403 for non-sysadmin)
 *  - 400 for unknown catalog keys / wrong-source key (Prom key on /logs etc.)
 *  - 500 on upstream 4xx (catalog bug, not user input)
 *  - 502 on upstream unreachable
 *  - 200 + correct envelope shape for instant + range queries
 *  - templated Loki params reach the client unchanged (sanitization is
 *    in catalog.substituteVars, separately tested)
 */

import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
jest.unstable_mockModule('@pipeline-builder/api-core', () => {
  const actual = jest.requireActual('@pipeline-builder/api-core');
  return {
    ...actual,
    // sendError + sendSuccess are real (so res.json shape matches prod)
  };
});

// Mocks for the upstream clients
const mockPromQuery = jest.fn();
const mockPromQueryRange = jest.fn();
const mockLokiStreams = jest.fn();
const mockLokiMatrix = jest.fn();

jest.unstable_mockModule('../src/observability/prometheus-client.js', () => ({
  query: (...a: unknown[]) => mockPromQuery(...a),
  queryRange: (...a: unknown[]) => mockPromQueryRange(...a),
}));
jest.unstable_mockModule('../src/observability/loki-client.js', () => ({
  queryStreams: (...a: unknown[]) => mockLokiStreams(...a),
  queryMatrix: (...a: unknown[]) => mockLokiMatrix(...a),
}));

// Mock the controller-helper functions we depend on. The controller uses
// requireAuth (gate) + isSystemAdmin (predicate) — per-org $ORG substitution
// scopes data; sysadmin sees all orgs via regex wildcard.
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_desc: string, fn: any) => fn,
  requireAuth: jest.fn(),
  isSystemAdmin: jest.fn(),
}));

const { requireAuth, isSystemAdmin } = await import('../src/helpers/controller-helper.js');
const { observabilityQuery, observabilityLogs } = await import('../src/observability/controller.js');

import type { Request, Response } from 'express';

const mockRequireAuth = requireAuth as jest.MockedFunction<typeof requireAuth>;
const mockIsSystemAdmin = isSystemAdmin as jest.MockedFunction<typeof isSystemAdmin>;

function makeRes(): Response & { _status: number; _body: unknown } {
  const r: any = {
    _status: 200,
    _body: undefined,
    status(code: number) { this._status = code; return this; },
    json(b: unknown) { this._body = b; return this; },
    setHeader: jest.fn(),
  };
  return r as Response & { _status: number; _body: unknown };
}

function makeReq(query: Record<string, string> = {}): Request {
  return { query } as unknown as Request;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: authenticated + sysadmin (broadest case so test setup is short)
  mockRequireAuth.mockReturnValue(true);
  mockIsSystemAdmin.mockReturnValue(true);
});

describe('observabilityQuery', () => {
  it('returns 401 when caller is not authenticated', async () => {
    mockRequireAuth.mockReturnValue(false);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }), res);
    expect(mockRequireAuth).toHaveBeenCalled();
    // requireAuth sends the 401 itself; controller bails without firing a query
    expect(mockPromQuery).not.toHaveBeenCalled();
    expect(mockPromQueryRange).not.toHaveBeenCalled();
  });

  it('proceeds for org admins (non-sysadmin) — relies on $ORG scoping', async () => {
    mockIsSystemAdmin.mockReturnValue(false);
    mockPromQueryRange.mockResolvedValue([]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }), res);
    expect(res._status).toBe(200);
    expect(mockPromQueryRange).toHaveBeenCalled();
  });

  it('returns 400 for an unknown catalog key', async () => {
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'definitely_not_a_real_query', range: '1h' }), res);
    expect(res._status).toBe(400);
    expect((res._body as { message?: string }).message).toMatch(/Unknown observability query key/);
  });

  it('delegates a Loki range key on /query to loki.queryMatrix (same envelope)', async () => {
    // /query now accepts loki-range keys so the frontend can stay endpoint-
    // agnostic — both prometheus-range and loki-range return {series, range, step}.
    mockLokiMatrix.mockResolvedValue([{ labels: { event: 'login' }, points: [] }]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'audit_events_per_hour_by_event', range: '1h' }), res);
    expect(res._status).toBe(200);
    expect(mockLokiMatrix).toHaveBeenCalledTimes(1);
    expect(mockPromQueryRange).not.toHaveBeenCalled();
    const body = res._body as { success: boolean; data: { series: unknown[]; range: string } };
    expect(body.success).toBe(true);
    expect(body.data.range).toBe('1h');
    expect(body.data.series).toHaveLength(1);
  });

  it('returns 200 + samples for an instant query', async () => {
    mockPromQuery.mockResolvedValue([
      { time: 1700000000, value: '42', labels: {} },
    ]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_total_24h', range: '1h' }), res);
    expect(res._status).toBe(200);
    const body = res._body as { success: boolean; data: { samples: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.samples).toHaveLength(1);
    expect(mockPromQuery).toHaveBeenCalledTimes(1);
  });

  it('returns 200 + series for a range query, with step auto-scaled', async () => {
    mockPromQueryRange.mockResolvedValue([
      { labels: { status: 'success' }, values: [{ time: 1700000000, value: '1' }] },
    ]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '6h' }), res);
    expect(res._status).toBe(200);
    const body = res._body as { data: { series: unknown[]; step: string; range: string } };
    expect(body.data.step).toBe('60s'); // 6h → 1m
    expect(body.data.range).toBe('6h');
    expect(body.data.series).toHaveLength(1);
  });

  it('defaults to 1h range when none specified', async () => {
    mockPromQueryRange.mockResolvedValue([]);
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min' }), res);
    expect(res._status).toBe(200);
    const body = res._body as { data: { step: string } };
    expect(body.data.step).toBe('15s'); // 1h → 15s
  });

  it('returns 500 on upstream 4xx (catalog bug, not user input)', async () => {
    mockPromQueryRange.mockRejectedValue({ kind: 'upstream-4xx', status: 422, message: 'syntax error' });
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }), res);
    expect(res._status).toBe(500);
  });

  it('returns 502 on upstream unreachable', async () => {
    mockPromQueryRange.mockRejectedValue({ kind: 'unreachable', message: 'ECONNREFUSED' });
    const res = makeRes();
    await observabilityQuery(makeReq({ key: 'plugin_builds_per_min', range: '1h' }), res);
    expect(res._status).toBe(502);
  });
});

describe('observabilityLogs', () => {
  it('returns 401 when caller is not authenticated', async () => {
    mockRequireAuth.mockReturnValue(false);
    const res = makeRes();
    await observabilityLogs(makeReq({ key: 'audit_recent_events', range: '1h' }), res);
    expect(mockLokiStreams).not.toHaveBeenCalled();
  });

  it('returns 400 for a Prometheus key on the Loki endpoint', async () => {
    const res = makeRes();
    await observabilityLogs(makeReq({ key: 'plugin_builds_per_min', range: '1h' }), res);
    expect(res._status).toBe(400);
    expect((res._body as { message?: string }).message).toMatch(/not a Loki query/);
  });

  it('returns streams-shaped response for raw-stream queries', async () => {
    mockLokiStreams.mockResolvedValue([
      { time: '1700000000000000000', line: 'audit', labels: { event: 'registry.tag.copy' } },
    ]);
    const res = makeRes();
    await observabilityLogs(makeReq({ key: 'audit_recent_events', range: '1h' }), res);
    expect(res._status).toBe(200);
    const body = res._body as { data: { entries: unknown[] } };
    expect(body.data.entries).toHaveLength(1);
    expect(mockLokiStreams).toHaveBeenCalledTimes(1);
    expect(mockLokiMatrix).not.toHaveBeenCalled();
  });

  it('returns matrix-shaped response for aggregate queries', async () => {
    mockLokiMatrix.mockResolvedValue([
      { labels: { event: 'registry.tag.copy' }, values: [{ time: 1700000000, value: '5' }] },
    ]);
    const res = makeRes();
    await observabilityLogs(makeReq({ key: 'audit_events_per_hour_by_event', range: '6h' }), res);
    expect(res._status).toBe(200);
    const body = res._body as { data: { series: unknown[]; step: string } };
    expect(body.data.series).toHaveLength(1);
    expect(body.data.step).toBe('60s');
    expect(mockLokiMatrix).toHaveBeenCalledTimes(1);
  });

  it('passes event/actor params through to the catalog substitution', async () => {
    mockLokiStreams.mockResolvedValue([]);
    const res = makeRes();
    await observabilityLogs(
      makeReq({ key: 'audit_recent_events', range: '1h', event: 'registry.tag.copy', actor: 'user@example.com' }),
      res,
    );
    expect(res._status).toBe(200);
    // The first arg to queryStreams is the substituted LogQL — assert it
    // includes both filters baked in (the actual substitution logic is
    // covered separately in observability-catalog.test.ts).
    const logQL = mockLokiStreams.mock.calls[0][0] as string;
    expect(logQL).toContain('event="registry.tag.copy"');
    expect(logQL).toContain('actor="user@example.com"');
  });

  it('clamps limit to 500 when caller asks for more', async () => {
    mockLokiStreams.mockResolvedValue([]);
    const res = makeRes();
    await observabilityLogs(makeReq({ key: 'audit_recent_events', range: '1h', limit: '99999' }), res);
    expect(mockLokiStreams.mock.calls[0][3]).toBe(500);
  });

  it('defaults limit to 50 when missing', async () => {
    mockLokiStreams.mockResolvedValue([]);
    const res = makeRes();
    await observabilityLogs(makeReq({ key: 'audit_recent_events', range: '1h' }), res);
    expect(mockLokiStreams.mock.calls[0][3]).toBe(50);
  });

  it('returns 502 on Loki unreachable', async () => {
    mockLokiStreams.mockRejectedValue({ kind: 'unreachable', message: 'ECONNREFUSED' });
    const res = makeRes();
    await observabilityLogs(makeReq({ key: 'audit_recent_events', range: '1h' }), res);
    expect(res._status).toBe(502);
  });
});
