// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GDPR erasure of a deleted user's ecosystem content.
 *
 * This existed only as a COMMENT until now: `plugin_reviews` documented
 * "GDPR user deletion anonymizes: `authorUserId` and the body go NULL, the
 * rating stays", `plugin.review.anonymize` was declared in the audit-action
 * list for it, and nothing implemented either — `deleteUserCascade` is
 * Mongo-only and never reaches Postgres. A deleted user's review body and user
 * id persisted indefinitely while the code asserted the opposite.
 *
 * Three properties carry the design, and each is the reason the obvious
 * implementation would be wrong:
 *
 *  - The RATING SURVIVES. Deleting the row would silently rewrite a listing's
 *    public aggregate score for every reader.
 *  - It runs under a SUPERADMIN tenant context, because reviews are RLS-scoped
 *    by `authorOrgId` and one person may have reviewed from several orgs. A
 *    scrub limited to the request's org is a PARTIAL erasure, which is worse
 *    than a failed one because nothing reports it.
 *  - It is BEST-EFFORT. The user is already gone from Mongo by the time this
 *    runs, so throwing would turn a completed deletion into a failed request
 *    and invite a retry of a delete that already happened.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAnonymize = jest.fn<AnyFn>();
const mockAudit = jest.fn<AnyFn>();
const mockIncCounter = jest.fn<AnyFn>();
/** The tenant context the scrub was run under. */
const scopes: unknown[] = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  anonymizeReviewsByAuthor: (...a: unknown[]) => mockAnonymize(...a),
  runWithTenantContext: <T>(ctx: unknown, fn: () => T) => { scopes.push(ctx); return fn(); },
}));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: mockIncCounter }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: mockAudit }));

const { anonymizeUserEcosystemContent } = await import('../src/services/user-ecosystem-privacy.js');

const req = () => ({ user: { sub: 'admin-1' } }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  scopes.length = 0;
  mockAnonymize.mockResolvedValue(0);
});

describe('anonymizeUserEcosystemContent', () => {
  it('scrubs the user reviews and reports the count', async () => {
    mockAnonymize.mockResolvedValue(3);
    await expect(anonymizeUserEcosystemContent('u-1', req())).resolves.toBe(3);
    expect(mockAnonymize).toHaveBeenCalledWith('u-1');
  });

  it('runs under a SUPERADMIN context, or the erasure is only partial', async () => {
    // Reviews are RLS-scoped by `authorOrgId` and one person may have reviewed
    // from several orgs. Scoping to the request's own org would leave the rest
    // of their prose in place and report success.
    mockAnonymize.mockResolvedValue(1);
    await anonymizeUserEcosystemContent('u-1', req());
    expect(scopes).toEqual([{ orgId: 'system', isSuperAdmin: true }]);
  });

  it('audits the erasure with the COUNT ONLY, never the prose removed', async () => {
    // An erasure is the one thing a data-protection request must be able to
    // EVIDENCE — and putting the scrubbed body in the audit trail would defeat
    // the erasure the trail is recording.
    mockAnonymize.mockResolvedValue(2);
    await anonymizeUserEcosystemContent('u-1', req());
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'plugin.review.anonymize', expect.objectContaining({
      targetType: 'user',
      targetId: 'u-1',
      details: { reviews: 2 },
    }));
    const entry = JSON.stringify(mockAudit.mock.calls[0]);
    expect(entry).not.toMatch(/body|bodyMd|prose/i);
  });

  it('writes NO audit row when there was nothing to scrub', async () => {
    // The overwhelmingly common case — most users never review anything. An
    // erasure row per deletion would bury the ones that erased something.
    await anonymizeUserEcosystemContent('u-1', req());
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('works with no request, for a caller that is not a person', async () => {
    mockAnonymize.mockResolvedValue(1);
    await expect(anonymizeUserEcosystemContent('u-1')).resolves.toBe(1);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('does not throw even when the METRIC emission fails', async () => {
    // The failure the unit tests could not see, because they mock `incCounter`.
    // `incCounter` raises when the metrics registry has not been wired, so an
    // unguarded call in the catch block turned a logged failure into a thrown
    // one — out past the "never throws" contract and into a failed
    // `deleteUserById` for a user who HAD been deleted. An integration test
    // against a real replica set found it. A failure handler that can fail is
    // not a failure handler.
    mockAnonymize.mockRejectedValue(new Error('postgres down'));
    mockIncCounter.mockImplementation(() => { throw new Error('Metrics registry not set'); });
    await expect(anonymizeUserEcosystemContent('u-1', req())).resolves.toBe(0);
  });

  it('NEVER THROWS, and counts the failure instead', async () => {
    // The user is already deleted from Mongo by the time this runs. Throwing
    // would turn a completed deletion into a failed request and invite the
    // operator to retry a delete that already happened; the counter is the
    // signal that an erasure needs finishing by hand.
    mockAnonymize.mockRejectedValue(new Error('postgres down'));
    await expect(anonymizeUserEcosystemContent('u-1', req())).resolves.toBe(0);
    expect(mockIncCounter).toHaveBeenCalledWith('user_erasure_incomplete_total', { store: 'postgres' });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
