// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator org drill-down's billing-side controls:
 *  - "Support incidents": GRANT one-time support incidents to an org's account
 *    (POST /billing/admin/orgs/:orgId/support-incidents `{ count, note? }`,
 *    system org + `support_cases:write` + step-up). A team's grant lands on its
 *    account root, which the answer names.
 *  - The Per-org KMS card says when a runner-key re-wrap is pending.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, mockRouter } from './helpers/pageMocks';
import { ApiError } from '../src/lib/api/errors';
import { OrgSupportIncidentsCard } from '../src/components/admin/org-detail/OrgSupportIncidentsCard';
import OrgDetailPage from '../pages/dashboard/admin/orgs/[orgId]';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useBillingEnabled', () => ({ __esModule: true, useBillingEnabled: () => (globalThis as { __billing?: boolean }).__billing !== false }));
jest.mock('@/components/admin/org-detail/OrgSeatsCard', () => ({ __esModule: true, OrgSeatsCard: () => null }));
jest.mock('@/components/admin/org-detail/OrgOperationsCard', () => ({ __esModule: true, OrgOperationsCard: () => null }));
jest.mock('@/components/admin/org-detail/OrgMemberRoster', () => ({ __esModule: true, OrgMemberRoster: () => null }));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, onClose, action }: { onConfirmed: (t: string) => Promise<void> | void; onClose: () => void; action: string }) => (
    <div data-testid="stepup-modal">
      <p>{action}</p>
      <button type="button" onClick={async () => { await onConfirmed('tok'); onClose(); }}>Confirm step-up</button>
    </div>
  ),
}));

const api: Record<string, jest.Mock<AnyFn>> = {
  grantSupportIncidents: jest.fn<AnyFn>(),
  getOrganization: jest.fn<AnyFn>(),
  getOrgKmsConfig: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => {
  const errors = jest.requireActual<typeof import('../src/lib/api/errors')>('../src/lib/api/errors');
  return {
    __esModule: true,
    ApiError: errors.ApiError,
    default: new Proxy({}, {
      get: (_t, k: string) => (...a: unknown[]) => (api[k] ? api[k](...a) : Promise.resolve({ success: true, data: {} })),
    }),
  };
});

const ORG = { id: 'org-2', name: 'Child Co', slug: 'child-co', tier: 'team', parentOrgId: null, childOrgCount: 0, memberCount: 3 } as never;
const TEAM = { id: 'team-1', name: 'Team One', slug: 'team-one', tier: 'team', parentOrgId: 'org-root', parentOrgName: 'Root Co', childOrgCount: 0, memberCount: 1 } as never;

beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as { __billing?: boolean }).__billing = true;
  mockAuthGuard({ user: { id: 'op', organizationId: 'system' }, isSuperAdmin: true });
  api.grantSupportIncidents.mockResolvedValue({ success: true, data: { balance: 5, accountOrgId: 'org-2' } });
});

const fill = (count: string, note?: string) => {
  fireEvent.change(screen.getByLabelText(/^incidents$/i), { target: { value: count } });
  if (note !== undefined) fireEvent.change(screen.getByLabelText(/note/i), { target: { value: note } });
  fireEvent.click(screen.getByRole('button', { name: /grant incidents/i }));
};

