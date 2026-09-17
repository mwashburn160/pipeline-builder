// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Smoke tests for the sysadmin pages whose modals were split out into
 * components (registry, discounts, organizations). They prove the page ↔
 * extracted-component wiring survived: each flow opens from the page, calls the
 * API, and fires the page's refresh/toast callbacks.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import RegistryPage from '../pages/dashboard/registry';
import DiscountsPage from '../pages/dashboard/discounts';
import OrganizationsPage from '../pages/dashboard/organizations';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';

mockAuthGuard({ isSuperAdmin: true, user: { id: 'me', organizationId: 'system' }, can: () => true });
const toast = pageToast;

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ query: {}, pathname: '/dashboard/x', replace: jest.fn(), push: jest.fn() }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));

jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button type="button" onClick={() => onConfirmed('step-up-token')}>Confirm password</button>
  ),
}));

jest.mock('@/components/onboarding/OrgSetupStep', () => ({
  __esModule: true,
  OrgSetupStep: ({ planTier }: { planTier?: string }) => <div>setup-step:{planTier}</div>,
}));

jest.mock('@/components/billing/BillingAdminTabs', () => ({ __esModule: true, BillingAdminTabs: () => null }));
jest.mock('@/components/RecentlyDeletedPanel', () => ({ __esModule: true, RecentlyDeletedPanel: () => null }));

const listPage = {
  data: [] as unknown[],
  filters: {} as Record<string, string>,
  error: null,
  isLoading: false,
  pagination: { total: 0, offset: 0, limit: 25 },
  refresh: jest.fn(),
  setError: jest.fn(),
  updateFilter: jest.fn(),
  handlePageChange: jest.fn(),
  handlePageSizeChange: jest.fn(),
};
jest.mock('@/hooks/useListPage', () => ({ __esModule: true, useListPage: () => listPage }));

// Registry data hooks — the panes are not under test here.
jest.mock('@/hooks/useRepositoryList', () => ({
  __esModule: true,
  useRepositoryList: () => ({ groups: [], repos: [], hasMore: false, loading: false, error: null, loadMore: jest.fn(), refresh: registryRefresh }),
}));
jest.mock('@/hooks/useImageTags', () => ({
  __esModule: true,
  useImageTags: () => ({ tags: null, loading: false, error: null, refresh: jest.fn() }),
  invalidateImageTags: jest.fn(),
}));
jest.mock('@/hooks/useImageDetail', () => ({ __esModule: true, useImageDetail: () => ({ kind: null, loading: false, error: null }) }));
jest.mock('@/hooks/useTagsWithMetadata', () => ({ __esModule: true, useTagsWithMetadata: () => ({ metadata: {}, loading: false }) }));
jest.mock('@/components/registry/RepositoryList', () => ({ __esModule: true, RepositoryList: () => null }));
jest.mock('@/components/registry/RecentActionsPanel', () => ({ __esModule: true, RecentActionsPanel: () => null }));

const registryRefresh = jest.fn();
const apiMock = {
  listImages: jest.fn(),
  runRegistryGc: jest.fn(),
  getRegistryStorageUsage: jest.fn(),
  updateDiscount: jest.fn(),
  createDiscount: jest.fn(),
  applyDiscountToOrg: jest.fn(),
  listOrganizations: jest.fn(),
  createOrganization: jest.fn(),
  updateOrganizationTier: jest.fn(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  get default() { return apiMock; },
  get api() { return apiMock; },
  ApiError: jest.requireActual('@/lib/api/errors').ApiError,
}));

beforeEach(() => {
  jest.clearAllMocks();
  listPage.data = [];
  listPage.filters = {};
  apiMock.listImages.mockResolvedValue({ success: true, data: {} });
  apiMock.listOrganizations.mockResolvedValue({ success: true, data: { organizations: [{ id: 'org-a', name: 'Acme' }] } });
});

