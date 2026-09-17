// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only impersonation: the backend's global guard rejects every non-GET, so
 * self-service write surfaces must render their controls disabled (with the
 * reason) instead of dead-ending on a 403. Covers the SSO form and the personal
 * access token section; incident reporting and DORA mark-outcome have their own
 * suites.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OrgSsoSettings } from '../src/components/settings/OrgSsoSettings';
import { PatSection } from '../src/components/settings/PatSection';

const getOwnOrgIdpConfig = jest.fn();
const putOwnOrgIdpConfig = jest.fn();
const listPats = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    getOwnOrgIdpConfig: (...a: unknown[]) => getOwnOrgIdpConfig(...a),
    putOwnOrgIdpConfig: (...a: unknown[]) => putOwnOrgIdpConfig(...a),
    listPats: (...a: unknown[]) => listPats(...a),
  },
}));
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: () => <div data-testid="stepup-modal" />,
}));

describe('read-only write gates', () => {
  beforeEach(() => {
    getOwnOrgIdpConfig.mockResolvedValue({
      success: true,
      data: { config: { provider: 'google', clientId: 'cid', allowedEmailDomains: [], enabled: true, hasClientSecret: true, updatedAt: '2026-09-01T00:00:00Z' } },
    });
    listPats.mockResolvedValue({ success: true, data: { pats: [] } });
  });

  it('SSO: the whole form is disabled and explained, and submit sends nothing', async () => {
    render(<OrgSsoSettings orgId="org-1" readOnly />);
    await waitFor(() => expect(getOwnOrgIdpConfig).toHaveBeenCalled());
    const save = await screen.findByRole('button', { name: /save sso settings/i });
    expect(save).toBeDisabled();
    expect(screen.getByText('Read-only session')).toBeInTheDocument();
    expect(screen.getByLabelText('Provider')).toBeDisabled();
    fireEvent.submit(save.closest('form') as HTMLFormElement);
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('SSO: stays editable outside impersonation', async () => {
    render(<OrgSsoSettings orgId="org-1" readOnly={false} />);
    expect(await screen.findByRole('button', { name: /save sso settings/i })).not.toBeDisabled();
  });

  it('PAT: create is disabled with the read-only reason', async () => {
    render(<PatSection readOnly />);
    const create = screen.getByRole('button', { name: /create token/i });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', expect.stringMatching(/read-only session/i));
    await waitFor(() => expect(listPats).toHaveBeenCalled());
    fireEvent.click(create);
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
  });
});
