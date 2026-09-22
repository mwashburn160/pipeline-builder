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
    date: '2026-09-21',
    title: 'Submit a plugin without an account',
    href: '/plugins/submit',
    hint: 'Anyone can submit a plugin from the directory. It is built in a sandbox, checked and moderated, then listed as Unverified.',
  },
  {
    when: 'This week',
    date: '2026-09-21',
    title: 'Public plugin directory: search and browse every Official plugin',
    href: '/plugins',
    hint: 'Search as you type, browse by category, and share a link to any plugin page — no sign-in needed.',
  },
  {
    when: 'This week',
    date: '2026-09-21',
    title: 'Plugin catalog details: accept or edit what your package declares',
    href: '/dashboard/plugins',
    hint: 'Uploads pre-fill summary, description, license and links from the spec, README and Dockerfile labels.',
  },
  {
    when: 'This week',
    date: '2026-09-21',
    title: 'Plugin runs report: success rate and duration per plugin version',
    href: '/dashboard/reports?tab=plugins&sub=runs',
    hint: 'How each plugin behaves when your pipelines run it, not just when it builds.',
  },
  {
    when: 'This week',
    date: '2026-09-21',
    title: 'Deprecate and yank plugin versions',
    href: '/dashboard/plugins',
    hint: 'Deprecation warns every pipeline that uses a version; yank stops new pipelines picking it.',
  },
  {
    when: 'This week',
    date: '2026-09-18',
    title: 'Passkeys: sign in and confirm actions with your device',
    href: '/dashboard/security?tab=factors#passkeys',
    hint: 'Add one and sign in with a fingerprint, face or screen lock — no password to phish.',
  },
];
