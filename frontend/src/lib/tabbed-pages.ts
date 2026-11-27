// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pages made of gated tabs, and what each tab needs.
 *
 *   Inbox           /dashboard/inbox?tab=notifications|messages|access-requests
 *   Members         /dashboard/members?tab=members|teams|roles|invitations
 *   Usage & billing /dashboard/usage?tab=quotas|billing
 *
 * Each tab has its own gate. The PAGE opens for whoever may see
 * any of its tabs (`page-access.ts` derives that from this table), and shows only
 * those tabs.
 *
 * Kept free of component imports so any link can build an href from here.
 */
import type { Permission } from '@pipeline-builder/api-core/permissions';

export interface PageTab {
  id: string;
  label: string;
  /** The permission the tab's reads require. Absent ⇒ any signed-in user. */
  permission?: Permission;
  /** Hidden while the billing service is off in this deployment. */
  requiresBillingEnabled?: boolean;
}

export const INBOX_PATH = '/dashboard/inbox';
export const MEMBERS_PATH = '/dashboard/members';
export const USAGE_PATH = '/dashboard/usage';

export const TABBED_PAGES: Readonly<Record<string, readonly PageTab[]>> = {
  [INBOX_PATH]: [
    { id: 'notifications', label: 'Notifications' },
    { id: 'messages', label: 'Messages', permission: 'messages:read' },
    { id: 'access-requests', label: 'Access requests' },
  ],
  [MEMBERS_PATH]: [
    { id: 'members', label: 'Members', permission: 'members:manage' },
    { id: 'teams', label: 'Teams', permission: 'members:manage' },
    { id: 'roles', label: 'Roles', permission: 'roles:manage' },
    { id: 'invitations', label: 'Invitations', permission: 'invitations:manage' },
  ],
  [USAGE_PATH]: [
    { id: 'quotas', label: 'Quotas', permission: 'quotas:read' },
    { id: 'billing', label: 'Billing', permission: 'billing:read', requiresBillingEnabled: true },
  ],
};

/** What the tab filter knows about the viewer. */
export interface TabViewer {
  hasPermission: (permission: Permission) => boolean;
  /** The billing service's state; `undefined` while the probe resolves (treated as on). */
  billingEnabled?: boolean;
}

/**
 * The tabs of `pathname` this viewer may see, in order. A billing-gated tab
 * drops out while billing is off; a viewer left with none is refused by the
 * page gate (`page-access.ts`), which applies the same rule.
 */
export function visibleTabs(pathname: string, viewer: TabViewer): PageTab[] {
  return (TABBED_PAGES[pathname] ?? []).filter((t) => (!t.permission || viewer.hasPermission(t.permission))
    && (!t.requiresBillingEnabled || viewer.billingEnabled !== false));
}

export function visibleTabIds(pathname: string, viewer: TabViewer): string[] {
  return visibleTabs(pathname, viewer).map((t) => t.id);
}

/** The tab `tabId` of a tabbed page, if both exist. */
export function findTab(pathname: string, tabId: string | undefined): PageTab | undefined {
  return tabId ? TABBED_PAGES[pathname]?.find((t) => t.id === tabId) : undefined;
}

// ── Canonical hrefs ───────────────────────────────────────────────────────

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const qs = Object.entries(query)
    .filter((e): e is [string, string] => !!e[1])
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return qs ? `${path}?${qs}` : path;
}

export const NOTIFICATIONS_HREF = `${INBOX_PATH}?tab=notifications`;
export const MESSAGES_HREF = `${INBOX_PATH}?tab=messages`;
export const ACCESS_REQUESTS_HREF = `${INBOX_PATH}?tab=access-requests`;
export const MEMBERS_HREF = `${MEMBERS_PATH}?tab=members`;
export const TEAMS_HREF = `${MEMBERS_PATH}?tab=teams`;
export const ROLES_HREF = `${MEMBERS_PATH}?tab=roles`;
export const INVITATIONS_HREF = `${MEMBERS_PATH}?tab=invitations`;
export const QUOTAS_HREF = `${USAGE_PATH}?tab=quotas`;
export const BILLING_HREF = `${USAGE_PATH}?tab=billing`;

/** Billing's own sections, read from `?section=` (the page owns `?tab=`). */
export const BILLING_SECTIONS = ['overview', 'plans', 'addons', 'history'] as const;
export type BillingSection = (typeof BILLING_SECTIONS)[number];
/** The query key the billing tab reads its section from. */
export const BILLING_SECTION_KEY = 'section';

/** A link to the billing tab, optionally to one section and/or a highlighted add-on. */
export function billingHref(opts: { section?: BillingSection; highlight?: string } = {}): string {
  return withQuery(USAGE_PATH, { tab: 'billing', section: opts.section, highlight: opts.highlight });
}

/** A link to one message thread. */
export function messageHref(messageId: string): string {
  return withQuery(INBOX_PATH, { tab: 'messages', message: messageId });
}

/** The Invitations tab, with the composer prefilled for `email`. */
export function invitationsHref(email?: string): string {
  return withQuery(MEMBERS_PATH, { tab: 'invitations', email });
}
