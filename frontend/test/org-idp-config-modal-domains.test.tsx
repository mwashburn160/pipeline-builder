// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The sysadmin IdP modal picks the connection's email domains from the org's
 * VERIFIED domains (the server refuses any other), instead of free text.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OrgIdpConfigModal } from '../src/components/admin/OrgIdpConfigModal';

const getOrgIdpConfig = jest.fn();
const listOrgDomains = jest.fn();
const patchOrgIdpConfig = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOrgIdpConfig: (...a: unknown[]) => getOrgIdpConfig(...a),
    listOrgDomains: (...a: unknown[]) => listOrgDomains(...a),
    patchOrgIdpConfig: (...a: unknown[]) => patchOrgIdpConfig(...a),
    putOrgIdpConfig: jest.fn(),
    deleteOrgIdpConfig: jest.fn(),
  },
  ApiError: class ApiError extends Error { statusCode = 0; },
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
    render(<OrgIdpConfigModal org={org} onClose={jest.fn()} />);

    const acme = await screen.findByRole('checkbox', { name: /acme\.io/ });
    const dev = screen.getByRole('checkbox', { name: /acme\.dev/ });
    expect(acme).toBeChecked();
    expect(dev).not.toBeChecked();
    expect(screen.queryByText(/pending\.io/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/example\.com/)).not.toBeInTheDocument();

    fireEvent.click(dev);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patchOrgIdpConfig).toHaveBeenCalled());
    expect(patchOrgIdpConfig.mock.calls[0][1].allowedEmailDomains).toEqual(['acme.io', 'acme.dev']);
  });
});
