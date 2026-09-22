import {
  LayoutDashboard,
  GitBranch,
  Puzzle,
  Shield,
  ShieldCheck,
  MessageSquare,
  Container,
  FileBarChart,
  Users,
  UsersRound,
  Building2,
  BarChart3,
  CreditCard,
  Settings,
  KeyRound,
  HelpCircle,
  Download,
  Mail,
  Plus,
  Boxes,
  Gauge,
  Activity,
  History,
  SlidersHorizontal,
  Bell,
  Rocket,
  Landmark,
  Fingerprint,
  Layers,
  LayoutTemplate,
  Code,
  Inbox,
  Siren,
  ScrollText,
  BellRing,
  ListChecks,
  Send,
  LineChart,
  Wrench,
  Percent,
  Megaphone,
  Store,
  BadgeCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ECOSYSTEM_CONSOLE_PERMISSIONS } from './ecosystem-access';

// ---------------------------------------------------------------------------
// Single source of truth for dashboard navigation.
//
// Both the Sidebar and the Command Palette (⌘K) consume this. Keeping one
// definition means a new page added here automatically appears in BOTH places
// with the same role/feature gating — previously the palette had its own
// hand-maintained copy that silently drifted (missing ~half the app).
// ---------------------------------------------------------------------------

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  systemAdminOnly?: boolean;
  /** Show only when the user holds this fine-grained permission (RBAC).
   *  Superadmins bypass. Preferred over `adminOnly` for capability-specific
   *  items so custom-group grants reveal the right nav.
   *
   *  This is ALSO the page's read gate: `src/lib/page-access.ts` derives the
   *  route's requirement from this exact declaration and `useAuthGuard` applies
   *  it, so a deep link renders one honest "no access" state instead of the
   *  chrome plus a 403 per panel. Hiding a link was never a gate. */
  requiredPermission?: string;
  /** Show when the viewer holds ANY of these permissions (superadmins bypass).
   *  Checked in addition to `requiredPermission`. Not derived into a page gate:
   *  the one page using it (the Ecosystem console) enforces the same rule
   *  itself, see `src/lib/ecosystem-access.ts`. */
  requiredAnyPermission?: readonly string[];
  /**
   * Show ONLY while the active org is the system org — HIDDEN elsewhere, never
   * locked. This is a governance boundary (plan §3.0: only the system org
   * manages the plugin ecosystem), not a plan upsell: no tenant can ever earn
   * access, so there is nothing to discover and a locked row would only
   * advertise an internal surface. It also hides the row from a superadmin who
   * has switched into a tenant org — they are acting as that tenant there.
   */
  systemOrgOnly?: boolean;
  /** The feature entitlement this page needs (per-user/tier feature flag, e.g.
   *  `sso`). Sourced from the FeaturesProvider (`useFeatures().isEnabled`);
   *  superadmins hold every entitlement. Distinct from `requiresBillingEnabled`
   *  (deployment config) — this is a per-org tier entitlement.
   *
   *  This does NOT hide the item. A missing entitlement is "this isn't on your
   *  plan", not "you can't see this" (the same distinction `page-access.ts`
   *  makes when it refuses to turn an entitlement into a read gate): hiding it
   *  is how an org on a lower tier never learns the product does SSO at all.
   *  The item stays listed in a locked style and still routes to the page, which
   *  renders its own `FeatureLock` upsell. `navItemLockedFeature` reports which
   *  entitlement is missing so the sidebar and ⌘K can mark it. */
  requiredFeature?: string;
  /** Hide unless the billing SERVICE is enabled in this deployment
   *  (`BILLING_ENABLED`), so the Billing link doesn't show when it would only
   *  dead-end at a 503. This is deployment config sourced from
   *  `/api/billing/config`, not a per-user feature flag. */
  requiresBillingEnabled?: boolean;
  /** Extra path prefixes that should also mark this item active (e.g. a sibling
   *  route folded into the same nav entry, like /triage under "Builds"). */
  extraActivePaths?: string[];
  /**
   * Reachable from the command palette (⌘K) but NOT listed in the sidebar.
   * For sub-pages of an existing sidebar entry — the alert views under
   * Observability, triage under Builds, discounts/promotions under Billing
   * Admin — that need to be findable by name without a second sidebar row that
   * would light up alongside its parent. Gating is identical either way, and
   * the entry still declares the route's read gate for `page-access.ts`.
   */
  paletteOnly?: boolean;
  /**
   * Extra search terms for the command palette, for an entry whose title isn't
   * what the user would type (⌘K matches title, section label and these). The
   * sidebar ignores them.
   */
  keywords?: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
  /**
   * Pin this section open: it renders expanded, ignores any persisted
   * collapsed state, and shows no collapse chevron. Use for sections whose
   * items are easily "lost" when hidden (e.g. Insights → Reports), so a stale
   * localStorage collapse can't make navigation look like it's missing.
   */
  alwaysExpanded?: boolean;
}

