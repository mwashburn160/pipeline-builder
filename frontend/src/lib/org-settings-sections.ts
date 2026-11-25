// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The sections of Settings → Organization, in switcher order. The page shows a
 * section only when the viewer can see at least one of its cards, and opens on
 * the first visible one. `?section=<id>` names the open section.
 *
 * Kept free of card imports so any link (onboarding, notices, the SSO wizard)
 * can build an href without pulling a settings card into its bundle.
 */
export const ORG_SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', description: 'Name and URL, the email domains members join with, and who may contact support.' },
  { id: 'security', label: 'Security', description: 'How members sign in and how long a sign-in lasts, and whether platform administrators may view accounts.' },
  { id: 'pipelines', label: 'Pipelines', description: 'Where pipelines run, the toolchain they build with, and how vulnerable plugins are handled.' },
  { id: 'ai', label: 'AI', description: 'Whether AI features are on, and the provider keys they use.' },
  { id: 'data', label: 'Data', description: 'Take a copy of what the platform holds for this organization.' },
] as const;

export type OrgSettingsSectionId = (typeof ORG_SETTINGS_SECTIONS)[number]['id'];

/** Anchor of the Plugin security card (Pipelines section). */
export const PLUGIN_SECURITY_ANCHOR = 'plugin-security';

/** Link to one section of Settings → Organization, optionally to a card on it. */
export function orgSettingsHref(section: OrgSettingsSectionId, anchor?: string): string {
  return `/dashboard/settings?tab=organization&section=${section}${anchor ? `#${anchor}` : ''}`;
}
