// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The access-keys panel (Dashboard → API Tokens → Access keys).
 *
 * What matters here is what the page can and cannot show: the raw key exactly
 * once at creation (it is unrecoverable afterwards), and for every existing key
 * only its masked display plus the facts an access review asks for — scope,
 * expiry, last use, where it was created, and the never-used / expiring-soon
 * flags. Creation goes through step-up; revocation is confirmed first.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AccessKeysSection } from '../src/components/settings/AccessKeysSection';

const listAccessKeys = jest.fn<AnyFn>();
const createAccessKey = jest.fn<AnyFn>();
const revokeAccessKey = jest.fn<AnyFn>();
const listServiceAccounts = jest.fn<AnyFn>();
const revokeServiceAccountKey = jest.fn<AnyFn>();
const toastError = jest.fn<AnyFn>();
// Whether the signed-in person may manage service accounts — the panel only
// lists the org's machine keys for someone who can act on them.
let canManageServiceAccounts = false;

jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    listAccessKeys: (...a: unknown[]) => listAccessKeys(...a),
    createAccessKey: (...a: unknown[]) => createAccessKey(...a),
    revokeAccessKey: (...a: unknown[]) => revokeAccessKey(...a),
    listServiceAccounts: (...a: unknown[]) => listServiceAccounts(...a),
    revokeServiceAccountKey: (...a: unknown[]) => revokeServiceAccountKey(...a),
  },
}));
jest.mock('@/hooks/useAuthGuard', () => ({
  __esModule: true,
  useAuthGuard: () => ({
    user: { organizationId: 'org-1', permissions: ['pipelines:read', 'pipelines:write', 'plugins:read'] },
    can: (p: string) => (p === 'service_accounts:manage' ? canManageServiceAccounts : true),
  }),
}));
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn<AnyFn>(), error: toastError, warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() }),
}));
// The step-up modal is exercised in its own suite; here it only needs to hand a
// token back so the create call can be asserted.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>confirm</button>
  ),
}));

const DAY = 86_400_000;

function key(overrides: Record<string, unknown> = {}) {
  return {
    id: 'k1',
    name: 'ci-deploy',
    prefix: 'pb_pat',
    display: 'pb_pat_…a1b2',
    kind: 'personal',
    serviceAccountId: null,
    serviceAccountName: null,
    scope: null,
    organizationId: 'org-1',
    ipAllowlist: null,
    createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
    expiresAt: new Date(Date.now() + 90 * DAY).toISOString(),
    lastUsedAt: new Date(Date.now() - DAY).toISOString(),
    createdFrom: 'pipeline-manager CLI on macOS',
    createdIp: '203.0.113.7',
    revoked: false,
    status: 'active',
    neverUsed: false,
    expiringSoon: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  canManageServiceAccounts = false;
  listAccessKeys.mockResolvedValue({ success: true, data: { keys: [key()] } });
  listServiceAccounts.mockResolvedValue({ success: true, data: { serviceAccounts: [], billing: null } });
});

