// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SSO editors PATCH only what changed. The diff must treat the editors'
 * "clear" (`''`) and the stored config's "absent" as the same thing — or every
 * save would re-send untouched fields — and must send a client secret exactly
 * when one was typed, since the stored config never carries it.
 */

import { describe, it, expect } from '@jest/globals';
import { changedIdpFields } from '../src/components/settings/idp-diff';
import type { OrgIdpConfigDto } from '../src/types';

const stored: OrgIdpConfigDto = {
  orgId: 'org-1',
  protocol: 'oidc',
  provider: 'generic-oidc',
  clientId: 'cid',
  hasClientSecret: true,
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  samlCertificates: [],
  samlAttributes: { email: 'mail' },
  allowedEmailDomains: ['acme.io'],
  enabled: true,
  // Added to the DTO by the SAML hardening (SLO, assertion encryption) and the
  // SSO-required policy; off here, as on a freshly configured OIDC connection.
  samlSignAuthnRequests: false,
  samlEncryptAssertions: false,
  ssoRequired: false,
  updatedAt: '2026-09-01T00:00:00Z',
};

describe('changedIdpFields', () => {
  it('is empty when every field matches, empty strings standing in for absent', () => {
    expect(changedIdpFields(stored, {
      provider: 'generic-oidc',
      clientId: 'cid',
      discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
      groupsClaim: '', // stored has none
      allowedEmailDomains: ['acme.io'],
      samlAttributes: { email: 'mail', name: '', groups: '' },
      enabled: true,
    })).toEqual({});
  });

  it('returns only the fields that changed', () => {
    expect(changedIdpFields(stored, {
      clientId: 'cid',
      allowedEmailDomains: ['acme.io', 'acme.dev'],
      enabled: false,
    })).toEqual({ allowedEmailDomains: ['acme.io', 'acme.dev'], enabled: false });
  });

  it('sends an explicit clear when a stored value is emptied', () => {
    expect(changedIdpFields({ ...stored, groupsClaim: 'roles' }, { groupsClaim: '' })).toEqual({ groupsClaim: '' });
  });

  it('includes a client secret only when one was typed', () => {
    expect(changedIdpFields(stored, { clientSecret: '' })).toEqual({});
    expect(changedIdpFields(stored, { clientSecret: '   ' })).toEqual({});
    expect(changedIdpFields(stored, { clientSecret: 'rotated' })).toEqual({ clientSecret: 'rotated' });
  });

  it('ignores fields the editor does not own (undefined)', () => {
    expect(changedIdpFields(stored, { protocol: undefined, samlEntityId: undefined })).toEqual({});
  });

  it('treats a reordered certificate list as a change (rotation order matters)', () => {
    const saml = { ...stored, protocol: 'saml' as const, samlCertificates: ['A', 'B'] };
    expect(changedIdpFields(saml, { samlCertificates: ['B', 'A'] })).toEqual({ samlCertificates: ['B', 'A'] });
  });
});
