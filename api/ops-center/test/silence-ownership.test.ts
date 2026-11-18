// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Silence ownership (list + expire) for non-sysadmins.
 *
 * Regression: ownership used to be "any `org_id` matcher whose value equals my
 * org", ignoring isEqual / isRegex. A sysadmin silence `org_id!="org-a"`
 * (silence everyone EXCEPT org-a) therefore showed up in org-a's list and an
 * org-a member could expire it — un-silencing every other tenant.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

type Matcher = { name: string; value: string; isRegex: boolean; isEqual: boolean };
type Silence = { id: string; matchers: Matcher[] };

const mockListSilences = jest.fn<() => Promise<Silence[]>>();
const mockDeleteSilence = jest.fn<(id: string) => Promise<void>>();

jest.unstable_mockModule('../src/observability/alertmanager-client.js', () => ({
  listSilences: () => mockListSilences(),
  deleteSilence: (id: string) => mockDeleteSilence(id),
  expireSilence: (id: string) => mockDeleteSilence(id),
  listAlerts: jest.fn(async () => []),
  createSilence: jest.fn(async () => ({ silenceID: 'new' })),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));

const { observabilitySilencesList, observabilitySilenceDelete } = await import('../src/observability/controller.js');
const { makeRes } = await import('./helpers/pglite-controller.js');

const m = (value: string, over: Partial<Matcher> = {}): Matcher => ({ name: 'org_id', value, isRegex: false, isEqual: true, ...over });

const OWN: Silence = { id: 's-own', matchers: [m('org-a'), { name: 'alertname', value: 'X', isRegex: false, isEqual: true }] };
const NEGATED: Silence = { id: 's-neg', matchers: [m('org-a', { isEqual: false })] };
const REGEX: Silence = { id: 's-re', matchers: [m('org-a', { isRegex: true })] };
const OTHER: Silence = { id: 's-b', matchers: [m('org-b')] };

const req = (over: Record<string, unknown> = {}) => ({
  method: 'GET',
  headers: {},
  params: {},
  query: {},
  body: undefined,
  user: { sub: 'u-a', organizationId: 'org-a', role: 'admin' },
  ...over,
});

beforeEach(() => {
  mockListSilences.mockReset().mockResolvedValue([OWN, NEGATED, REGEX, OTHER]);
  mockDeleteSilence.mockReset().mockResolvedValue(undefined);
});

describe('silence ownership for a non-sysadmin', () => {
  it('lists only silences with a positive, literal org_id matcher for the caller', async () => {
    const res = makeRes();
    await observabilitySilencesList(req() as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body?.data?.silences as Silence[]).map((s) => s.id)).toEqual(['s-own']);
  });

  it.each([
    ['a negated org_id matcher (org_id!="org-a" — silences every OTHER tenant)', 's-neg'],
    ['a regex org_id matcher', 's-re'],
    ['another org\'s silence', 's-b'],
  ])('cannot expire %s', async (_label, id) => {
    const res = makeRes();
    await observabilitySilenceDelete(req({ method: 'DELETE', params: { id } }) as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(mockDeleteSilence).not.toHaveBeenCalled();
  });

  it('can expire its own silence', async () => {
    const res = makeRes();
    await observabilitySilenceDelete(req({ method: 'DELETE', params: { id: 's-own' } }) as never, res as never);
    expect(res.statusCode).toBeLessThan(300);
    expect(mockDeleteSilence).toHaveBeenCalledWith('s-own');
  });
});
