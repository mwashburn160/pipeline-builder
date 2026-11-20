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
const mockParent = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  fetchOrgDescendants: (...a: unknown[]) => mockDescendants(...a),
  fetchParentOrgId: (...a: unknown[]) => mockParent(...a),
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

describe('resolveOrgAncestors (fail-soft)', () => {
  const chain: Record<string, string | undefined> = { team: 'parent', parent: 'root', root: undefined };

  it('walks the parent chain, nearest first, through platform', async () => {
    mockParent.mockImplementation(async (id: unknown) => chain[String(id)]);
    await expect(helpers.resolveOrgAncestors('team')).resolves.toEqual(['parent', 'root']);
    expect(mockParent.mock.calls.map((c) => c[0])).toEqual(['team', 'parent', 'root']);
    expect(mockParent.mock.calls[0]?.[1]).toMatchObject({ throwOnHttpError: true });
  });

  it('starts from a known parent without asking for it', async () => {
    mockParent.mockImplementation(async (id: unknown) => chain[String(id)]);
    await expect(helpers.resolveOrgAncestors('team', 'parent')).resolves.toEqual(['parent', 'root']);
    expect(mockParent.mock.calls.map((c) => c[0])).toEqual(['parent', 'root']);
  });

  it('a root org has no ancestors', async () => {
    mockParent.mockResolvedValue(undefined);
    await expect(helpers.resolveOrgAncestors('root')).resolves.toEqual([]);
  });

  it('stops on a cycle', async () => {
    mockParent.mockImplementation(async (id: unknown) => (id === 'a' ? 'b' : 'a'));
    await expect(helpers.resolveOrgAncestors('a')).resolves.toEqual(['b']);
  });

  it('any lookup failure reads as no ancestors, never a throw', async () => {
    mockParent.mockImplementation(async (id: unknown) => {
      if (id === 'parent') throw new Error('HTTP 503');
      return chain[String(id)];
    });
    await expect(helpers.resolveOrgAncestors('team')).resolves.toEqual([]);
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

/**
 * The operator's cross-org error/failure reports carry raw failure text, which
 * routinely holds ARNs (an AWS account id — never to be surfaced), bearer
 * tokens and provider keys. The local two-pattern list missed all of them; the
 * scrub now also runs api-core's shared `maskLine`, the one list every log
 * masking layer uses.
 */
describe('scrubErrorMessage', () => {
  it('keeps redacting the shapes it always did', () => {
    expect(helpers.scrubErrorMessage('AWS_SECRET_ACCESS_KEY=abc123 failed')).not.toContain('abc123');
    expect(helpers.scrubErrorMessage('password: hunter2')).not.toContain('hunter2');
  });

  it('redacts an AWS account id inside an ARN', () => {
    const out = helpers.scrubErrorMessage('AccessDenied: arn:aws:iam::123456789012:role/deploy is not authorized');
    expect(out).not.toContain('123456789012');
    expect(out).toContain('AccessDenied');
  });

  it('redacts a bearer token and a GitHub token', () => {
    const out = helpers.scrubErrorMessage('401 with Authorization: Bearer eyJabc.def.ghi and ghp_0123456789abcdefghijABCDEFGHIJ012345');
    expect(out).not.toContain('eyJabc.def.ghi');
    expect(out).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ012345');
  });

  it('passes empty values through', () => {
    expect(helpers.scrubErrorMessage(null)).toBeNull();
    expect(helpers.scrubErrorMessage(undefined)).toBeUndefined();
    expect(helpers.scrubErrorMessage('')).toBe('');
  });
});
