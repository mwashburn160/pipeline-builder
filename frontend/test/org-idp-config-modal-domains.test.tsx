// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The sysadmin IdP modal picks the connection's email domains from the org's
 * VERIFIED domains (the server refuses any other), instead of free text.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OrgIdpConfigModal } from '../src/components/admin/OrgIdpConfigModal';

const getOrgIdpConfig = jest.fn<AnyFn>();
const listOrgDomains = jest.fn<AnyFn>();
const patchOrgIdpConfig = jest.fn<AnyFn>();
const putOrgIdpConfig = jest.fn<AnyFn>();
const toastWarning = jest.fn<AnyFn>();
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: toastWarning, info: jest.fn<AnyFn>() })));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOrgIdpConfig: (...a: unknown[]) => getOrgIdpConfig(...a),
    listOrgDomains: (...a: unknown[]) => listOrgDomains(...a),
    patchOrgIdpConfig: (...a: unknown[]) => patchOrgIdpConfig(...a),
    putOrgIdpConfig: (...a: unknown[]) => putOrgIdpConfig(...a),
    deleteOrgIdpConfig: jest.fn<AnyFn>(),
  },
  ApiError: class ApiError extends Error { statusCode = 0; },
}));

// The strong-factor step-up confirms the write and hands over its token.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, requireStrongFactor }: { onConfirmed: (t: string) => void; requireStrongFactor?: boolean }) => (
    <button data-strong={String(!!requireStrongFactor)} onClick={() => onConfirmed('step-up-token')}>confirm step-up</button>
  ),
}));

const org = { id: 'org-1', name: 'Acme' } as never;

beforeEach(() => {
  jest.clearAllMocks();
  getOrgIdpConfig.mockResolvedValue({
    success: true,
    data: {
      config: {
        provider: 'google', clientId: 'cid', allowedEmailDomains: ['acme.io'], enabled: true,
        hasClientSecret: true, updatedAt: '2026-09-01T00:00:00.000Z',
      },
    },
  });
  listOrgDomains.mockResolvedValue({
    success: true,
    data: {
      domains: [
        { domain: 'acme.io', verified: true },
        { domain: 'acme.dev', verified: true },
        { domain: 'pending.io', verified: false },
      ],
    },
  });
  patchOrgIdpConfig.mockResolvedValue({ success: true });
});

describe('OrgIdpConfigModal — verified-domain picker', () => {
  it('offers only verified domains, pre-checks the saved ones, and saves the selection', async () => {
    render(<OrgIdpConfigModal org={org} onClose={jest.fn<AnyFn>()} />);

    const acme = await screen.findByRole('checkbox', { name: /acme\.io/ });
    const dev = screen.getByRole('checkbox', { name: /acme\.dev/ });
    expect(acme).toBeChecked();
    expect(dev).not.toBeChecked();
    expect(screen.queryByText(/pending\.io/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/example\.com/)).not.toBeInTheDocument();

    fireEvent.click(dev);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // Step-up FIRST: nothing is sent until the strong factor confirms.
    expect(patchOrgIdpConfig).not.toHaveBeenCalled();
    const stepUp = await screen.findByRole('button', { name: 'confirm step-up' });
    expect(stepUp.getAttribute('data-strong')).toBe('true');
    fireEvent.click(stepUp);

    await waitFor(() => expect(patchOrgIdpConfig).toHaveBeenCalled());
    expect(patchOrgIdpConfig.mock.calls[0][1].allowedEmailDomains).toEqual(['acme.io', 'acme.dev']);
    expect(patchOrgIdpConfig.mock.calls[0][2]).toBe('step-up-token');
  });
});

const WARNING = { code: 'IDP_GOOGLE_NO_VERIFIED_DOMAIN', message: 'No verified domain: Google sign-in admits existing members only.' };

describe('OrgIdpConfigModal — save warnings', () => {
  async function saveExisting() {
    const onClose = jest.fn<AnyFn>();
    render(<OrgIdpConfigModal org={org} onClose={onClose} />);
    await screen.findByRole('checkbox', { name: /acme\.io/ });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'confirm step-up' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  }

  it('toasts a warning the PATCH returned (the save still succeeds)', async () => {
    patchOrgIdpConfig.mockResolvedValue({ success: true, data: { config: {}, warnings: [WARNING] } });
    await saveExisting();
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalledWith(WARNING.message);
  });

  it('raises no warning when the PATCH carries none', async () => {
    await saveExisting();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('toasts a warning the create (PUT) returned', async () => {
    getOrgIdpConfig.mockResolvedValue({ success: true, data: { config: null } });
    putOrgIdpConfig.mockResolvedValue({ success: true, data: { config: {}, warnings: [WARNING] } });
    const onClose = jest.fn<AnyFn>();
    render(<OrgIdpConfigModal org={org} onClose={onClose} />);
    await screen.findByRole('checkbox', { name: /acme\.io/ });
    fireEvent.change(screen.getByLabelText(/Client ID/i), { target: { value: 'cid' } });
    fireEvent.change(screen.getByLabelText(/Client secret/i), { target: { value: 'sec' } });
    fireEvent.change(screen.getByLabelText(/Discovery URL/i), { target: { value: 'https://idp.example.com/.well-known/openid-configuration' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create|Save/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'confirm step-up' }));
    await waitFor(() => expect(putOrgIdpConfig).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalledWith(WARNING.message);
  });
});
