// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Anti-forgery test for the `POST /audit/events` ingest.
 *
 * A `service:*` token must NOT be able to forge a PLATFORM-AUTHORITY event
 * (`admin.superadmin.grant`, `org.ownership.transfer`, `user.login`, …) with an
 * attacker-chosen `actorId`. The ingest therefore validates `action` against
 * api-core's REMOTE subset (`isRemoteAuditAction`), not the full platform union:
 * a platform-only action is 400-rejected BEFORE it reaches the append path, while
 * a legitimate remote action (e.g. `pipeline.create`) is accepted.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockCreateEvent = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, message: string) => res.status(status).json({ success: false, message }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));

// requireServiceAuth stub — authenticate as a non-sysadmin service token for org-1.
jest.unstable_mockModule('../src/middleware/index.js', () => ({
  requireServiceAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = req.user ?? { sub: 'service:pipeline', organizationId: 'org-1', isSuperAdmin: false };
    next();
  },
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.unstable_mockModule('../src/helpers/audit-chain.js', () => ({
  verifyAuditChain: jest.fn(),
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_name: string, fn: unknown) => fn,
  requireAdminContext: jest.fn(),
  requireSystemAdmin: jest.fn(),
}));

jest.unstable_mockModule('../src/services/audit-service.js', () => ({
  auditService: { createEvent: (...a: unknown[]) => mockCreateEvent(...a) },
}));

const router = (await import('../src/routes/audit.js')).default as any;

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

/** Drive the express router for a POST /events request with the given body/headers. */
function post(body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = mockRes();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const req: any = {
    method: 'POST',
    url: '/events',
    originalUrl: '/events',
    body,
    headers: lower,
    header: (name: string) => lower[name.toLowerCase()],
    user: { sub: 'service:pipeline', organizationId: 'org-1', isSuperAdmin: false },
  };
  return new Promise((resolve) => {
    // The handler is async; give the microtask queue a beat to settle after the
    // router hands off, then resolve with the captured res.
    router(req, res, () => undefined);
    setImmediate(() => resolve(res));
  });
}

beforeEach(() => {
  mockCreateEvent.mockReset();
  mockCreateEvent.mockResolvedValue(undefined);
});

describe('POST /audit/events — remote-action allow-list', () => {
  it('400-rejects a platform-only action (admin.superadmin.grant) BEFORE the append path', async () => {
    const res = await post({ action: 'admin.superadmin.grant', actorId: 'attacker-controlled' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid or unknown action' }));
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('400-rejects other platform-only actions (org.ownership.transfer, user.login)', async () => {
    for (const action of ['org.ownership.transfer', 'user.login', 'admin.org.delete']) {
      const res = await post({ action, actorId: 'x' });
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('accepts a legitimate remote action (pipeline.create) and appends it', async () => {
    const res = await post({ action: 'pipeline.create', actorId: 'svc-user', targetId: 'pl-1' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pipeline.create',
      actorId: 'svc-user',
      orgId: 'org-1',
    }));
  });
});

describe('POST /audit/events — Idempotency-Key threading', () => {
  it('threads the Idempotency-Key header into the append input', async () => {
    await post({ action: 'pipeline.create', actorId: 'svc-user' }, { 'Idempotency-Key': 'idem-123' });
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'idem-123' }));
  });

  it('passes undefined when the header is absent (unconstrained)', async () => {
    await post({ action: 'pipeline.update', actorId: 'svc-user' });
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: undefined }));
  });
});

describe('POST /audit/events — occurredAt (display-only emission time)', () => {
  it('threads a valid ISO occurredAt into the append input as a Date', async () => {
    const iso = '2026-07-20T12:34:56.000Z';
    const res = await post({ action: 'pipeline.create', actorId: 'svc-user', occurredAt: iso });
    expect(res.status).toHaveBeenCalledWith(200);
    const arg = mockCreateEvent.mock.calls[0][0] as { occurredAt?: Date };
    expect(arg.occurredAt).toBeInstanceOf(Date);
    expect((arg.occurredAt as Date).toISOString()).toBe(iso);
  });

  it('passes occurredAt=undefined when the field is absent (reviewers fall back to createdAt)', async () => {
    const res = await post({ action: 'pipeline.update', actorId: 'svc-user' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: undefined }));
  });

  it('400-rejects a malformed occurredAt BEFORE the append path', async () => {
    const res = await post({ action: 'pipeline.create', actorId: 'svc-user', occurredAt: 'not-a-date' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'occurredAt must be a valid ISO-8601 date string',
    }));
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('400-rejects a non-string occurredAt', async () => {
    const res = await post({ action: 'pipeline.create', actorId: 'svc-user', occurredAt: 1234567890 });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });
});
