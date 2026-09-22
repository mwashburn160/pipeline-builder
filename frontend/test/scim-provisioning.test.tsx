// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SCIM provisioning panel (Dashboard → Settings → Single Sign-On).
 *
 * Two things an admin has to hand their identity provider — a base URL and a
 * bearer token — so what is pinned here is that both come out right:
 *   - the base URL is the one the API actually serves, copyable;
 *   - "Issue a SCIM key" goes through step-up, creates the dedicated service
 *     account on FIRST use only, and mints the key with the `scim` scope;
 *   - the raw key is shown exactly once, at creation;
 *   - the list shows only `scim`-scoped keys, whichever account holds them, so
 *     an unrelated CI key never reads as a provisioning credential;
 *   - revoking is confirmed first, and says that nobody is deactivated by it.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ScimProvisioning } from '../src/components/settings/ScimProvisioning';

const listServiceAccounts = jest.fn<AnyFn>();
const createServiceAccount = jest.fn<AnyFn>();
const createServiceAccountKey = jest.fn<AnyFn>();
const revokeServiceAccountKey = jest.fn<AnyFn>();
const toastError = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    listServiceAccounts: (...a: unknown[]) => listServiceAccounts(...a),
    createServiceAccount: (...a: unknown[]) => createServiceAccount(...a),
    createServiceAccountKey: (...a: unknown[]) => createServiceAccountKey(...a),
    revokeServiceAccountKey: (...a: unknown[]) => revokeServiceAccountKey(...a),
  },
}));
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: jest.fn<AnyFn>(), error: toastError, warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() })));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  // Mirrors the real dialog: confirm, then close itself.
  StepUpModal: ({ onConfirmed, onClose, action }: { onConfirmed: (t: string) => Promise<void> | void; onClose: () => void; action: string }) => (
    <button data-testid="stepup-modal" data-action={action} onClick={async () => {
      await onConfirmed(`token-for:${action}`);
      onClose();
    }}>confirm</button>
  ),
}));

const DAY = 86_400_000;

function key(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sk1',
    name: 'scim-2026-09-18',
    prefix: 'pb_sa',
    display: 'pb_sa_…c3d4',
    kind: 'service_account',
    serviceAccountId: 'sa-scim',
    serviceAccountName: 'scim-provisioning',
    scope: 'scim',
    organizationId: 'org-1',
    ipAllowlist: null,
    createdAt: new Date(Date.now() - DAY).toISOString(),
    expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
    lastUsedAt: null,
    createdFrom: null,
    createdIp: null,
    revoked: false,
    status: 'active',
    neverUsed: true,
    ...overrides,
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sa-scim',
    organizationId: 'org-1',
    name: 'scim-provisioning',
    description: null,
    roles: [],
    permissions: [],
    tokenBudget: -1,
    usage: { exchanges: 0, resetAt: new Date().toISOString() },
    disabled: false,
    createdBy: null,
    createdByEmail: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    keys: [],
    seatsConsumed: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  listServiceAccounts.mockResolvedValue({ success: true, data: { serviceAccounts: [], billing: null } });
});

it('shows the base URL the API actually serves', async () => {
  render(<ScimProvisioning orgId="org-1" readOnly={false} />);
  await waitFor(() => expect(listServiceAccounts).toHaveBeenCalledWith('org-1'));
  // jsdom's origin. The path is what routes/scim.ts mounts behind nginx's /api.
  expect(screen.getByLabelText('SCIM base URL')).toHaveValue('http://localhost/api/scim/v2');
});

