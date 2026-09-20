// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin org detail → Hierarchy: the parent (or "Top-level organization"),
 * the live teams, and the step-up gated move to an eligible root / to top-level.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OrgHierarchyCard } from '../src/components/admin/org-detail/OrgHierarchyCard';
import { OrgIdentityCard } from '../src/components/admin/org-detail/OrgIdentityCard';
import { OrgSeatsCard } from '../src/components/admin/org-detail/OrgSeatsCard';
import { OrgOperationsCard } from '../src/components/admin/org-detail/OrgOperationsCard';
import type { OrganizationDetail } from '../src/lib/api/domains/organizations';

const toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() };
jest.mock('@/components/ui/Toast', () => ({ __esModule: true, useToast: () => toast }));
jest.mock('@/lib/api-cache', () => ({ __esModule: true, invalidate: { organizations: jest.fn() } }));
jest.mock('@/hooks/useDebounce', () => ({ __esModule: true, useDebounce: (v: unknown) => v }));
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => ({ push: jest.fn(), asPath: '/dashboard' }) }));
jest.mock('@/lib/csv-export', () => ({ __esModule: true, triggerBlobDownload: jest.fn() }));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, onConfirmed }: { action: string; onConfirmed: (t: string) => void }) => (
    <div role="dialog" aria-label="step-up">
      <p>{action}</p>
      <button type="button" onClick={() => onConfirmed('step-up-token')}>Verify</button>
    </div>
  ),
}));

const listOrganizations = jest.fn();
const moveOrganization = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listOrganizations: (...a: unknown[]) => listOrganizations(...a),
    moveOrganization: (...a: unknown[]) => moveOrganization(...a),
  },
}));

const base = (over: Partial<OrganizationDetail> = {}): OrganizationDetail => ({
  id: 'org-9', name: 'Platform', ownerId: 'u', memberCount: 3, createdAt: '', updatedAt: '', members: [], ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  listOrganizations.mockImplementation(async (p: { tier: string }) => ({
    success: true,
    data: {
      organizations: p.tier === 'enterprise'
        ? [{ id: 'root-2', name: 'Globex', parentOrgId: null }, { id: 'org-9', name: 'Platform', parentOrgId: null }]
        : [],
      pagination: { total: 1, offset: 0, limit: 20, hasMore: false },
    },
  }));
  moveOrganization.mockResolvedValue({ success: true, data: { organization: {} } });
});

