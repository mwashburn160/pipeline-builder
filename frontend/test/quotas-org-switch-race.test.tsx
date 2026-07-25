// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: rapidly switching the selected org must not let a slower, older
 * response win. A sysadmin who selects Alpha then Beta must always see Beta's
 * quotas — even if Alpha's fetch resolves LAST. Guarded by a request-generation
 * ref in QuotasPage.fetchOrg.
 */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import QuotasPage from '../pages/dashboard/quotas';

const authGuard = {
  isReady: true,
  isSuperAdmin: true,
  isAdmin: true,
  can: () => false,
  user: { id: 'u1', organizationId: 'org-a', organizationName: 'Alpha', role: 'owner' },
};
jest.mock('@/hooks/useAuthGuard', () => ({ __esModule: true, useAuthGuard: () => authGuard }));
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ organizations: [{ id: 'org-a', name: 'Alpha' }, { id: 'org-b', name: 'Beta' }] }),
}));
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/components/ui/DashboardLayout', () => ({
  __esModule: true,
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Deferred quota fetches, keyed by orgId, so the test controls resolution order.
type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void };
const deferreds: Record<string, Deferred> = {};
function getDeferred(orgId: string): Deferred {
  if (!deferreds[orgId]) {
    let resolve!: (v: unknown) => void;
    const promise = new Promise<unknown>((r) => { resolve = r; });
    deferreds[orgId] = { promise, resolve };
  }
  return deferreds[orgId];
}
const mkQuota = (orgId: string, name: string, slug: string) => ({
  data: {
    quota: {
      orgId, name, slug, tier: 'developer',
      quotas: {
        plugins: { limit: 10, used: 1, remaining: 9, unlimited: false, resetAt: '' },
        pipelines: { limit: 10, used: 1, remaining: 9, unlimited: false, resetAt: '' },
        apiCalls: { limit: 100, used: 1, remaining: 99, unlimited: false, resetAt: '' },
        aiCalls: { limit: 100, used: 1, remaining: 99, unlimited: false, resetAt: '' },
      },
    },
  },
});

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listOrganizations: jest.fn().mockResolvedValue({
      data: { organizations: [{ id: 'org-a', name: 'Alpha' }, { id: 'org-b', name: 'Beta' }] },
    }),
    getAtRiskQuotas: jest.fn().mockResolvedValue({ success: true, data: { atRisk: [] } }),
    getOrgAtRisk: jest.fn().mockResolvedValue({ success: true, data: { atRisk: [] } }),
    getOrgQuotas: (orgId: string) => getDeferred(orgId).promise,
    getOwnQuotas: jest.fn(),
    getAllOrgQuotas: jest.fn(),
  },
}));

beforeEach(() => {
  for (const k of Object.keys(deferreds)) delete deferreds[k];
});

describe('QuotasPage — org-switch race', () => {
  it('shows the latest selection (Beta) even when the older fetch (Alpha) resolves last', async () => {
    render(<QuotasPage />);

    // Sidebar renders once listOrganizations resolves; default selection = Alpha,
    // whose fetch (deferred) is now in-flight.
    const betaBtn = await screen.findByText('Beta');

    // Switch to Beta — a second fetch goes in-flight.
    fireEvent.click(betaBtn);

    // Resolve Beta FIRST, then Alpha (out of order). The stale Alpha response
    // must be discarded by the generation guard.
    await act(async () => { getDeferred('org-b').resolve(mkQuota('org-b', 'Beta', 'beta-slug')); });
    await act(async () => { getDeferred('org-a').resolve(mkQuota('org-a', 'Alpha', 'alpha-slug')); });

    // The detail header carries the selected org's slug (unique to the header).
    await waitFor(() => expect(screen.getByText('beta-slug')).toBeInTheDocument());
    expect(screen.queryByText('alpha-slug')).not.toBeInTheDocument();
  });
});
