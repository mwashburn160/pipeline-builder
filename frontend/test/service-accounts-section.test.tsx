// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The service-accounts panel (Dashboard → Settings → Service Accounts).
 *
 * What the page has to get right is what people get wrong about machine
 * identities, so that is what is pinned here:
 *   - an account's key is shown exactly ONCE, at creation;
 *   - creating an account, issuing a key and changing roles all go through
 *     step-up — nothing is sent until the person re-confirms;
 *   - the billing rule is STATED (no seat, own token budget), not implied;
 *   - an optional IP allowlist reaches the API as a list, not a raw string;
 *   - deleting an account is confirmed first, and says how many keys die with it.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ServiceAccountsSection } from '../src/components/settings/ServiceAccountsSection';

const listServiceAccounts = jest.fn();
const getOrganizationRoles = jest.fn();
const createServiceAccount = jest.fn();
const updateServiceAccount = jest.fn();
const deleteServiceAccount = jest.fn();
const createServiceAccountKey = jest.fn();
const revokeServiceAccountKey = jest.fn();
const toastError = jest.fn();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    listServiceAccounts: (...a: unknown[]) => listServiceAccounts(...a),
    getOrganizationRoles: (...a: unknown[]) => getOrganizationRoles(...a),
    createServiceAccount: (...a: unknown[]) => createServiceAccount(...a),
    updateServiceAccount: (...a: unknown[]) => updateServiceAccount(...a),
    deleteServiceAccount: (...a: unknown[]) => deleteServiceAccount(...a),
    createServiceAccountKey: (...a: unknown[]) => createServiceAccountKey(...a),
    revokeServiceAccountKey: (...a: unknown[]) => revokeServiceAccountKey(...a),
  },
}));
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn(), error: toastError, warning: jest.fn(), info: jest.fn() }),
}));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>confirm</button>
  ),
}));

const DAY = 86_400_000;

function saKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sk1',
    name: 'prod-key',
    prefix: 'pb_sa',
    display: 'pb_sa_…c3d4',
    kind: 'service_account',
    serviceAccountId: 'sa-1',
    serviceAccountName: 'ci-deploy',
    scope: null,
    organizationId: 'org-1',
    ipAllowlist: null,
    createdAt: new Date(Date.now() - DAY).toISOString(),
    expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
    lastUsedAt: null,
    createdFrom: null,
    createdIp: null,
    revoked: false,
    status: 'active',
    neverUsed: true,
    expiringSoon: false,
    ...overrides,
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sa-1',
    organizationId: 'org-1',
    name: 'ci-deploy',
    description: 'Deploys from CI',
    roles: [{ id: 'role-1', name: 'Admin', permissions: ['pipelines:write'] }],
    permissions: ['pipelines:write'],
    tokenBudget: 1000,
    usage: { exchanges: 12, resetAt: new Date(Date.now() + 3 * DAY).toISOString() },
    disabled: false,
    createdBy: 'u1',
    createdByEmail: 'creator@example.com',
    createdAt: new Date(Date.now() - 5 * DAY).toISOString(),
    lastUsedAt: null,
    keys: [saKey()],
    seatsConsumed: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  listServiceAccounts.mockResolvedValue({
    success: true,
    data: {
      serviceAccounts: [account()],
      billing: { accounts: 1, maxAccounts: 50, seatsConsumed: 0, budgetPeriodDays: 3 },
    },
  });
  getOrganizationRoles.mockResolvedValue({
    success: true,
    data: { roles: [{ id: 'role-1', name: 'Admin', permissions: ['pipelines:write'] }] },
  });
});