export const QUICK_ACTIONS: { href: string; label: string; icon: LucideIcon; color: string; requiredPermission?: string }[] = [
  // `?create=1` makes the target page open its create modal on arrival, so these
  // genuinely start a create flow rather than just navigating to the list.
  // `requiredPermission` hides the action for users who can't perform the write
  // (and it's read-only-impersonation-aware via `can()` at the render site) —
  // otherwise a read-only member would land on a create modal that then 403s.
  // `color` carries the full colour treatment, from the token set. ONE action is
  // accented (creating a pipeline is the thing this product is for); the others
  // are quiet, so the top of the rail reads as a toolbar rather than as three
  // competing buttons in blue, amber and green.
  { href: '/dashboard/pipelines?create=1', label: 'Create pipeline', icon: Plus, color: 'bg-brand text-white hover:bg-brand-strong', requiredPermission: 'pipelines:write' },
  { href: '/dashboard/plugins?create=1', label: 'Add plugin', icon: Plus, color: 'bg-surface-muted text-fg-muted hover:text-fg', requiredPermission: 'plugins:write' },
  { href: '/dashboard/downloads', label: 'Get the CLI', icon: Download, color: 'bg-surface-muted text-fg-muted hover:text-fg' },
];

// ---------------------------------------------------------------------------
// Journey-based information architecture. Groups map to what a developer is
// trying to DO — Home (orient) → Build (author) → Deliver (ship & operate) →
// Insights (analyze) → Govern (policy & audit) — then the admin/settings scopes.
// Reorganized from the older feature-siloed layout so items live where the task
// lives (e.g. Deployments/Executions/Logs sit under Deliver, not Build/Insights;
// Compliance/Audit are their own Govern group rather than mixed into analytics).
// ---------------------------------------------------------------------------
export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Home',
    items: [
      { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      // Unified action-item queue (failing owned pipelines, pending reviews, unread messages).
      { title: 'Inbox', href: '/dashboard/inbox', icon: Inbox },
      // Developer-portal "my services": the pipelines & plugins this user owns.
      { title: 'My services', href: '/dashboard/my-services', icon: Layers },
      { title: 'Messages', href: '/dashboard/messages', icon: MessageSquare, requiredPermission: 'messages:read' },
      // Requests to view an account, and live viewing sessions. NO permission gate
      // on purpose: the person most often asked is the impersonated user, who is
      // usually not an admin. The server filters what each person sees.
      { title: 'Access requests', href: '/dashboard/access-requests', icon: KeyRound },
    ],
  },
  {
    label: 'Build',
    // Pinned open — the core daily authoring surfaces.
    alwaysExpanded: true,
    items: [
      { title: 'Pipelines', href: '/dashboard/pipelines', icon: GitBranch, requiredPermission: 'pipelines:read' },
      // Golden-path template gallery — instantiate a governed pipeline from a starter.
      { title: 'Templates', href: '/dashboard/templates', icon: LayoutTemplate, requiredPermission: 'templates:read' },
      { title: 'Plugins', href: '/dashboard/plugins', icon: Puzzle, requiredPermission: 'plugins:read' },
      // The org's plugin-ecosystem publisher: profile, listings, publish
      // requests. Readable with `plugins:read`; each write control checks its own
      // permission (`plugins:publish` / `publishers:manage`), as the server does.
      {
        title: 'Publisher',
        href: '/dashboard/publisher',
        icon: BadgeCheck,
        requiredPermission: 'plugins:read',
        keywords: 'publish publisher ecosystem listing directory marketplace verified',
      },
    ],
  },
  {
    label: 'Deliver',
    // Pinned open — ship & operate surfaces are frequently hit.
    alwaysExpanded: true,
    items: [
      // Deployed-pipelines registry (view/register/deregister + drift vs config).
      { title: 'Deployments', href: '/dashboard/deployments', icon: Rocket, requiredPermission: 'pipelines:read' },
      // Per-pipeline run health.
      { title: 'Executions', href: '/dashboard/executions', icon: Activity, requiredPermission: 'reports:read' },
      // Plugin-build queue + failed-build triage (sysadmin). An operate surface,
      // moved out of the Platform admin group to sit with the other run views.
      { title: 'Builds', href: '/dashboard/build-queue', icon: Container, systemAdminOnly: true, extraActivePaths: ['/dashboard/triage'] },
      // The failed-build (DLQ) tab of Builds, by name in ⌘K.
      { title: 'Build triage', href: '/dashboard/triage', icon: Wrench, systemAdminOnly: true, paletteOnly: true },
      // Application logs (Loki). Rides `observability:read` — already in the
      // member bundle — so logs appear for existing roles with no migration;
      // DOWNLOADING them additionally needs `logs:export`, checked on the page.
      { title: 'Logs', href: '/dashboard/logs', icon: ScrollText, requiredPermission: 'observability:read' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { title: 'Reports', href: '/dashboard/reports', icon: FileBarChart, requiredPermission: 'reports:read' },
      // The landing page lists the dashboards the caller can see (GET /dashboards),
      // which the platform gates on `dashboards:read` — in the member bundle, so
      // every built-in role keeps it. Server-side $ORG substitution still scopes
      // the metrics inside a dashboard to the viewer's own org.
      { title: 'Observability', href: '/dashboard/observability', icon: BarChart3, requiredPermission: 'dashboards:read' },
      // The alert views live under /dashboard/observability, so the sidebar's
      // Observability entry already highlights for them (prefix match); listing
      // them there too would light up two rows. In ⌘K they're findable by name.
      // All three read GET /observability/* (`observability:read`).
      { title: 'Alerts', href: '/dashboard/observability/alerts', icon: BellRing, requiredPermission: 'observability:read', paletteOnly: true },
      { title: 'Alert rules', href: '/dashboard/observability/alert-rules', icon: ListChecks, requiredPermission: 'observability:read', paletteOnly: true },
      { title: 'Alert destinations', href: '/dashboard/observability/alert-destinations', icon: Send, requiredPermission: 'observability:read', paletteOnly: true },
    ],
  },
  {
    label: 'Govern',
    items: [
      { title: 'Compliance', href: '/dashboard/compliance', icon: Shield, requiredPermission: 'compliance:read' },
      // Security audit trail.
      { title: 'Audit log', href: '/dashboard/audit', icon: History, adminOnly: true },
      // Org-wide audit activity charts — same audience as the Audit Log. Its
      // route sits under /observability, so it's palette-only rather than a
      // second Govern row.
      { title: 'Audit activity', href: '/dashboard/observability/audit-activity', icon: LineChart, adminOnly: true, paletteOnly: true },
    ],
  },
  {
    label: 'Organization',
    items: [
      { title: 'Members', href: '/dashboard/members', icon: UsersRound, requiredPermission: 'members:manage' },
      // Teams (sub-organizations) are created and managed on the Members page —
      // the roster and the team list are the same admin's job, and a second
      // sidebar row pointing at the same route would light up alongside Members.
      // But with no entry of its own, "teams" was unfindable in ⌘K and invisible
      // to an org that has none yet, which is exactly the org that needs to find
      // the create control. Palette-only, same gate as the page it opens.
      {
        title: 'Teams',
        href: '/dashboard/members',
        icon: Building2,
        requiredPermission: 'members:manage',
        paletteOnly: true,
        keywords: 'team teams sub-organization suborg child org hierarchy create team',
      },
      { title: 'Roles', href: '/dashboard/roles', icon: ShieldCheck, requiredPermission: 'roles:manage' },
      { title: 'Invitations', href: '/dashboard/invitations', icon: Mail, requiredPermission: 'invitations:manage' },
      { title: 'Quotas', href: '/dashboard/quotas', icon: Gauge, requiredPermission: 'quotas:read' },
      // Gated by the `billing:read` permission AND by whether the billing SERVICE
      // is enabled in this deployment (`requiresBillingEnabled` → /api/billing/config).
      // Deliberately NOT a per-user feature-flag gate — billing visibility is a
      // deployment/permission concern, not a tier entitlement.
      { title: 'Billing', href: '/dashboard/billing', icon: CreditCard, requiredPermission: 'billing:read', requiresBillingEnabled: true },
    ],
  },
  {
    // Platform-wide administration (system admins only). Kept separate from the
    // org-scoped "Organization" section above so the two scopes aren't confused.
    label: 'Platform',
    items: [
      { title: 'All organizations', href: '/dashboard/organizations', icon: Building2, systemAdminOnly: true },
      { title: 'All users', href: '/dashboard/users', icon: Users, systemAdminOnly: true },
      { title: 'Registry', href: '/dashboard/registry', icon: Boxes, systemAdminOnly: true },
      // Fleet-wide billing admin — a single entry that folds Overview, Discounts,
      // and Promotions into one page with a tab bar (BillingAdminTabs), mirroring
      // the Builds queue/triage consolidation. extraActivePaths keeps this item
      // highlighted while on any of the three sub-routes. All three share the
      // billing-service gate; Promotions additionally needs BILLING_PROMOTIONS_ENABLED
      // server-side (its own page handles the disabled case).
      {
        title: 'Billing admin',
        href: '/dashboard/admin/billing',
        icon: Landmark,
        systemAdminOnly: true,
        requiresBillingEnabled: true,
        extraActivePaths: ['/dashboard/discounts', '/dashboard/promotions'],
      },
      // The Discounts / Promotions tabs of Billing Admin, by name in ⌘K.
      { title: 'Discounts', href: '/dashboard/discounts', icon: Percent, systemAdminOnly: true, requiresBillingEnabled: true, paletteOnly: true },
      { title: 'Promotions', href: '/dashboard/promotions', icon: Megaphone, systemAdminOnly: true, requiresBillingEnabled: true, paletteOnly: true },
      // Sysadmin roster of which orgs have SSO/IdP configured.
      { title: 'IdP / SSO', href: '/dashboard/admin/idp', icon: Fingerprint, systemAdminOnly: true },
      // "Settings", not "Platform Settings" — this item lives under the
      // `Platform` section, so the prefix rendered as "Platform / Platform
      // Settings". The route was renamed to match (forward-only, no redirect
      // from the old /dashboard/admin/platform-settings path).
      { title: 'Settings', href: '/dashboard/admin/settings', icon: SlidersHorizontal, systemAdminOnly: true },
      // Plugin-ecosystem governance console (moderation, publisher verification,
      // Ecosystem Manager roster). System org only, and only for Ecosystem
      // Managers and superadmins — HIDDEN (not locked) everywhere else; see
      // `systemOrgOnly`.
      {
        title: 'Ecosystem',
        href: '/dashboard/admin/ecosystem',
        icon: Store,
        systemOrgOnly: true,
        requiredAnyPermission: ECOSYSTEM_CONSOLE_PERMISSIONS,
        keywords: 'ecosystem moderation moderate publish queue publisher verification ecosystem manager marketplace',
      },
    ],
  },
  {
    label: 'Settings',
    items: [
      // "Profile & organization", not "Profile": the item covers the org tab
      // too, and calling the whole settings area "Profile" is what hid passkeys,
      // TOTP and recovery codes behind a word that denies they exist. The
      // credentials moved out to their own entry below.
      { title: 'Profile & organization', href: '/dashboard/settings', icon: Settings },
      // ONE home for sign-in factors, sessions, access keys and the org's
      // service accounts. `extraActivePaths` keeps it highlighted on the old
      // service-accounts address while it forwards (the old /dashboard/tokens
      // address is a server redirect in next.config.js and never renders).
      {
        title: 'Security',
        href: '/dashboard/security',
        icon: ShieldCheck,
        extraActivePaths: ['/dashboard/settings/service-accounts'],
      },
      // Org owner/admin SSO self-service. Gated by the dedicated `org:idp`
      // permission (split out of `org:settings`) AND the `sso` tier entitlement;
      // the page + backend re-enforce both.
      { title: 'Single sign-on', href: '/dashboard/settings/sso', icon: Fingerprint, requiredPermission: 'org:idp', requiredFeature: 'sso', keywords: 'sso saml oidc idp identity provider' },
      // Org-admin incident-reporting setup (DORA post-deploy CFR + MTTR). Admin-only
      // config surface, gated on the `advanced_reporting` entitlement (like DORA).
      { title: 'Incident reporting', href: '/dashboard/settings/incident-reporting', icon: Siren, adminOnly: true, requiredFeature: 'advanced_reporting' },
      { title: 'Notifications', href: '/dashboard/notifications', icon: Bell },
      { title: 'API catalog', href: '/dashboard/api-catalog', icon: Code },
      { title: 'Downloads', href: '/dashboard/downloads', icon: Download },
      { title: 'Help', href: '/dashboard/help', icon: HelpCircle },
    ],
  },
];

