// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Security page's address book.
 *
 * Personal factors, sessions, access keys and the org's service accounts used to
 * live on four pages that pointed at each other ("the real one is over there"),
 * and the prompts that send someone to enrol — the MFA banner, the MFA dialog,
 * the step-up modal, the bootstrap-admin sign-in, the device-approval page — each
 * spelled their own `?tab=…#…` link. One of those tabs no longer existed, and
 * nothing failed loudly when a link named a section on the wrong tab.
 *
 * So the routes live here, once: the tab ids the page renders, which section
 * belongs to which tab (`SECURITY_HASH_TABS`, consumed by `useUrlTab` so a
 * fragment opens the tab that actually renders it), and a named link per
 * destination. A link and the page can no longer disagree — a test asserts every
 * href here resolves to a real tab.
 */

/** Sub-tabs of /dashboard/security, in the order they are shown. */
export const SECURITY_TABS = [
  { id: 'factors', label: 'Factors' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'keys', label: 'Access keys' },
  { id: 'service-accounts', label: 'Service accounts' },
] as const;

export type SecurityTab = (typeof SECURITY_TABS)[number]['id'];

export const SECURITY_TAB_IDS = SECURITY_TABS.map((t) => t.id) as readonly SecurityTab[];

/** Anchor id → the tab that renders it. */
export const SECURITY_HASH_TABS: Readonly<Record<string, SecurityTab>> = {
  password: 'factors',
  passkeys: 'factors',
  totp: 'factors',
  devices: 'sessions',
  'current-token': 'sessions',
  'access-keys': 'keys',
  'service-accounts': 'service-accounts',
};

export const SECURITY_HREF = '/dashboard/security';

/** Add a passkey (the first thing every enrolment prompt points at). */
export const PASSKEY_ENROLMENT_HREF = `${SECURITY_HREF}?tab=factors#passkeys`;

/** Set up an authenticator app. */
export const TOTP_ENROLMENT_HREF = `${SECURITY_HREF}?tab=factors#totp`;

/** Signed-in devices and stored machine credentials. */
export const SESSIONS_HREF = `${SECURITY_HREF}?tab=sessions`;

/** Personal + service-account access keys. */
export const ACCESS_KEYS_HREF = `${SECURITY_HREF}?tab=keys`;

/** The organization's machine identities. */
export const SERVICE_ACCOUNTS_HREF = `${SECURITY_HREF}?tab=service-accounts`;