describe('ServiceAccountsSection', () => {
  it('states the billing rule: no seat, own token budget', async () => {
    render(<ServiceAccountsSection orgId="org-1" readOnly={false} />);

    expect(await screen.findByText(/1 of 50 service accounts/i)).toBeInTheDocument();
    expect(screen.getAllByText(/no seat/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/refreshed every 3 days/i)).toBeInTheDocument();
    // The account's own consumption, not the org's API quota.
    expect(screen.getByText(/12 \/ 1000 token exchanges this period/i)).toBeInTheDocument();
  });

  it('creates an account through step-up, with the roles that were ticked', async () => {
    createServiceAccount.mockResolvedValue({ success: true, data: { serviceAccount: account({ id: 'sa-2' }) } });
    render(<ServiceAccountsSection orgId="org-1" readOnly={false} />);
    await waitFor(() => expect(listServiceAccounts).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'reporting-bot' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Pushes DORA events' } });
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Admin' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    // A machine credential is a durable grant — nothing is sent before step-up.
    expect(createServiceAccount).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('stepup-modal'));

    await waitFor(() => expect(createServiceAccount).toHaveBeenCalledWith(
      'org-1',
      { name: 'reporting-bot', description: 'Pushes DORA events', roleIds: ['role-1'] },
      'step-up-token',
    ));
  });

  it('rejects a name that is not a machine identifier, without calling the API', async () => {
    render(<ServiceAccountsSection orgId="org-1" readOnly={false} />);
    await waitFor(() => expect(listServiceAccounts).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Not A Name!' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    expect(toastError).toHaveBeenCalled();
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
    expect(createServiceAccount).not.toHaveBeenCalled();
  });

  it('issues a key with an IP allowlist and reveals the secret exactly once', async () => {
    createServiceAccountKey.mockResolvedValue({
      success: true,
      data: { key: 'pb_sa_SECRETVALUE', accessKey: saKey({ id: 'sk2' }) },
    });
    render(<ServiceAccountsSection orgId="org-1" readOnly={false} />);

    fireEvent.click(await screen.findByRole('button', { name: /new key/i }));
    fireEvent.change(screen.getByLabelText('Expires (days)'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('IP allowlist'), { target: { value: '203.0.113.7, 10.0.0.0/8' } });
    fireEvent.click(screen.getByRole('button', { name: /issue key/i }));
    fireEvent.click(await screen.findByTestId('stepup-modal'));

    await waitFor(() => expect(createServiceAccountKey).toHaveBeenCalledWith(
      'org-1',
      'sa-1',
      { name: 'ci-deploy-key', expiresIn: 7 * 86400, ipAllowlist: ['203.0.113.7', '10.0.0.0/8'] },
      'step-up-token',
    ));
    // Shown once, right here — it is unrecoverable afterwards.
    expect(await screen.findByText(/never shown again/i)).toBeInTheDocument();
  });

  it('refuses an out-of-range key expiry before step-up', async () => {
    render(<ServiceAccountsSection orgId="org-1" readOnly={false} />);

    fireEvent.click(await screen.findByRole('button', { name: /new key/i }));
    fireEvent.change(screen.getByLabelText('Expires (days)'), { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: /issue key/i }));

    expect(toastError).toHaveBeenCalledWith('Expiry must be 1-365 days');
    expect(createServiceAccountKey).not.toHaveBeenCalled();
  });

  it('changes a role set through step-up, sending the whole set', async () => {
    updateServiceAccount.mockResolvedValue({ success: true, data: { serviceAccount: account({ roles: [] }) } });
    render(<ServiceAccountsSection orgId="org-1" readOnly={false} />);

    // The per-account checkbox (labelled with the account) — unticking Admin
    // sends the REMAINING set, since roles are replaced as a whole.
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Admin for ci-deploy' }));
    fireEvent.click(await screen.findByTestId('stepup-modal'));

    await waitFor(() => expect(updateServiceAccount).toHaveBeenCalledWith(
      'org-1', 'sa-1', { roleIds: [] }, 'step-up-token',
    ));
  });

  it('confirms a delete and says what goes with it', async () => {
    deleteServiceAccount.mockResolvedValue({ success: true });
    render(<ServiceAccountsSection orgId="org-1" readOnly={false} />);

    fireEvent.click(await screen.findByRole('button', { name: /delete/i }));
    expect(deleteServiceAccount).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/all 1 of its keys/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    fireEvent.click(await screen.findByTestId('stepup-modal'));
    await waitFor(() => expect(deleteServiceAccount).toHaveBeenCalledWith('org-1', 'sa-1', 'step-up-token'));
  });

  it('revokes one key after confirmation, without step-up', async () => {
    revokeServiceAccountKey.mockResolvedValue({ success: true, data: { revoked: true } });
    render(<ServiceAccountsSection orgId="org-1" readOnly={false} />);

    fireEvent.click(await screen.findByRole('button', { name: /^revoke$/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /revoke key/i }));

    // Revocation only ever REMOVES access, so it is not gated behind a second
    // factor — a compromised key must be killable immediately.
    await waitFor(() => expect(revokeServiceAccountKey).toHaveBeenCalledWith('org-1', 'sa-1', 'sk1'));
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty state', async () => {
    listServiceAccounts.mockResolvedValue({ success: false });
    render(<ServiceAccountsSection orgId="org-1" readOnly={false} />);

    expect(await screen.findByText(/failed to load service accounts/i)).toBeInTheDocument();
    expect(screen.queryByText(/no service accounts yet/i)).not.toBeInTheDocument();
  });
});
