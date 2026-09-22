// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only impersonation: the backend's global guard rejects every non-GET, so
 * self-service write surfaces must render their controls disabled (with the
 * reason) instead of dead-ending on a 403. Covers the SSO form and the access-key
 * section; incident reporting and DORA mark-outcome have their own suites.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OrgSsoSettings } from '../src/components/settings/OrgSsoSettings';
import { AccessKeysSection } from '../src/components/settings/AccessKeysSection';
import { ScimProvisioning } from '../src/components/settings/ScimProvisioning';

const putOwnOrgIdpConfig = jest.fn<AnyFn>();
const listAccessKeys = jest.fn<AnyFn>();
const listServiceAccounts = jest.fn<AnyFn>();
const createServiceAccountKey = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    putOwnOrgIdpConfig: (...a: unknown[]) => putOwnOrgIdpConfig(...a),
    listAccessKeys: (...a: unknown[]) => listAccessKeys(...a),
    listServiceAccounts: (...a: unknown[]) => listServiceAccounts(...a),
    createServiceAccountKey: (...a: unknown[]) => createServiceAccountKey(...a),
  },
}));
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() })));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: () => <div data-testid="stepup-modal" />,
}));
// The keys panel asks who the caller is (to decide whether to list the org's
// service-account keys as well); it needs no router here.
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule(() => ({ user: { organizationId: 'org-1' }, can: () => false })));

describe('read-only write gates', () => {
  beforeEach(() => {
    listAccessKeys.mockResolvedValue({ success: true, data: { keys: [] } });
    listServiceAccounts.mockResolvedValue({ success: true, data: { serviceAccounts: [], billing: null } });
  });

  // The page loads the config and hands it to the editor.
  const ssoConfig = {
    orgId: 'org-1', protocol: 'oidc' as const, provider: 'google' as const, clientId: 'cid', samlCertificates: [],
    allowedEmailDomains: [], enabled: true, hasClientSecret: true, updatedAt: '2026-09-01T00:00:00Z',
    samlSignAuthnRequests: false, samlEncryptAssertions: false, ssoRequired: false,
  };

  it('SSO: the whole form is disabled and explained, and submit sends nothing', async () => {
    render(<OrgSsoSettings orgId="org-1" config={ssoConfig} readOnly onSaved={jest.fn<AnyFn>()} />);
    const save = await screen.findByRole('button', { name: /save sso settings/i });
    expect(save).toBeDisabled();
    expect(screen.getByText('Read-only session')).toBeInTheDocument();
    expect(screen.getByLabelText('Provider')).toBeDisabled();
    fireEvent.submit(save.closest('form') as HTMLFormElement);
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('SSO: stays editable outside impersonation', async () => {
    render(<OrgSsoSettings orgId="org-1" config={ssoConfig} readOnly={false} onSaved={jest.fn<AnyFn>()} />);
    expect(await screen.findByRole('button', { name: /save sso settings/i })).not.toBeDisabled();
  });

  it('access keys: create is disabled with the read-only reason', async () => {
    render(<AccessKeysSection readOnly />);
    const create = screen.getByRole('button', { name: /create key/i });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', expect.stringMatching(/read-only session/i));
    await waitFor(() => expect(listAccessKeys).toHaveBeenCalled());
    fireEvent.click(create);
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
  });

  it('SCIM: the base URL is still readable, but issuing a key is disabled', async () => {
    render(<ScimProvisioning orgId="org-1" readOnly />);
    await waitFor(() => expect(listServiceAccounts).toHaveBeenCalled());

    // Reading the connector URL is not a write — an impersonating operator can
    // still see what the customer's IdP is pointed at.
    expect(screen.getByLabelText('SCIM base URL')).toHaveValue('http://localhost/api/scim/v2');
    expect(screen.getByText('Read-only session')).toBeInTheDocument();

    const issue = screen.getByRole('button', { name: /issue a scim key/i });
    expect(issue).toBeDisabled();
    fireEvent.click(issue);
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
    expect(createServiceAccountKey).not.toHaveBeenCalled();
  });
});
