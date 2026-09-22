// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pooled org → team quotas in the UI:
 *  - every surface uses the ONE pooling heading + explanation
 *    (`POOLING_TITLE` / `poolingExplanation`), which says which org's limit
 *    binds and what pooling means for seats;
 *  - QuotasAdmin (sysadmin) shows a TEAM read-only — no tier selector, no limit
 *    editors, no Save — with a jump to the root's quota view;
 *  - a root whose NAME the API could not resolve is never named by its UUID.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuotasReadOnly } from '../src/components/quotas/QuotasReadOnly';
import { QuotasAdmin } from '../src/components/quotas/QuotasAdmin';
import { POOLING_TITLE } from '../src/components/quotas/constants';
import type { OrgQuotaResponse } from '@/types';

jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>() })));

const summary = (limit: number, used: number) => ({ limit, used, remaining: Math.max(0, limit - used), unlimited: false, resetAt: '' });
const quotas = {
  plugins: summary(100, 90),
  pipelines: summary(20, 3),
  apiCalls: summary(1000, 10),
  aiCalls: summary(100, 1),
} as unknown as OrgQuotaResponse['quotas'];

function org(pool?: OrgQuotaResponse['pool']): OrgQuotaResponse {
  return { orgId: pool && !pool.isRoot ? 'team-1' : 'root-1', name: pool && !pool.isRoot ? 'Team A' : 'Acme', slug: 'x', tier: 'team', quotas, pool };
}

describe('QuotasReadOnly — pooled labelling', () => {
  const base = { loading: false, canManageBilling: false };

  it('a root with teams gets the shared heading and says its own caps bind them', () => {
    render(<QuotasReadOnly {...base} orgData={org({ rootOrgId: 'root-1', rootOrgName: 'Acme', isRoot: true, orgCount: 3 })} activeOrgIsTeam={false} activeOrgHasTeams />);
    expect(screen.getByText(POOLING_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/these are the limits that bind all of them/i)).toBeInTheDocument();
    // The seat question is answered in the copy, not in a tooltip.
    expect(screen.getByText(/a seat or add-on bought here can be used by any team/i)).toBeInTheDocument();
  });

  it('shows no pooled label for a flat org', () => {
    render(<QuotasReadOnly {...base} orgData={org()} activeOrgIsTeam={false} activeOrgHasTeams={false} />);
    expect(screen.queryByText(POOLING_TITLE)).not.toBeInTheDocument();
  });

  it('a team gets the same heading, naming the root that binds it', () => {
    render(<QuotasReadOnly {...base} orgData={org({ rootOrgId: 'root-1', rootOrgName: 'Acme', isRoot: false, orgCount: 3 })} activeOrgIsTeam activeOrgHasTeams={false} />);
    expect(screen.getByText(POOLING_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/that is the limit that binds you here/i)).toBeInTheDocument();
    expect(screen.getByText(/Acme and its teams draw from ONE set of caps/i)).toBeInTheDocument();
  });
});

describe('QuotasAdmin — sysadmin view of a pooled team', () => {
  function renderAdmin(orgData: OrgQuotaResponse, handleSelectOrg = jest.fn<AnyFn>()) {
    render(
      <QuotasAdmin
        isSuperAdmin
        loading={false}
        orgData={orgData}
        loadError={null}
        editTier="team"
        editValues={{ plugins: 100, pipelines: 20, apiCalls: 1000, aiCalls: 100 } as never}
        dirty={false}
        saving={false}
        platformOrgs={[]}
        filteredOrgs={[]}
        orgTotal={0}
        searchFilter=""
        selectedOrgId={orgData.orgId}
        orgHealthColors={{}}
        atRisk={[]}
        user={null}
        setSearchFilter={jest.fn<AnyFn>()}
        handleSelectOrg={handleSelectOrg}
        handleReset={jest.fn<AnyFn>()}
        handleSave={jest.fn<AnyFn>()}
        handleEditChange={jest.fn<AnyFn>()}
        handleTierChange={jest.fn<AnyFn>()}
        onRetryOrg={jest.fn<AnyFn>()}
        fetchAtRisk={jest.fn<AnyFn>()}
        onResetUsage={jest.fn<AnyFn>(async () => {})}
      />,
    );
    return handleSelectOrg;
  }

  it('a team renders read-only, named by the root ORG NAME, with a link to it and no editors', () => {
    const select = renderAdmin(org({ rootOrgId: 'root-1', rootOrgName: 'Acme', isRoot: false, orgCount: 3 }));

    expect(screen.getByText(POOLING_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/Acme and its 2 teams draw from ONE set of caps/i)).toBeInTheDocument();
    expect(screen.queryByText(/change plan tier/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /view acme's quotas/i }));
    expect(select).toHaveBeenCalledWith('root-1');
  });

  it('a pool root keeps the editors and notes the pooling', () => {
    renderAdmin(org({ rootOrgId: 'root-1', rootOrgName: 'Acme', isRoot: true, orgCount: 3 }));

    expect(screen.getByText(/change plan tier/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
    expect(screen.getByText(/this organization and its 2 teams draw from ONE set of caps/i)).toBeInTheDocument();
    expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(0);
  });

  it('a flat org keeps the editors with no pool copy', () => {
    renderAdmin(org());
    expect(screen.getByText(/change plan tier/i)).toBeInTheDocument();
    expect(screen.queryByText(POOLING_TITLE)).not.toBeInTheDocument();
  });

  it('never prints the root org id when its NAME could not be resolved', () => {
    // The quota service emits `rootOrgName: ''` when it could not read the
    // root's row; the old copy fell through to the raw UUID.
    const select = renderAdmin(org({ rootOrgId: 'root-1', rootOrgName: '', isRoot: false, orgCount: 3 }));

    expect(screen.queryByText(/root-1/)).not.toBeInTheDocument();
    expect(screen.getByText(/the root organization and its 2 teams draw from ONE set of caps/i)).toBeInTheDocument();

    // The id stays reachable for support, as a tooltip on the jump link.
    const jump = screen.getByRole('button', { name: /view the root organization/i });
    expect(jump).toHaveAttribute('title', 'Organization id: root-1');
    fireEvent.click(jump);
    expect(select).toHaveBeenCalledWith('root-1');
  });
});
