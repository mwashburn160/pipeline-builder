// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import type { Request, Response } from 'express';
import {
  checkVisibilityWriteAccess,
  checkWriteAccess,
  rejectForbiddenBulkRows,
  requireVisibilityWriteAccess,
  resolveVisibility,
  type WriteAccess,
} from '../src/helpers/access-helpers.js';

function createMockReq(user?: Partial<Request['user']>): Request {
  return { user: user as Request['user'] } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

// Sysadmin authority is granted by the user-level `isSuperAdmin` flag;
// membership in the "system" org no longer confers it.
const ADMIN = createMockReq({ role: 'admin', organizationId: 'org-ops', organizationName: 'ops', isSuperAdmin: true });

// ---------------------------------------------------------------------------
// The three-rung `visibility` ladder (private / org / public)
// ---------------------------------------------------------------------------

const AUTHOR = createMockReq({ role: 'member', organizationId: 'org-1', organizationName: 'acme', permissions: ['pipelines:write'] });
const PUBLISHER = createMockReq({ role: 'member', organizationId: 'org-1', organizationName: 'acme', permissions: ['pipelines:write', 'pipelines:publish'] });

describe('requireVisibilityWriteAccess', () => {
  it('lets any org member write an `org` template', () => {
    const res = createMockRes();
    expect(requireVisibilityWriteAccess(AUTHOR, res, { visibility: 'org', createdBy: 'someone-else' }, 'user-1', 'pipelines:publish')).toBe(true);
    expect(res._status).toBe(0);
  });

  it('lets the author write their own private draft', () => {
    const res = createMockRes();
    expect(requireVisibilityWriteAccess(AUTHOR, res, { visibility: 'private', createdBy: 'user-1' }, 'user-1', 'pipelines:publish')).toBe(true);
    expect(res._status).toBe(0);
  });

  it("403s a colleague on someone else's private draft", () => {
    const res = createMockRes();
    expect(requireVisibilityWriteAccess(AUTHOR, res, { visibility: 'private', createdBy: 'user-2' }, 'user-1', 'pipelines:publish')).toBe(false);
    expect(res._status).toBe(403);
  });

  it('fails closed when the caller has no user id', () => {
    // An empty userId must never match an empty `createdBy` and hand over a draft.
    const res = createMockRes();
    expect(requireVisibilityWriteAccess(AUTHOR, res, { visibility: 'private', createdBy: '' }, '', 'pipelines:publish')).toBe(false);
    expect(res._status).toBe(403);
  });

  it('403s a non-publisher on a public template', () => {
    const res = createMockRes();
    expect(requireVisibilityWriteAccess(AUTHOR, res, { visibility: 'public', createdBy: 'user-1' }, 'user-1', 'pipelines:publish')).toBe(false);
    expect(res._status).toBe(403);
  });

  it('lets a publisher write a public template they did not author', () => {
    const res = createMockRes();
    expect(requireVisibilityWriteAccess(PUBLISHER, res, { visibility: 'public', createdBy: 'user-2' }, 'user-1', 'pipelines:publish')).toBe(true);
    expect(res._status).toBe(0);
  });

  it('lets a sysadmin write any rung', () => {
    for (const visibility of ['private', 'org', 'public']) {
      const res = createMockRes();
      expect(requireVisibilityWriteAccess(ADMIN, res, { visibility, createdBy: 'user-2' }, 'admin-1', 'pipelines:publish')).toBe(true);
      expect(res._status).toBe(0);
    }
  });
});

describe('checkWriteAccess (the request-free, job-path gate)', () => {
  const MEMBER: WriteAccess = { isSystemAdmin: false, canPublish: false };
  const PUBLISHES: WriteAccess = { isSystemAdmin: false, canPublish: true };
  const SYSADMIN: WriteAccess = { isSystemAdmin: true, canPublish: false };

  it.each([
    ['org row, any member', { visibility: 'org', createdBy: 'user-2' }, 'user-1', MEMBER, 'ok'],
    ['own private draft', { visibility: 'private', createdBy: 'user-1' }, 'user-1', MEMBER, 'ok'],
    ["someone else's private draft", { visibility: 'private', createdBy: 'user-2' }, 'user-1', MEMBER, 'not-author'],
    ['empty userId vs empty author (fails closed)', { visibility: 'private', createdBy: '' }, '', MEMBER, 'not-author'],
    ['null author vs empty userId (fails closed)', { visibility: 'private', createdBy: null }, '', MEMBER, 'not-author'],
    ['public row without publish', { visibility: 'public', createdBy: 'user-1' }, 'user-1', MEMBER, 'needs-publish'],
    ['public row with publish', { visibility: 'public', createdBy: 'user-2' }, 'user-1', PUBLISHES, 'ok'],
    ['private row, sysadmin', { visibility: 'private', createdBy: 'user-2' }, 'admin-1', SYSADMIN, 'ok'],
    ['public row, sysadmin without publish', { visibility: 'public', createdBy: 'user-2' }, 'admin-1', SYSADMIN, 'ok'],
    ['null visibility falls through to ok', { visibility: null, createdBy: 'user-2' }, 'user-1', MEMBER, 'ok'],
  ])('%s', (_label, resource, userId, access, expected) => {
    expect(checkWriteAccess(resource, userId as string, access as WriteAccess)).toBe(expected);
  });

  it('agrees rung for rung with the request-bound gate', () => {
    // The whole point of the shared implementation: the job path (a BullMQ
    // deploy worker) and the request path must never disagree, because a
    // divergence is a tenancy bug.
    const rows = [
      { visibility: 'private', createdBy: 'user-1' },
      { visibility: 'private', createdBy: 'user-2' },
      { visibility: 'org', createdBy: 'user-2' },
      { visibility: 'public', createdBy: 'user-2' },
    ];
    for (const [req, access] of [
      [AUTHOR, { isSystemAdmin: false, canPublish: false }],
      [PUBLISHER, { isSystemAdmin: false, canPublish: true }],
      [ADMIN, { isSystemAdmin: true, canPublish: true }],
    ] as const) {
      for (const row of rows) {
        expect(checkWriteAccess(row, 'user-1', access))
          .toBe(checkVisibilityWriteAccess(req, row, 'user-1', 'pipelines:publish'));
      }
    }
  });
});

describe('rejectForbiddenBulkRows', () => {
  it('lets a batch of writable rows through without touching the response', () => {
    const res = createMockRes();
    const rows = [
      { id: 'a', visibility: 'org', createdBy: 'user-2' },
      { id: 'b', visibility: 'private', createdBy: 'user-1' },
    ];
    expect(rejectForbiddenBulkRows(AUTHOR, res, rows, 'user-1', 'pipelines:publish', 'nope')).toBe(false);
    expect(res._status).toBe(0);
  });

  it('403s the WHOLE batch and names every offending id', () => {
    // All-or-nothing: a partially applied bulk write is unreasonable for a
    // client to recover from, so the ids come back for a narrowed retry.
    const res = createMockRes();
    const rows = [
      { id: 'a', visibility: 'org', createdBy: 'user-2' },
      { id: 'b', visibility: 'private', createdBy: 'user-2' },
      { id: 'c', visibility: 'public', createdBy: 'user-1' },
    ];
    expect(rejectForbiddenBulkRows(AUTHOR, res, rows, 'user-1', 'pipelines:publish', 'Bulk delete rejected')).toBe(true);
    expect(res._status).toBe(403);
    expect(res._json).toMatchObject({ message: 'Bulk delete rejected', details: { ids: ['b', 'c'] } });
  });

  it('passes an empty batch', () => {
    const res = createMockRes();
    expect(rejectForbiddenBulkRows(AUTHOR, res, [], 'user-1', 'pipelines:publish', 'nope')).toBe(false);
    expect(res._status).toBe(0);
  });

  it('lets a sysadmin through every rung', () => {
    const res = createMockRes();
    const rows = [
      { id: 'a', visibility: 'private', createdBy: 'user-2' },
      { id: 'b', visibility: 'public', createdBy: 'user-2' },
    ];
    expect(rejectForbiddenBulkRows(ADMIN, res, rows, 'admin-1', 'pipelines:publish', 'nope')).toBe(false);
    expect(res._status).toBe(0);
  });
});

describe('resolveVisibility', () => {
  it('defaults to a private draft', () => {
    expect(resolveVisibility(AUTHOR, undefined, 'pipelines:publish')).toBe('private');
  });

  it('passes through the rungs anyone may set', () => {
    expect(resolveVisibility(AUTHOR, 'private', 'pipelines:publish')).toBe('private');
    expect(resolveVisibility(AUTHOR, 'org', 'pipelines:publish')).toBe('org');
  });

  it('clamps a requested `public` to `org` without the publish permission', () => {
    // Clamped to org, not private: they asked to SHARE it, and org is the widest
    // rung they're entitled to.
    expect(resolveVisibility(AUTHOR, 'public', 'pipelines:publish')).toBe('org');
  });

  it('honors `public` for a publisher and for a sysadmin', () => {
    expect(resolveVisibility(PUBLISHER, 'public', 'pipelines:publish')).toBe('public');
    expect(resolveVisibility(ADMIN, 'public', 'pipelines:publish')).toBe('public');
  });
});
