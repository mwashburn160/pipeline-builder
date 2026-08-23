// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DomainJoinSettings } from '../src/components/settings/DomainJoinSettings';

jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));

const listOrgDomains = jest.fn();
const listOrgJoinRequests = jest.fn();
const addOrgDomain = jest.fn();
const verifyOrgDomain = jest.fn();
const deleteOrgDomain = jest.fn();
const decideOrgJoinRequest = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listOrgDomains: (...a: unknown[]) => listOrgDomains(...a),
    listOrgJoinRequests: (...a: unknown[]) => listOrgJoinRequests(...a),
    addOrgDomain: (...a: unknown[]) => addOrgDomain(...a),
    verifyOrgDomain: (...a: unknown[]) => verifyOrgDomain(...a),
    deleteOrgDomain: (...a: unknown[]) => deleteOrgDomain(...a),
    decideOrgJoinRequest: (...a: unknown[]) => decideOrgJoinRequest(...a),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  listOrgDomains.mockResolvedValue({ success: true, data: { domains: [], entitled: true } });
  listOrgJoinRequests.mockResolvedValue({ success: true, data: { requests: [] } });
});

describe('DomainJoinSettings', () => {
  it('shows the empty state once loaded', async () => {
    render(<DomainJoinSettings orgId="org-1" />);
    expect(await screen.findByText(/No domains registered yet/i)).toBeInTheDocument();
  });

  it('shows an upgrade note (and no Add form) when not entitled', async () => {
    listOrgDomains.mockResolvedValue({ success: true, data: { domains: [], entitled: false } });
    render(<DomainJoinSettings orgId="org-1" />);
    expect(await screen.findByText(/Upgrade to the Team or Enterprise tier/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('acme.com')).not.toBeInTheDocument();
  });

  it('deletes a domain only after confirmation', async () => {
    listOrgDomains.mockResolvedValue({ success: true, data: { domains: [{ id: 'd1', domain: 'acme.com', verified: true, autoJoin: 'off' }], entitled: true } });
    deleteOrgDomain.mockResolvedValue({ success: true, data: { deleted: true } });
    render(<DomainJoinSettings orgId="org-1" />);

    fireEvent.click(await screen.findByLabelText('Delete acme.com'));
    // Not deleted yet — the confirm modal must be acknowledged first.
    expect(deleteOrgDomain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deleteOrgDomain).toHaveBeenCalledWith('org-1', 'd1'));
  });

  it('approves a pending join request', async () => {
    listOrgJoinRequests.mockResolvedValue({ success: true, data: { requests: [{ id: 'r1', userId: 'u1', email: 'jane@acme.com', requestedAt: '2026-01-01' }] } });
    decideOrgJoinRequest.mockResolvedValue({ success: true, data: { userId: 'u1', status: 'approved' } });
    render(<DomainJoinSettings orgId="org-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(decideOrgJoinRequest).toHaveBeenCalledWith('org-1', 'r1', 'approve'));
  });
});