/** What the sidebar and ⌘K know about the viewer when they gate the nav. */
export interface NavVisibilityContext {
  isAdmin: boolean;
  isSuperAdmin: boolean;
  hasPermission: (perm: string) => boolean;
  billingEnabled?: boolean;
  /** The ACTIVE org is the system org (`isSystemOrgActive`). Absent ⇒ false,
   *  so a caller that forgets it fails closed for `systemOrgOnly` items. */
  isSystemOrg?: boolean;
  /** Feature-entitlement check (useFeatures().isEnabled). Superadmins get all
   *  features, so this may be omitted for them. Only used by
   *  {@link navItemLockedFeature} — an entitlement never hides an item. */
  isFeatureEnabled?: (feature: string) => boolean;
}

/**
 * Shared visibility gate for a nav item. Both the sidebar and the command
 * palette filter with this so an item shows in exactly the same places.
 *
 * Deliberately does NOT consider `requiredFeature`: a permission the viewer
 * lacks means the page would 403, so the link goes; an entitlement they lack
 * means the page has an upsell to show them, so the link stays (locked — see
 * {@link navItemLockedFeature}). Collapsing the two is what left an org that
 * isn't on the SSO tier with no way to discover that SSO exists.
 */
export function isNavItemVisible(item: NavItem, ctx: NavVisibilityContext): boolean {
  if (item.systemAdminOnly && !ctx.isSuperAdmin) return false;
  if (item.adminOnly && !ctx.isAdmin) return false;
  if (item.requiredPermission && !ctx.hasPermission(item.requiredPermission)) return false;
  if (item.requiredAnyPermission && !item.requiredAnyPermission.some((p) => ctx.hasPermission(p))) return false;
  // Governance boundary: hidden (not locked) outside the system org.
  if (item.systemOrgOnly && !ctx.isSystemOrg) return false;
  if (item.requiresBillingEnabled && !ctx.billingEnabled) return false;
  return true;
}

/**
 * The entitlement a VISIBLE item needs but the viewer's plan doesn't include,
 * or `undefined` when nothing is locked.
 *
 * Callers render the item muted, lock-marked and named as off-plan, and still
 * link it: the destination renders the `FeatureLock` upsell in place.
 * Superadmins hold every entitlement, so nothing is ever locked for them.
 */
export function navItemLockedFeature(item: NavItem, ctx: NavVisibilityContext): string | undefined {
  if (!item.requiredFeature || ctx.isSuperAdmin) return undefined;
  return ctx.isFeatureEnabled?.(item.requiredFeature) ? undefined : item.requiredFeature;
}
