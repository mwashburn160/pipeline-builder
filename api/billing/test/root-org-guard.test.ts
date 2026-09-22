// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * refuseTeamBilling — billing belongs to the account ROOT. A team (child) org
 * must never mint its own subscription / add-on / checkout / portal session.
 * (Route wiring is pinned in org-admin-mfa-gates.test.ts.)
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFetchParentOrgId = jest.fn<(...args: unknown[]) => Promise<string | undefined>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  fetchParentOrgId: mockFetchParentOrgId,
}));
jest.unstable_mockModule('../src/config.js', () => ({
  config: { platformService: { host: 'platform', port: 3000 } },
}));

const { refuseTeamBilling } = await import('../src/helpers/root-org-guard.js');

function res(): any {
  const r: any = {};
  r.status = jest.fn<AnyFn>().mockReturnValue(r);
  r.json = jest.fn<AnyFn>().mockReturnValue(r);
  return r;
}

async function run(user: Record<string, unknown>) {
  const r = res();
  const next = jest.fn<AnyFn>();
  await refuseTeamBilling({ user } as any, r, next);
  return { r, next };
}

describe('refuseTeamBilling', () => {
  beforeEach(() => { mockFetchParentOrgId.mockReset(); });

  it('admits a flat/root org (no hierarchy claims)', async () => {
    const { r, next } = await run({ organizationId: 'root-1', sub: 'u' });
    expect(next).toHaveBeenCalled();
    expect(r.status).not.toHaveBeenCalled();
  });

  it('admits the root itself even when it carries rootOrganizationId=self', async () => {
    const { next } = await run({ organizationId: 'root-1', rootOrganizationId: 'root-1' });
    expect(next).toHaveBeenCalled();
  });

  it('refuses a team org identified by parentOrganizationId', async () => {
    const { r, next } = await run({ organizationId: 'team-1', parentOrganizationId: 'root-1', rootOrganizationId: 'root-1' });
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(403);
  });

  it('refuses a team org identified only by a foreign rootOrganizationId', async () => {
    const { r, next } = await run({ organizationId: 'team-1', rootOrganizationId: 'root-1' });
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(403);
  });

  it('resolves a sysadmin header-override target from platform (claims describe the admin\'s own org)', async () => {
    mockFetchParentOrgId.mockResolvedValueOnce('root-1');
    const { r, next } = await run({ organizationId: 'team-1', isSuperAdmin: true });
    expect(mockFetchParentOrgId).toHaveBeenCalledWith('team-1', expect.objectContaining({ throwOnHttpError: true }));
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(403);
  });

  it('admits a sysadmin acting on a root org', async () => {
    mockFetchParentOrgId.mockResolvedValueOnce(undefined);
    const { next } = await run({ organizationId: 'root-2', isSuperAdmin: true });
    expect(next).toHaveBeenCalled();
  });

  it('fails CLOSED (503) when the sysadmin hierarchy lookup fails', async () => {
    mockFetchParentOrgId.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { r, next } = await run({ organizationId: 'x', isSuperAdmin: true });
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(503);
  });
});