describe('AccessKeysSection', () => {
  it('shows only the masked key, plus where it was created and when it was last used', async () => {
    render(<AccessKeysSection readOnly={false} />);

    expect(await screen.findByText('pb_pat_…a1b2')).toBeInTheDocument();
    expect(screen.getByText('ci-deploy')).toBeInTheDocument();
    expect(screen.getByText('pipeline-manager CLI on macOS')).toBeInTheDocument();
    // No scope → the column says so rather than leaving the cell blank, which
    // would read as "unknown" on a security surface.
    expect(screen.getByText('full access (your current permissions)')).toBeInTheDocument();
  });

  it('names a narrow scope', async () => {
    listAccessKeys.mockResolvedValue({ success: true, data: { keys: [key({ scope: 'reporting:ingest' })] } });
    render(<AccessKeysSection readOnly={false} />);
    expect(await screen.findByText('reporting:ingest')).toBeInTheDocument();
  });

  it('flags a key that has never been used and one expiring soon', async () => {
    listAccessKeys.mockResolvedValue({
      success: true,
      data: {
        keys: [
          key({ id: 'k1', name: 'unused', lastUsedAt: null, neverUsed: true }),
          key({ id: 'k2', name: 'ageing', expiringSoon: true }),
        ],
      },
    });
    render(<AccessKeysSection readOnly={false} />);

    expect(await screen.findByText('never used')).toBeInTheDocument();
    expect(screen.getByText('expiring soon')).toBeInTheDocument();
    expect(screen.getByText('never')).toBeInTheDocument();
  });

  it('does not flag a revoked or expired key as expiring', async () => {
    listAccessKeys.mockResolvedValue({
      success: true,
      data: { keys: [key({ status: 'revoked', revoked: true, neverUsed: true, expiringSoon: false })] },
    });
    render(<AccessKeysSection readOnly={false} />);

    expect(await screen.findByText('revoked')).toBeInTheDocument();
    expect(screen.queryByText('never used')).not.toBeInTheDocument();
    expect(screen.queryByText('expiring soon')).not.toBeInTheDocument();
    // A dead key has nothing to revoke.
    expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
  });

  it('creates through step-up and reveals the key once', async () => {
    createAccessKey.mockResolvedValue({
      success: true,
      data: { key: 'pb_pat_SECRETVALUE', accessKey: key({ id: 'k9' }) },
    });
    render(<AccessKeysSection readOnly={false} />);
    await waitFor(() => expect(listAccessKeys).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new-key' } });
    fireEvent.change(screen.getByLabelText('Expires (days)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    // Minting a durable credential is step-up gated — nothing is sent until the
    // user re-confirms.
    expect(createAccessKey).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('stepup-modal'));

    // A new key defaults to SELECTED permissions: the read-only ones held.
    await waitFor(() => expect(createAccessKey).toHaveBeenCalledWith(
      { name: 'new-key', expiresIn: 30 * 86400, permissions: ['pipelines:read', 'plugins:read'] }, 'step-up-token',
    ));
    expect(await screen.findByText('pb_pat_SECRETVALUE')).toBeInTheDocument();
  });

  it('sends a hand-picked subset, or nothing at all for full access', async () => {
    createAccessKey.mockResolvedValue({ success: true, data: { key: 'pb_pat_X', accessKey: key({ id: 'k9' }) } });
    render(<AccessKeysSection readOnly={false} />);
    await waitFor(() => expect(listAccessKeys).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByLabelText('Manage pipelines'));
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    fireEvent.click(await screen.findByTestId('stepup-modal'));
    await waitFor(() => expect(createAccessKey).toHaveBeenLastCalledWith(
      { name: 'writer', expiresIn: 90 * 86400, permissions: ['pipelines:write'] }, 'step-up-token',
    ));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'everything' } });
    fireEvent.click(screen.getByRole('button', { name: /full access/i }));
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    fireEvent.click(await screen.findByTestId('stepup-modal'));
    await waitFor(() => expect(createAccessKey).toHaveBeenLastCalledWith(
      { name: 'everything', expiresIn: 90 * 86400 }, 'step-up-token',
    ));
  });

  it('refuses an empty selection, and never offers a permission the person does not hold', async () => {
    render(<AccessKeysSection readOnly={false} />);
    await waitFor(() => expect(listAccessKeys).toHaveBeenCalled());
    expect(screen.getByLabelText('Manage billing')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'nothing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    expect(toastError).toHaveBeenCalledWith('Choose at least one permission, or full access');
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
  });

  it('shows a key\'s selected permissions in the list', async () => {
    listAccessKeys.mockResolvedValue({ success: true, data: { keys: [key({ permissions: ['pipelines:read', 'plugins:read'] })] } });
    render(<AccessKeysSection readOnly={false} />);
    expect(await screen.findByText('2 selected')).toBeInTheDocument();
    expect(screen.getByText('View pipelines, View plugins')).toBeInTheDocument();
  });

  it('refuses an out-of-range expiry without calling the API', async () => {
    render(<AccessKeysSection readOnly={false} />);
    await waitFor(() => expect(listAccessKeys).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'too-long' } });
    fireEvent.change(screen.getByLabelText('Expires (days)'), { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    expect(toastError).toHaveBeenCalledWith('Expiry must be 1–365 days');
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
    expect(createAccessKey).not.toHaveBeenCalled();
  });

  it('confirms before revoking, then revokes by key id', async () => {
    revokeAccessKey.mockResolvedValue({ success: true, data: { revoked: true } });
    render(<AccessKeysSection readOnly={false} />);

    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }));
    // A live key in CI stops working the moment this lands — never on one click.
    expect(revokeAccessKey).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /revoke key/i }));

    await waitFor(() => expect(revokeAccessKey).toHaveBeenCalledWith('k1'));
  });

  it('lists the org\'s service-account keys alongside the personal ones, labelled by owner', async () => {
    canManageServiceAccounts = true;
    listServiceAccounts.mockResolvedValue({
      success: true,
      data: {
        serviceAccounts: [{
          id: 'sa-1',
          name: 'ci-deploy',
          keys: [key({
            id: 'sk1', name: 'prod-key', prefix: 'pb_sa', display: 'pb_sa_…c3d4',
            kind: 'service_account', serviceAccountId: 'sa-1', serviceAccountName: 'ci-deploy',
          })],
        }],
        billing: null,
      },
    });
    render(<AccessKeysSection readOnly={false} />);

    expect(await screen.findByText('pb_sa_…c3d4')).toBeInTheDocument();
    // The owner has to be on the row: a machine key revoked by mistake takes a
    // pipeline down, and "whose key is this" is the question being asked.
    expect(screen.getByText('(service account: ci-deploy)')).toBeInTheDocument();
    // The person's own key is still there — one list, both kinds.
    expect(screen.getByText('pb_pat_…a1b2')).toBeInTheDocument();
  });

  it('revokes a service-account key through its owning account', async () => {
    canManageServiceAccounts = true;
    listAccessKeys.mockResolvedValue({ success: true, data: { keys: [] } });
    listServiceAccounts.mockResolvedValue({
      success: true,
      data: {
        serviceAccounts: [{
          id: 'sa-1',
          name: 'ci-deploy',
          keys: [key({ id: 'sk1', name: 'prod-key', kind: 'service_account', serviceAccountId: 'sa-1', serviceAccountName: 'ci-deploy' })],
        }],
        billing: null,
      },
    });
    revokeServiceAccountKey.mockResolvedValue({ success: true, data: { revoked: true } });
    render(<AccessKeysSection readOnly={false} />);

    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /revoke key/i }));

    // Org property → the org's route, not the personal one.
    await waitFor(() => expect(revokeServiceAccountKey).toHaveBeenCalledWith('org-1', 'sa-1', 'sk1'));
    expect(revokeAccessKey).not.toHaveBeenCalled();
  });

  it('does not ask for service-account keys when the caller cannot manage them', async () => {
    render(<AccessKeysSection readOnly={false} />);
    await waitFor(() => expect(listAccessKeys).toHaveBeenCalled());
    expect(listServiceAccounts).not.toHaveBeenCalled();
  });

  it('still shows the personal keys when the service-account load fails', async () => {
    canManageServiceAccounts = true;
    listServiceAccounts.mockRejectedValue(new Error('boom'));
    render(<AccessKeysSection readOnly={false} />);

    // The person's own credentials are the load-bearing part of this page.
    expect(await screen.findByText('pb_pat_…a1b2')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty state', async () => {
    // An unsuccessful envelope, the shape the component turns into a throw.
    listAccessKeys.mockResolvedValue({ success: false });
    render(<AccessKeysSection readOnly={false} />);

    // A false-empty on a credential list would read as "this account holds no
    // live keys", which is exactly the wrong conclusion to draw from an outage.
    expect(await screen.findByText(/failed to load access keys/i)).toBeInTheDocument();
    expect(screen.queryByText(/no access keys yet/i)).not.toBeInTheDocument();
  });
});
