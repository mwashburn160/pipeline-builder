// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org's own OIDC connection editor and its disconnect control.
 *
 *   - CREATE goes through PUT (the full body); an EXISTING connection is edited
 *     with PATCH carrying only what changed, and a save with no changes sends
 *     nothing at all.
 *   - Every write goes through ONE strong-factor step-up dialog, and its token
 *     rides the request.
 *   - A secret is demanded only until one is on file.
 *   - Disconnect confirms first (in that same dialog), states what members will
 *     experience, and only then calls DELETE.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OrgSsoSettings } from '../src/components/settings/OrgSsoSettings';
import { SsoDisconnect } from '../src/components/settings/SsoDisconnect';
import type { OrgIdpConfigDto } from '../src/types';

const putOwnOrgIdpConfig = jest.fn();
const patchOwnOrgIdpConfig = jest.fn();
const deleteOwnOrgIdpConfig = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    putOwnOrgIdpConfig: (...a: unknown[]) => putOwnOrgIdpConfig(...a),
    patchOwnOrgIdpConfig: (...a: unknown[]) => patchOwnOrgIdpConfig(...a),
    deleteOwnOrgIdpConfig: (...a: unknown[]) => deleteOwnOrgIdpConfig(...a),
  },
}));
// The step-up dialog is exercised in its own suite; here it confirms with a
// fixed token (and renders what it was given, so the consequences are visible).
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, onClose, details, requireStrongFactor }: {
    onConfirmed: (t: string) => void; onClose: () => void; details?: React.ReactNode; requireStrongFactor?: boolean;
  }) => (
    <div data-testid="stepup-modal" data-strong={String(!!requireStrongFactor)}>
      {details}
      <button type="button" onClick={() => onConfirmed('tok')}>Verify</button>
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
  ),
}));
const toastSuccess = jest.fn();
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: toastSuccess, error: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));

const stored: OrgIdpConfigDto = {
  orgId: 'org-1',
  protocol: 'oidc',
  provider: 'generic-oidc',
  clientId: 'cid',
  hasClientSecret: true,
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  samlCertificates: [],
  allowedEmailDomains: [],
  enabled: true,
  updatedAt: '2026-09-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  putOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: stored } });
  patchOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: { ...stored, enabled: false } } });
  deleteOwnOrgIdpConfig.mockResolvedValue({ success: true, data: {} });
});

describe('OrgSsoSettings', () => {
  it('creates a new connection with PUT, secret included', async () => {
    const onSaved = jest.fn();
    render(<OrgSsoSettings orgId="org-1" config={null} readOnly={false} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByLabelText(/Client Secret/), { target: { value: 's3cret' } });
    fireEvent.change(screen.getByLabelText('Discovery URL'), { target: { value: stored.discoveryUrl } });

    fireEvent.click(screen.getByRole('button', { name: /Create SSO config/i }));
    // Nothing is sent until the strong factor is given.
    expect(screen.getByTestId('stepup-modal')).toHaveAttribute('data-strong', 'true');
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(putOwnOrgIdpConfig).toHaveBeenCalled());

    const [orgId, body, token] = putOwnOrgIdpConfig.mock.calls[0] as [string, Record<string, unknown>, string];
    expect(orgId).toBe('org-1');
    expect(token).toBe('tok');
    expect(body).toMatchObject({ provider: 'generic-oidc', clientId: 'cid', clientSecret: 's3cret', discoveryUrl: stored.discoveryUrl });
    expect(patchOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(stored);
  });

  it('refuses to create without a secret', async () => {
    render(<OrgSsoSettings orgId="org-1" config={null} readOnly={false} onSaved={jest.fn()} />);
    expect(screen.getByRole('button', { name: /Create SSO config/i })).toBeDisabled();
  });

  it('edits an existing connection with PATCH, sending only the changed field (no secret)', async () => {
    const onSaved = jest.fn();
    render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('checkbox'));

    fireEvent.click(screen.getByRole('button', { name: /Save SSO settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(patchOwnOrgIdpConfig).toHaveBeenCalled());

    expect(patchOwnOrgIdpConfig).toHaveBeenCalledWith('org-1', { enabled: false }, 'tok');
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith({ ...stored, enabled: false });
  });

  it('sends a typed secret as a rotation', async () => {
    render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={jest.fn()} />);
    fireEvent.change(screen.getByLabelText(/Client Secret/), { target: { value: 'rotated' } });
    fireEvent.click(screen.getByRole('button', { name: /Save SSO settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(patchOwnOrgIdpConfig).toHaveBeenCalledWith('org-1', { clientSecret: 'rotated' }, 'tok'));
  });

  it('sends nothing when nothing changed', async () => {
    render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Save SSO settings/i }));

    expect(await screen.findByText(/No changes to save/i)).toBeInTheDocument();
    // Not even a step-up prompt for a no-op.
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
    expect(patchOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('resets to the empty create form when the connection goes away', () => {
    const { rerender } = render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={jest.fn()} />);
    expect(screen.getByLabelText('Client ID')).toHaveValue('cid');

    rerender(<OrgSsoSettings orgId="org-1" config={null} readOnly={false} onSaved={jest.fn()} />);
    expect(screen.getByLabelText('Client ID')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Create SSO config/i })).toBeInTheDocument();
  });
});

describe('SsoDisconnect', () => {
  it('confirms with the consequences before deleting', async () => {
    const onDisconnected = jest.fn();
    render(<SsoDisconnect orgId="org-1" config={stored} readOnly={false} onDisconnected={onDisconnected} />);

    fireEvent.click(screen.getByRole('button', { name: /Disconnect SSO/i }));
    expect(screen.getByText(/fall back to their other sign-in methods/i)).toBeInTheDocument();
    expect(deleteOwnOrgIdpConfig).not.toHaveBeenCalled();

    expect(screen.getByTestId('stepup-modal')).toHaveAttribute('data-strong', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(deleteOwnOrgIdpConfig).toHaveBeenCalledWith('org-1', 'tok'));
    expect(onDisconnected).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('SSO disconnected');
  });

  it('cancelling deletes nothing', () => {
    render(<SsoDisconnect orgId="org-1" config={stored} readOnly={false} onDisconnected={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Disconnect SSO/i }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(deleteOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('keeps the connection and says why when the delete fails', async () => {
    deleteOwnOrgIdpConfig.mockRejectedValue(new Error('step-up refused'));
    const onDisconnected = jest.fn();
    render(<SsoDisconnect orgId="org-1" config={stored} readOnly={false} onDisconnected={onDisconnected} />);
    fireEvent.click(screen.getByRole('button', { name: /Disconnect SSO/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText(/step-up refused/)).toBeInTheDocument();
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('is disabled for a read-only session', () => {
    render(<SsoDisconnect orgId="org-1" config={stored} readOnly onDisconnected={jest.fn()} />);
    expect(screen.getByRole('button', { name: /Disconnect SSO/i })).toBeDisabled();
  });
});
