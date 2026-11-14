// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The two org-subtree readers, and the one difference between them that matters.
 *
 * `resolveOrgRollup` is FAIL-SOFT — an unreachable platform reads as "no teams",
 * which is right for an on-demand dashboard. `resolveOrgSubtree` is STRICT — it
 * throws, which is what the account-wide entitlement sync and a rollup report
 * need: for them a root-only answer is a wrong answer, not a degraded one. The
 * sync once used the fail-soft reader inside a try/catch that could never fire,
 * so a platform blip paused (or resumed) the root's reports and none of its teams'.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockDescendants = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  fetchOrgDescendants: (...a: unknown[]) => mockDescendants(...a),
}));

const helpers = await import('../src/helpers/report-helpers.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('org subtree readers', () => {
  it('both return the subtree platform answered', async () => {
    mockDescendants.mockResolvedValue(['root', 'team-a']);
    await expect(helpers.resolveOrgSubtree('root')).resolves.toEqual(['root', 'team-a']);
    await expect(helpers.resolveOrgRollup('root')).resolves.toEqual(['root', 'team-a']);
    // STRICT: a platform non-2xx must throw too, not read as "no teams".
    expect(mockDescendants.mock.calls[0]?.[1]).toMatchObject({ headers: { 'x-org-id': 'root' }, throwOnHttpError: true });
  });

  it('the STRICT reader throws when platform is unreachable', async () => {
    mockDescendants.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(helpers.resolveOrgSubtree('root')).rejects.toThrow('ECONNREFUSED');
  });

  it('the fail-soft reader degrades to "no teams" on the same failure', async () => {
    mockDescendants.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(helpers.resolveOrgRollup('root')).resolves.toBeUndefined();
  });
});

describe('sendPdfRefusal', () => {
  const res = () => {
    const r = { status: jest.fn<AnyFn>(), json: jest.fn<AnyFn>() };
    r.status.mockReturnValue(r);
    return r;
  };

  it.each([
    ['busy', 429],
    ['unavailable', 503],
    ['timeout', 500],
    ['render_failed', 500],
  ] as const)('answers %s with %i', (reason, status) => {
    const r = res();
    helpers.sendPdfRefusal(r as never, { ok: false, reason, message: 'm' });
    expect(r.status).toHaveBeenCalledWith(status);
  });
});