it('creates the dedicated account on FIRST use and mints a scim-scoped key — each with its OWN step-up', async () => {
  createServiceAccount.mockResolvedValue({ success: true, data: { serviceAccount: account() } });
  createServiceAccountKey.mockResolvedValue({ success: true, data: { key: 'pb_sa_rawsecret', accessKey: key() } });

  render(<ScimProvisioning orgId="org-1" readOnly={false} />);
  await waitFor(() => expect(listServiceAccounts).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /issue a scim key/i }));

  // Nothing is sent until the person re-confirms — a key mint is step-up gated.
  expect(createServiceAccountKey).not.toHaveBeenCalled();
  const first = await screen.findByTestId('stepup-modal');
  expect(first.getAttribute('data-action')).toMatch(/service account/i);
  fireEvent.click(first);

  await waitFor(() => expect(createServiceAccount).toHaveBeenCalled());
  expect(createServiceAccount).toHaveBeenCalledWith(
    'org-1',
    expect.objectContaining({ name: 'scim-provisioning', roleIds: [] }),
    'token-for:Create the SCIM provisioning service account',
  );
  // A step-up token is single-use: the key mint asks again rather than
  // replaying the one the account creation spent (STEP_UP_REPLAY).
  expect(createServiceAccountKey).not.toHaveBeenCalled();
  const second = await screen.findByTestId('stepup-modal');
  await waitFor(() => expect(second.getAttribute('data-action')).toBe('Issue a SCIM provisioning key'));
  fireEvent.click(screen.getByTestId('stepup-modal'));

  await waitFor(() => expect(createServiceAccountKey).toHaveBeenCalled());
  expect(createServiceAccountKey).toHaveBeenCalledWith(
    'org-1',
    'sa-scim',
    expect.objectContaining({ scope: 'scim', expiresIn: 365 * 86400 }),
    'token-for:Issue a SCIM provisioning key',
  );
  // Shown exactly once, at creation.
  expect(await screen.findByText('pb_sa_rawsecret')).toBeInTheDocument();
});

it('reuses the existing account rather than creating a second one', async () => {
  listServiceAccounts.mockResolvedValue({ success: true, data: { serviceAccounts: [account()], billing: null } });
  createServiceAccountKey.mockResolvedValue({ success: true, data: { key: 'pb_sa_x', accessKey: key() } });

  render(<ScimProvisioning orgId="org-1" readOnly={false} />);
  await waitFor(() => expect(listServiceAccounts).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /issue a scim key/i }));
  fireEvent.click(await screen.findByTestId('stepup-modal'));

  await waitFor(() => expect(createServiceAccountKey).toHaveBeenCalled());
  expect(createServiceAccount).not.toHaveBeenCalled();
});

it('lists only scim-scoped keys, and revoking is confirmed first', async () => {
  listServiceAccounts.mockResolvedValue({
    success: true,
    data: {
      serviceAccounts: [
        account({ keys: [key()] }),
        // An unrelated CI key must not read as a provisioning credential.
        account({ id: 'sa-ci', name: 'ci-deploy', keys: [key({ id: 'sk2', name: 'ci-push', scope: 'registry:push' })] }),
      ],
      billing: null,
    },
  });
  revokeServiceAccountKey.mockResolvedValue({ success: true, data: { revoked: true } });

  render(<ScimProvisioning orgId="org-1" readOnly={false} />);
  expect(await screen.findByText('scim-2026-09-18')).toBeInTheDocument();
  expect(screen.queryByText('ci-push')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }));
  // Nothing is revoked until the dialog is confirmed, and it states that
  // revoking a key deactivates nobody.
  expect(revokeServiceAccountKey).not.toHaveBeenCalled();
  expect(screen.getByText(/existing members keep their access/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /revoke key/i }));
  await waitFor(() => expect(revokeServiceAccountKey).toHaveBeenCalledWith('org-1', 'sa-scim', 'sk1'));
});

it('refuses a lifetime outside the 1-365 day range before sending anything', async () => {
  render(<ScimProvisioning orgId="org-1" readOnly={false} />);
  await waitFor(() => expect(listServiceAccounts).toHaveBeenCalled());

  fireEvent.change(screen.getByLabelText(/key lifetime/i), { target: { value: '400' } });
  fireEvent.click(screen.getByRole('button', { name: /issue a scim key/i }));

  expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/1-365 days/));
  expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
});
