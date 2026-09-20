// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { IdpProtocol, IdpProvider, SamlAttributeMapping } from '@/types';

/**
 * Provider PRESETS for the SSO setup wizard — what to pre-select and what to
 * tell the administrator, per identity provider. A preset never writes anything
 * the admin can't see: it fills defaults (the OIDC provider type, the SAML
 * attribute names) and names the console screens the values go into. The
 * matching walkthroughs are in docs/authentication.md.
 */
export interface SsoProviderPreset {
  id: string;
  label: string;
  protocol: IdpProtocol;
  /** OIDC: the provider type to select. */
  oidcProvider?: IdpProvider;
  /** SAML: attribute names this IdP sends by default. */
  samlAttributes?: SamlAttributeMapping;
  /** One-line pointer to where the values go at the IdP. */
  hint: string;
}

const SSO_PRESETS: readonly SsoProviderPreset[] = [
  {
    id: 'okta-oidc',
    label: 'Okta',
    protocol: 'oidc',
    oidcProvider: 'generic-oidc',
    hint: 'Okta admin console → Applications → Create App Integration → OIDC, Web Application. Paste the redirect URI below as a Sign-in redirect URI; the discovery URL is https://<your-okta-domain>/.well-known/openid-configuration.',
  },
  {
    id: 'entra-oidc',
    label: 'Microsoft Entra ID',
    protocol: 'oidc',
    oidcProvider: 'generic-oidc',
    hint: 'Entra admin center → App registrations → New registration (Web). Add the redirect URI below; the discovery URL is https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration. Groups arrive in the "groups" claim once group claims are enabled.',
  },
  {
    id: 'google-oidc',
    label: 'Google',
    protocol: 'oidc',
    oidcProvider: 'google',
    hint: 'Google Cloud console → APIs & Services → Credentials → OAuth client ID (Web application). Add the redirect URI below. Google issues no group claims.',
  },
  {
    id: 'cognito-oidc',
    label: 'AWS Cognito',
    protocol: 'oidc',
    oidcProvider: 'cognito',
    hint: 'Cognito user pool → App integration → App client with a client secret. Add the redirect URI below as an allowed callback URL; groups arrive in "cognito:groups".',
  },
  {
    id: 'generic-oidc',
    label: 'Other OpenID Connect provider',
    protocol: 'oidc',
    oidcProvider: 'generic-oidc',
    hint: 'Create a confidential web client, register the redirect URI below, and paste the issuer\'s /.well-known/openid-configuration URL.',
  },
  {
    id: 'okta-saml',
    label: 'Okta',
    protocol: 'saml',
    samlAttributes: { email: 'email', name: 'displayName', groups: 'groups' },
    hint: 'Okta admin console → Applications → Create App Integration → SAML 2.0. Single sign-on URL = ACS URL, Audience URI = SP entity ID. Then import the app\'s metadata URL (Sign On tab) below.',
  },
  {
    id: 'entra-saml',
    label: 'Microsoft Entra ID',
    protocol: 'saml',
    samlAttributes: {
      email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      name: 'http://schemas.microsoft.com/identity/claims/displayname',
      groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
    },
    hint: 'Entra admin center → Enterprise applications → New application → Create your own → Non-gallery. Single sign-on → SAML: upload the SP metadata (or enter Identifier = SP entity ID, Reply URL = ACS URL, Logout URL = SLO URL). Then import the App Federation Metadata Url below.',
  },
  {
    id: 'google-saml',
    label: 'Google Workspace',
    protocol: 'saml',
    samlAttributes: { email: 'email', name: 'name', groups: 'groups' },
    hint: 'Google Admin console → Apps → Web and mobile apps → Add custom SAML app. ACS URL and Entity ID from below. Download the IdP metadata and upload it here. Google Workspace has no single-logout endpoint.',
  },
  {
    id: 'generic-saml',
    label: 'Other SAML 2.0 provider',
    protocol: 'saml',
    hint: 'Import this SP\'s metadata at the IdP (or enter the ACS URL and entity ID by hand), then import the IdP\'s metadata here.',
  },
];

export function presetsFor(protocol: IdpProtocol): SsoProviderPreset[] {
  return SSO_PRESETS.filter((p) => p.protocol === protocol);
}

export function findPreset(id: string | null | undefined): SsoProviderPreset | undefined {
  return SSO_PRESETS.find((p) => p.id === id);
}