describe('OrgHierarchyCard', () => {
  it('links a team\'s parent', () => {
    render(<OrgHierarchyCard org={base({ parentOrgId: 'root-1', parentOrgName: 'Acme' })} onChanged={jest.fn()} />);
    expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute('href', '/dashboard/admin/orgs/root-1');
  });

  it('marks a root top-level and links its live teams', () => {
    render(<OrgHierarchyCard org={base({ teams: [{ orgId: 't1', orgName: 'Data' }] })} onChanged={jest.fn()} />);
    expect(screen.getByText('Top-level organization')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Data' })).toHaveAttribute('href', '/dashboard/admin/orgs/t1');
  });

  it('moves a team under an eligible root after step-up', async () => {
    const onChanged = jest.fn();
    render(<OrgHierarchyCard org={base({ parentOrgId: 'root-1', parentOrgName: 'Acme' })} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move organization' }));

    fireEvent.focus(screen.getByRole('combobox', { name: 'Destination organization' }));
    // The org being moved is never offered as its own parent.
    expect(screen.queryByRole('option', { name: /platform/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('option', { name: /globex/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    expect(await screen.findByText('Move Platform under Globex')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(moveOrganization).toHaveBeenCalledWith('org-9', 'root-2', 'step-up-token'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('makes a team top-level with a null parent', async () => {
    render(<OrgHierarchyCard org={base({ parentOrgId: 'root-1' })} onChanged={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move organization' }));
    fireEvent.click(screen.getByRole('radio', { name: /make top-level/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(moveOrganization).toHaveBeenCalledWith('org-9', null, 'step-up-token'));
  });

  it('surfaces the backend\'s 400 message', async () => {
    moveOrganization.mockRejectedValue(new Error('Target organization is not on a Team or Enterprise plan'));
    render(<OrgHierarchyCard org={base({ parentOrgId: 'root-1' })} onChanged={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move organization' }));
    fireEvent.click(screen.getByRole('radio', { name: /make top-level/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Target organization is not on a Team or Enterprise plan')).toBeInTheDocument();
  });

  it('refuses to nest a root that still has teams, and offers no top-level move for a root', () => {
    render(<OrgHierarchyCard org={base({ teams: [{ orgId: 't1', orgName: 'Data' }] })} onChanged={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move organization' }));
    expect(screen.getByText(/has teams, so it can.t be nested/i)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /make top-level/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();
  });
});

describe('OrgIdentityCard — team tier', () => {
  it('offers a root a tier change', () => {
    render(<OrgIdentityCard org={base({ tier: 'team' })} onChanged={jest.fn()} onShowMembers={jest.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Change pricing tier' })).toBeInTheDocument();
  });

  it('never offers a team one — its tier is its root\'s', () => {
    render(<OrgIdentityCard org={base({ tier: 'team', parentOrgId: 'root-1' })} onChanged={jest.fn()} onShowMembers={jest.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Change pricing tier' })).not.toBeInTheDocument();
    expect(screen.getByText('Tier inherited from parent')).toBeInTheDocument();
  });

  it('shows an org on the billing-off `unlimited` tier as unlimited, not as Developer', () => {
    // `unlimited` is never purchasable, so it isn't in the offered list — but
    // it IS what every org is on when billing is disabled, and a <select> with
    // no matching option silently displays (and would submit) the first one.
    render(<OrgIdentityCard org={base({ tier: 'unlimited' })} onChanged={jest.fn()} onShowMembers={jest.fn()} />);
    const select = screen.getByRole('combobox', { name: 'Change pricing tier' });
    expect(select).toHaveValue('unlimited');
    expect(screen.getByRole('option', { name: 'Unlimited' })).toBeInTheDocument();
  });

  it('does not offer `unlimited` to an org that is not on it', () => {
    render(<OrgIdentityCard org={base({ tier: 'pro' })} onChanged={jest.fn()} onShowMembers={jest.fn()} />);
    expect(screen.queryByRole('option', { name: 'Unlimited' })).not.toBeInTheDocument();
  });
});

describe('OrgIdentityCard — cache invalidation', () => {
  it('drops the cached org lists after a tier change, so the switcher and lists agree', async () => {
    const { invalidate } = jest.requireMock('@/lib/api-cache') as { invalidate: { organizations: jest.Mock } };
    const updateOrganizationTier = jest.fn().mockResolvedValue({ success: true, data: {} });
    (jest.requireMock('@/lib/api').default as Record<string, unknown>).updateOrganizationTier = updateOrganizationTier;

    render(<OrgIdentityCard org={base({ tier: 'pro' })} onChanged={jest.fn()} onShowMembers={jest.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Change pricing tier' }), { target: { value: 'team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(updateOrganizationTier).toHaveBeenCalledWith('org-9', 'team', 'step-up-token'));
    expect(invalidate.organizations).toHaveBeenCalled();
  });
});

describe('OrgSeatsCard — pooled at the root', () => {
  it('shows the pooled usage and the limit editor on an account root', () => {
    render(<OrgSeatsCard org={base()} seatUsage={{ limit: 25, used: 7 }} onChanged={jest.fn()} />);
    expect(screen.getByText('7 / 25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set limit' })).toBeInTheDocument();
  });

  it('sends a TEAM to its parent instead of an editor that silently retargets the root', () => {
    render(
      <OrgSeatsCard
        org={base({ parentOrgId: 'root-1', parentOrgName: 'Acme' })}
        seatUsage={{ limit: 25, used: 7 }}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Set limit' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute('href', '/dashboard/admin/orgs/root-1');
  });

  it('blames the seat read, not the hierarchy, when the read fails on a root', () => {
    render(<OrgSeatsCard org={base()} seatUsage={null} onChanged={jest.fn()} />);
    expect(screen.getByText(/seat service didn.t respond/i)).toBeInTheDocument();
    expect(screen.queryByText(/may not be an account root/i)).not.toBeInTheDocument();
  });
});

describe('OrgOperationsCard — delete vs. live teams', () => {
  it('offers the delete on an org with no teams', () => {
    render(<OrgOperationsCard org={base()} />);
    expect(screen.getByRole('button', { name: /delete organization/i })).toBeEnabled();
  });

  it('refuses up front on a root with live teams, and says what to do', () => {
    render(<OrgOperationsCard org={base({ teams: [{ orgId: 't1', orgName: 'Data' }, { orgId: 't2', orgName: 'Payments' }] })} />);
    expect(screen.getByRole('button', { name: /delete organization/i })).toBeDisabled();
    expect(screen.getByText(/has 2 teams and can.t be deleted/i)).toBeInTheDocument();
  });
});