describe('OrgSupportIncidentsCard', () => {
  it('grants through a step-up, sending the count and trimmed note, then shows the new balance', async () => {
    render(<OrgSupportIncidentsCard org={ORG} />);
    fill('2', '  make-good after the 11-20 outage ');
    const modal = await screen.findByTestId('stepup-modal');
    expect(within(modal).getByText(/grant 2 support incidents to child co/i)).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.grantSupportIncidents).toHaveBeenCalledWith('org-2', { count: 2, note: 'make-good after the 11-20 outage', idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/) }, 'tok'));
    expect(await screen.findByText(/granted 2 incidents\. balance is now 5\./i)).toBeInTheDocument();
    expect((screen.getByLabelText(/^incidents$/i) as HTMLInputElement).value).toBe('1');
  });

  it('sends one idempotency key per submit, so a retried request cannot grant twice', async () => {
    render(<OrgSupportIncidentsCard org={ORG} />);
    fill('1');
    fireEvent.click(within(await screen.findByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.grantSupportIncidents).toHaveBeenCalledTimes(1));
    await screen.findByText(/granted 1 incident\./i);
    fill('1');
    fireEvent.click(within(await screen.findByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.grantSupportIncidents).toHaveBeenCalledTimes(2));
    const [first, second] = api.grantSupportIncidents.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey);
    expect(first).not.toBe(second);
  });

  it('a repeated grant the server recognised says nothing new was granted', async () => {
    api.grantSupportIncidents.mockResolvedValueOnce({ success: true, data: { balance: 5, accountOrgId: 'org-2', duplicate: true } });
    render(<OrgSupportIncidentsCard org={ORG} />);
    fill('2');
    fireEvent.click(within(await screen.findByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    expect(await screen.findByText(/already granted: nothing new was added\. balance is 5\./i)).toBeInTheDocument();
  });

  it('omits an empty note', async () => {
    render(<OrgSupportIncidentsCard org={ORG} />);
    fill('1', '   ');
    fireEvent.click(within(await screen.findByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.grantSupportIncidents).toHaveBeenCalledWith('org-2', { count: 1, idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/) }, 'tok'));
  });

  it.each(['0', '101', '1.5', '', 'abc'])('refuses a count of %p before any step-up (1 to 100, whole)', async (count) => {
    render(<OrgSupportIncidentsCard org={ORG} />);
    fill(count);
    expect(await screen.findByText(/whole number from 1 to 100/i)).toBeInTheDocument();
    expect(screen.queryByTestId('stepup-modal')).toBeNull();
    expect(api.grantSupportIncidents).not.toHaveBeenCalled();
  });

  it('caps the note at 500 characters (what the audit row keeps)', () => {
    render(<OrgSupportIncidentsCard org={ORG} />);
    expect(screen.getByLabelText(/note/i)).toHaveAttribute('maxLength', '500');
  });

  it('a team says the grant pools at the account root, and names the root the answer landed on', async () => {
    api.grantSupportIncidents.mockResolvedValue({ success: true, data: { balance: 3, accountOrgId: 'org-root' } });
    render(<OrgSupportIncidentsCard org={TEAM} />);
    expect(screen.getByText(/account root/i)).toBeInTheDocument();
    fill('3');
    fireEvent.click(within(await screen.findByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    expect(await screen.findByText(/held by the account root org-root/i)).toBeInTheDocument();
  });

  it.each([
    [404, 'No manageable subscription for that organization'],
    [400, 'count must be an integer in 1..100'],
    [503, "Could not resolve the organization's account; try again"],
  ])('a %s is shown with its message, and nothing reads as granted', async (status, message) => {
    api.grantSupportIncidents.mockRejectedValue(new ApiError(message, status));
    render(<OrgSupportIncidentsCard org={ORG} />);
    fill('1');
    fireEvent.click(within(await screen.findByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/balance is now/i)).toBeNull();
  });
});

describe('Org drill-down', () => {
  const renderPage = (tab: string) => {
    mockRouter({ query: { orgId: 'org-2', tab }, pathname: '/dashboard/admin/orgs/[orgId]' });
    api.getOrganization.mockResolvedValue({ success: true, data: ORG });
    return render(<OrgDetailPage />);
  };

  it('shows Support incidents on the Entitlements tab to a holder of support_cases:write', async () => {
    renderPage('entitlements');
    expect(await screen.findByRole('heading', { name: 'Support incidents' })).toBeInTheDocument();
  });

  it('hides it without support_cases:write', async () => {
    mockAuthGuard({ user: { id: 'op', organizationId: 'system' }, isSuperAdmin: true, can: (p: string) => p !== 'support_cases:write' });
    renderPage('entitlements');
    await screen.findByRole('heading', { name: 'Feature entitlements' });
    expect(screen.queryByRole('heading', { name: 'Support incidents' })).toBeNull();
  });

  it('hides it when billing is not enabled (the route is not there)', async () => {
    (globalThis as { __billing?: boolean }).__billing = false;
    renderPage('entitlements');
    await screen.findByRole('heading', { name: 'Feature entitlements' });
    expect(screen.queryByRole('heading', { name: 'Support incidents' })).toBeNull();
  });

  it('the Per-org KMS card says when a runner-key re-wrap is pending, and offers the retry', async () => {
    api.getOrgKmsConfig.mockResolvedValue({ success: true, data: { configured: true, keyId: 'alias/acme', runnerRewrapPending: true } });
    renderPage('configuration');
    expect(await screen.findByText('Runner-key re-wrap pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry re-wrap' })).toBeInTheDocument();
  });

  it('no pending notice when nothing is pending', async () => {
    api.getOrgKmsConfig.mockResolvedValue({ success: true, data: { configured: true, keyId: 'alias/acme', runnerRewrapPending: false } });
    renderPage('configuration');
    expect(await screen.findByRole('button', { name: 'Rotate / clear' })).toBeInTheDocument();
    expect(screen.queryByText('Runner-key re-wrap pending')).toBeNull();
  });
});