describe('RegistryPage — extracted modals', () => {
  it('pings registry health via polling and shows the OK badge', async () => {
    const { unmount } = render(<RegistryPage />);
    expect(await screen.findByText('Registry OK')).toBeInTheDocument();
    expect(apiMock.listImages).toHaveBeenCalledWith({ limit: 1 });
    unmount();
  });

  it('runs a dry-run GC from the GC modal without refreshing the repo list', async () => {
    apiMock.runRegistryGc.mockResolvedValue({ success: true, data: { candidates: 3, deleted: 0, reposScanned: 2 } });
    render(<RegistryPage />);

    fireEvent.click(screen.getByRole('button', { name: /Run GC/ }));
    fireEvent.change(screen.getByPlaceholderText('org-acme/'), { target: { value: 'org-acme/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run dry-run' }));

    await waitFor(() => expect(apiMock.runRegistryGc).toHaveBeenCalledWith({ prefix: 'org-acme/', dryRun: true }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Dry-run: 3 candidates across 2 repos/)));
    expect(registryRefresh).not.toHaveBeenCalled();
  });

  it('computes namespace storage usage from the storage modal', async () => {
    apiMock.getRegistryStorageUsage.mockResolvedValue({
      success: true,
      data: { prefix: 'org-acme/', bytes: 2048, repos: 4, blobs: 9, incomplete: false, computedAt: new Date().toISOString() },
    });
    render(<RegistryPage />);

    fireEvent.click(screen.getByRole('button', { name: /Storage usage/ }));
    fireEvent.change(screen.getByPlaceholderText('org-acme/'), { target: { value: 'org-acme/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compute' }));

    await waitFor(() => expect(apiMock.getRegistryStorageUsage).toHaveBeenCalledWith('org-acme/', undefined));
    expect(await screen.findByText('unique blobs')).toBeInTheDocument();
  });
});

describe('DiscountsPage — extracted modals', () => {
  const discount = {
    id: 'd1', code: '50:percent:onetime', unit: 'percent', value: 50, kind: 'onetime',
    isActive: true, timesRedeemed: 0, maxRedemptions: null, redeemBy: null, appliesToTiers: [],
    alias: 'LAUNCH50', targetOrgId: null, campaign: null,
  };

  it('edits a discount, then refreshes the list and toasts', async () => {
    listPage.data = [discount];
    apiMock.updateDiscount.mockResolvedValue({ success: true, data: {} });
    render(<DiscountsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(screen.getByText(/Editing/)).toHaveTextContent('LAUNCH50');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(apiMock.updateDiscount).toHaveBeenCalledWith('d1', { isActive: true, appliesToTiers: [] }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Discount updated'));
    expect(listPage.refresh).toHaveBeenCalled();
    expect(screen.queryByText(/Editing/)).not.toBeInTheDocument();
  });

  it('mints a discount from the New Discount modal', async () => {
    apiMock.createDiscount.mockResolvedValue({ success: true, data: {} });
    render(<DiscountsPage />);

    fireEvent.click(screen.getByRole('button', { name: /New Discount/ }));
    fireEvent.change(screen.getByPlaceholderText('50:percent:onetime'), { target: { value: '25:dollar:recurring' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Discount' }));

    await waitFor(() => expect(apiMock.createDiscount).toHaveBeenCalledWith({ code: '25:dollar:recurring' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Discount created'));
  });

  it('applies a discount to an org picked from the loaded options', async () => {
    listPage.data = [discount];
    apiMock.applyDiscountToOrg.mockResolvedValue({ success: true, data: {} });
    render(<DiscountsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Apply to org/ }));
    await screen.findByRole('option', { name: 'Acme' });
    fireEvent.change(screen.getByLabelText('Target organization'), { target: { value: 'org-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(apiMock.applyDiscountToOrg).toHaveBeenCalledWith('d1', 'org-a'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Discount applied to org-a'));
  });
});

describe('OrganizationsPage — extracted components', () => {
  const org = { id: 'org-b', name: 'Beta', tier: 'developer', memberCount: 1, createdAt: new Date().toISOString() };

  it('creates a top-level org, refreshes, and then shows the setup step', async () => {
    apiMock.createOrganization.mockResolvedValue({ success: true, data: {} });
    render(<OrganizationsPage />);

    fireEvent.click(screen.getByRole('button', { name: /New Organization/ }));
    await waitFor(() => expect(apiMock.listOrganizations).toHaveBeenCalledWith({ limit: 200 }));
    fireEvent.change(screen.getByPlaceholderText('e.g. acme-platform'), { target: { value: 'gamma' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Organization' }));

    await waitFor(() => expect(apiMock.createOrganization).toHaveBeenCalledWith({ name: 'gamma', tier: 'developer' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Organization "gamma" created'));
    expect(listPage.refresh).toHaveBeenCalled();
    expect(await screen.findByText('setup-step:developer')).toBeInTheDocument();
  });

  it('changes tier via the row menu → tier dialog → step-up', async () => {
    listPage.data = [org];
    apiMock.updateOrganizationTier.mockResolvedValue({ success: true });
    render(<OrganizationsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Change tier/ }));
    const continueBtn = screen.getByRole('button', { name: 'Continue' });
    expect(continueBtn).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue('Developer'), { target: { value: 'team' } });
    fireEvent.click(continueBtn);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm password' })); });
    await waitFor(() => expect(apiMock.updateOrganizationTier).toHaveBeenCalledWith('org-b', 'team', 'step-up-token'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Beta moved to team'));
  });
});
