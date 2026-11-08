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
  VISIBILITY_WRITE_REFUSAL,
  type VisibilityWriteVerdict,
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

describe('VISIBILITY_WRITE_REFUSAL — every refusal has a message, and only refusals do', () => {
  // The catalog exists so a verdict added to the union cannot reach a consumer
  // without a message. That guarantee is a COMPILE-time one, so what is
  // assertable here is its shape: the keys are exactly the non-`ok` verdicts.
  // If someone widens the union and only "fixes" the type by adding `ok` or by
  // loosening the Record's key type, this fails.
  const ALL: VisibilityWriteVerdict[] = ['ok', 'needs-publish', 'not-author'];

  it('covers every verdict except `ok`', () => {
    expect(Object.keys(VISIBILITY_WRITE_REFUSAL).sort()).toEqual(
      ALL.filter((v) => v !== 'ok').sort(),
    );
  });

  it('carries no entry for `ok` — a success path must not have a refusal message', () => {
    expect(VISIBILITY_WRITE_REFUSAL).not.toHaveProperty('ok');
  });

  it('gives every refusal a non-empty, distinct sentence', () => {
    const messages = Object.values(VISIBILITY_WRITE_REFUSAL);
    for (const m of messages) expect(m.trim().length).toBeGreaterThan(0);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('is the message the middleware actually sends', () => {
    // Pins the catalog to the wire, so a reworded entry cannot silently stop
    // being what a caller sees.
    const res = createMockRes();
    requireVisibilityWriteAccess(
      createMockReq({ sub: 'user-1' }),
      res,
      { visibility: 'public', createdBy: 'user-1' },
      'user-1',
      'pipelines:publish',
    );
    expect(res._status).toBe(403);
    expect((res._json as { message?: string }).message).toBe(VISIBILITY_WRITE_REFUSAL['needs-publish']);
  });

  it('sends the AUTHOR message on a private-draft refusal, not the public one', () => {
    // The ternary this replaced could only ever produce two outcomes, so a
    // third verdict would have been reported as `not-author`. These two cases
    // are what prove the keyed lookup picks per verdict rather than by
    // elimination.
    const res = createMockRes();
    requireVisibilityWriteAccess(
      createMockReq({ sub: 'user-1' }),
      res,
      { visibility: 'private', createdBy: 'user-2' },
      'user-1',
      'pipelines:publish',
    );
    expect(res._status).toBe(403);
    expect((res._json as { message?: string }).message).toBe(VISIBILITY_WRITE_REFUSAL['not-author']);
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
