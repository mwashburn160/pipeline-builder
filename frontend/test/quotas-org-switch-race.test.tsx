// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: rapidly switching the selected org must not let a slower, older
 * response win. A sysadmin who selects Alpha then Beta must always see Beta's
 * quotas — even if Alpha's fetch resolves LAST. Guarded by a request-generation
 * ref in QuotasPage.fetchOrg.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import QuotasPage from '../pages/dashboard/quotas';
import api from '@/lib/api';

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
  useToast: () => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>() }),
}));
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());

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
    listOrganizations: jest.fn<AnyFn>().mockResolvedValue({
      data: { organizations: [{ id: 'org-a', name: 'Alpha' }, { id: 'org-b', name: 'Beta' }] },
    }),
    getAtRiskQuotas: jest.fn<AnyFn>().mockResolvedValue({ success: true, data: { atRisk: [] } }),
    getOrgAtRisk: jest.fn<AnyFn>().mockResolvedValue({ success: true, data: { atRisk: [] } }),
    getOrgQuotas: (orgId: string) => getDeferred(orgId).promise,
    getOwnQuotas: jest.fn<AnyFn>(),
    getAllOrgQuotas: jest.fn<AnyFn>(),
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

describe('QuotasPage — org search race', () => {
  it('keeps the newest search results when an older search resolves last', async () => {
    const searches: Record<string, Deferred> = {};
    const searchDeferred = (term: string) => {
      if (!searches[term]) {
        let resolve!: (v: unknown) => void;
        const promise = new Promise<unknown>((r) => { resolve = r; });
        searches[term] = { promise, resolve };
      }
      return searches[term];
    };
    (api.listOrganizations as jest.Mock<AnyFn>).mockImplementation((opts: { search?: string }) =>
      (opts.search ? searchDeferred(opts.search).promise : Promise.resolve({
        data: { organizations: [{ id: 'org-a', name: 'Alpha' }, { id: 'org-b', name: 'Beta' }] },
      })));

    render(<QuotasPage />);
    const filter = await screen.findByPlaceholderText('Filter...');

    fireEvent.change(filter, { target: { value: 'a' } });
    await waitFor(() => expect(searches.a).toBeDefined());
    fireEvent.change(filter, { target: { value: 'ab' } });
    await waitFor(() => expect(searches.ab).toBeDefined());

    // Newer search resolves first, the older one last.
    await act(async () => { searchDeferred('ab').resolve({ data: { organizations: [{ id: 'fresh', name: 'Fresh ab org' }] } }); });
    await act(async () => { searchDeferred('a').resolve({ data: { organizations: [{ id: 'stale', name: 'Stale ab org' }] } }); });

    await waitFor(() => expect(screen.getByText('Fresh ab org')).toBeInTheDocument());
    expect(screen.queryByText('Stale ab org')).not.toBeInTheDocument();
  });
});
