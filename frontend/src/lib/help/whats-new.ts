// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight "what's new" feed. Hard-coded for now — the entries mirror the
 * recent shipped capabilities the dashboard surfaces. When a proper changelog
 * endpoint exists, swap this for an api fetch; the page already treats it as
 * opaque data.
 *
 * Lives here rather than inline in pages/dashboard/help.tsx so the page is UI
 * only, and so the entries can be asserted in tests.
 *
 * Each entry should reference a destination page so users can try the feature
 * directly. `date` is an ISO day for at-a-glance staleness; `when` is the
 * human-readable bucket. Keep the list short (top 5) and recent.
 */
export interface WhatsNewEntry {
  when: string;
  date: string;
  title: string;
  href?: string;
  hint?: string;
}

export const WHATS_NEW: ReadonlyArray<WhatsNewEntry> = [
  {
    when: 'This week',
    date: '2026-09-18',
    title: 'Passkeys: sign in and confirm actions with your device',
    href: '/dashboard/security?tab=factors#passkeys',
    hint: 'Add one and sign in with a fingerprint, face or screen lock — no password to phish.',
  },
  {
    when: 'Recent',
    date: '2026-05-28',
    title: 'Read-only "view as user" impersonation for sysadmins',
    href: '/dashboard/users',
    hint: "Reproduce a tenant's view safely; writes blocked under impersonation.",
  },
  { when: 'Recent', date: '2026-05-27', title: 'Notifications & alert-channel preferences', href: '/dashboard/notifications' },
  { when: 'Recent', date: '2026-05-26', title: 'Executions drill-down with CSV export', href: '/dashboard/executions' },
  { when: 'Recent', date: '2026-05-15', title: 'Step-up password reverify on destructive sysadmin actions' },
];
