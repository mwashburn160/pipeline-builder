// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pooled org → team quotas in the UI:
 *  - QuotasReadOnly labels a ROOT-with-teams view as pooled across the org and
 *    its teams (the team copy is unchanged);
 *  - QuotasAdmin (sysadmin) shows a TEAM read-only — no tier selector, no limit
 *    editors, no Save — with a jump to the root's quota view.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { QuotasReadOnly } from '../src/components/quotas/QuotasReadOnly';
import { QuotasAdmin } from '../src/components/quotas/QuotasAdmin';
import type { OrgQuotaResponse } from '@/types';

jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn(), error: jest.fn() }),
}));

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

  it('labels a root with teams as pooled across the org and its teams', () => {
    render(<QuotasReadOnly {...base} orgData={org({ rootOrgId: 'root-1', rootOrgName: 'Acme', isRoot: true, orgCount: 3 })} activeOrgIsTeam={false} activeOrgHasTeams />);
    expect(screen.getByText(/pooled across your organization and its teams/i)).toBeInTheDocument();
  });

  it('shows no pooled label for a flat org', () => {
    render(<QuotasReadOnly {...base} orgData={org()} activeOrgIsTeam={false} activeOrgHasTeams={false} />);
    expect(screen.queryByText(/pooled across/i)).not.toBeInTheDocument();
  });

  it('keeps the existing team copy for a team', () => {
    render(<QuotasReadOnly {...base} orgData={org()} activeOrgIsTeam activeOrgHasTeams={false} />);
    expect(screen.getByText(/^pooled across your organization$/i)).toBeInTheDocument();
    expect(screen.queryByText(/and its teams/i)).not.toBeInTheDocument();
  });
});

describe('QuotasAdmin — sysadmin view of a pooled team', () => {
  function renderAdmin(orgData: OrgQuotaResponse, handleSelectOrg = jest.fn()) {
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
        setSearchFilter={jest.fn()}
        handleSelectOrg={handleSelectOrg}
        handleReset={jest.fn()}
        handleSave={jest.fn()}
        handleEditChange={jest.fn()}
        handleTierChange={jest.fn()}
        onRetryOrg={jest.fn()}
        fetchAtRisk={jest.fn()}
        onResetUsage={jest.fn(async () => {})}
      />,
    );
    return handleSelectOrg;
  }

  it('a team renders read-only "Pooled at {root}" with a link to the root, and no editors', () => {
    const select = renderAdmin(org({ rootOrgId: 'root-1', rootOrgName: 'Acme', isRoot: false, orgCount: 3 }));

    expect(screen.getByText('Pooled at Acme')).toBeInTheDocument();
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
    expect(screen.getByText(/pooled across this organization and its 2 teams/i)).toBeInTheDocument();
    expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^pooled at/i)).not.toBeInTheDocument();
  });

  it('a flat org keeps the editors with no pool copy', () => {
    renderAdmin(org());
    expect(screen.getByText(/change plan tier/i)).toBeInTheDocument();
    expect(screen.queryByText(/pooled/i)).not.toBeInTheDocument();
  });
});
