// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Page-level read gates — the deep-link counterpart to the sidebar's gating.
 *
 * The sidebar and command palette hide a link the viewer can't use
 * (`NavItem.requiredPermission` / `adminOnly` / `systemAdminOnly`), but hiding a
 * link is not a gate: a bookmark, a shared URL or a post-login redirect lands on
 * the page anyway. Those pages then rendered the full chrome and 403'd panel by
 * panel — one broken widget per fetch, with nothing saying why.
 *
 * `resolvePageGate(pathname)` answers "what does this ROUTE require?" from the
 * SAME declaration the nav reads, so the two can't drift: for a page that has a
 * nav entry the gate IS that nav item's gate. Pages with no nav entry of their
 * own (detail routes, sub-routes, redirect shims) are listed explicitly below.
 * `useAuthGuard` applies the result automatically, so a page needs no options.
 *
 * NOT included here: `NavItem.requiredFeature` (tier entitlements). A missing
 * entitlement is not "you can't see this page" — it's "this isn't on your plan",
 * which the page renders in place with an upsell (see `useFeatureGate` /
 * `FeatureLock`). Mixing the two would replace an honest upsell with a dead end.
 */
import { NAV_SECTIONS, type NavItem } from './nav';

/** What a dashboard route requires of the viewer before it renders anything. */
export interface PageGate {
  /** Fine-grained permission (RBAC) the viewer must hold. Superadmins bypass. */
  permission?: string;
  /** Org admin (or system admin) required. */
  adminOnly?: boolean;
  /** System admin required. */
  systemAdminOnly?: boolean;
}

/** Shared frozen "any authenticated user" gate, so callers can compare by shape. */
const OPEN: PageGate = Object.freeze({});

/** Every nav item, flattened once. */
const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/** Reduce a nav item to the subset of gating a PAGE can enforce. */
function gateOf(item: NavItem): PageGate {
  const gate: PageGate = {};
  if (item.requiredPermission) gate.permission = item.requiredPermission;
  if (item.adminOnly) gate.adminOnly = true;
  if (item.systemAdminOnly) gate.systemAdminOnly = true;
  return gate;
}

/**
 * pathname → gate, derived from the nav item's own `href` ONLY.
 *
 * `extraActivePaths` is deliberately NOT followed: it says "keep this nav item
 * highlighted while the user is over there", which is a highlighting concern,
 * not a shared-gate claim — a consolidated entry can legitimately cover pages
 * with different requirements. Those sibling routes are declared below instead.
 */
const NAV_GATES: Record<string, PageGate> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.href, gateOf(item)]),
);

/**
 * Pages the nav never links directly. Each needs an explicit gate because there
 * is no nav item to inherit from; the permission is the one the page's own reads
 * require (see `frontend/test/route-permissions.test.ts`, which checks these
 * against the generated route tables).
 *
 * Matching is EXACT on the Next.js `router.pathname` (dynamic segments included),
 * never by prefix — a prefix rule would silently hand a new sub-route whatever
 * its parent happened to require.
 */
const EXTRA_PAGE_GATES: Record<string, PageGate> = {
  // First-run onboarding: reachable before the user has an org role at all.
  '/dashboard/onboarding': OPEN,
  // Pipeline detail reads GET /pipelines/:id.
  '/dashboard/pipelines/[id]': { permission: 'pipelines:read' },
  // Custom dashboards read GET /dashboards[/:id] (`dashboards:read`); the alert
  // surfaces read GET /observability/* (`observability:read`).
  '/dashboard/observability/new': { permission: 'dashboards:read' },
  '/dashboard/observability/[id]': { permission: 'dashboards:read' },
  '/dashboard/observability/[id]/edit': { permission: 'dashboards:read' },
  '/dashboard/observability/alerts': { permission: 'observability:read' },
  '/dashboard/observability/alert-rules': { permission: 'observability:read' },
  '/dashboard/observability/alert-destinations': { permission: 'observability:read' },
  // Org-wide audit activity charts — same audience as the Audit Log nav item.
  '/dashboard/observability/audit-activity': { adminOnly: true },
  // Redirect shim onto /dashboard/observability/alert-destinations. Deliberately
  // OPEN: gating it stranded non-sysadmins on a page that only ever redirects.
  '/dashboard/admin/alert-destinations': OPEN,
  // Sysadmin per-org drill-down.
  '/dashboard/admin/orgs/[orgId]': { systemAdminOnly: true },
  // Sibling routes folded into another nav item via `extraActivePaths`. They
  // carry their OWN gate, which is why the derivation above ignores that field.
  '/dashboard/triage': { systemAdminOnly: true },          // under "Builds"
  '/dashboard/discounts': { systemAdminOnly: true },       // under "Billing Admin"
  '/dashboard/promotions': { systemAdminOnly: true },      // under "Billing Admin"
  '/dashboard/tokens': OPEN,                               // under "Security" — own tokens
  '/dashboard/settings/service-accounts': { permission: 'service_accounts:manage' },
};

/**
 * The gate for a dashboard route, by Next.js `router.pathname`.
 *
 * Returns {@link OPEN} (no requirements beyond being signed in) for a pathname
 * with no declared gate. That is deliberate — an unlisted page must not black
 * itself out — and `frontend/test/page-access.test.ts` asserts every page under
 * `pages/dashboard/` is declared, so "unlisted" can't happen by accident.
 */
export function resolvePageGate(pathname: string): PageGate {
  return NAV_GATES[pathname] ?? EXTRA_PAGE_GATES[pathname] ?? OPEN;
}

/** True when a gate asks for nothing beyond authentication. */
export function isOpenGate(gate: PageGate): boolean {
  return !gate.permission && !gate.adminOnly && !gate.systemAdminOnly;
}

/** Every declared pathname (nav-derived + explicit) — used by the coverage test. */
export function declaredPagePaths(): string[] {
  return [...new Set([...Object.keys(NAV_GATES), ...Object.keys(EXTRA_PAGE_GATES)])].sort();
}
