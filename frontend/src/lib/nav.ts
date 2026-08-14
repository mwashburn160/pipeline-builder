import {
  LayoutDashboard,
  GitBranch,
  Puzzle,
  Shield,
  ShieldCheck,
  MessageSquare,
  ScrollText,
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
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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
   *  items so custom-group grants reveal the right nav. */
  requiredPermission?: string;
  /** Show only when this feature entitlement is enabled for the current user
   *  (per-user/tier feature flag, e.g. `sso`). Sourced from the FeaturesProvider
   *  (`useFeatures().isEnabled`). Superadmins get all features, so they always
   *  pass. Distinct from `requiresBillingEnabled` (deployment config) — this is a
   *  per-org tier entitlement. */
  requiredFeature?: string;
  /** Hide unless the billing SERVICE is enabled in this deployment
   *  (`BILLING_ENABLED`), so the Billing link doesn't show when it would only
   *  dead-end at a 503. This is deployment config sourced from
   *  `/api/billing/config`, not a per-user feature flag. */
  requiresBillingEnabled?: boolean;
  /** Extra path prefixes that should also mark this item active (e.g. a sibling
   *  route folded into the same nav entry, like /triage under "Builds"). */
  extraActivePaths?: string[];
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
  { href: '/dashboard/pipelines?create=1', label: 'Create Pipeline', icon: Plus, color: 'bg-blue-600', requiredPermission: 'pipelines:write' },
  { href: '/dashboard/plugins?create=1', label: 'Add Plugin', icon: Plus, color: 'bg-amber-500', requiredPermission: 'plugins:write' },
  { href: '/dashboard/downloads', label: 'Get the CLI', icon: Download, color: 'bg-green-600' },
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
      { title: 'My Services', href: '/dashboard/my-services', icon: Layers },
      { title: 'Messages', href: '/dashboard/messages', icon: MessageSquare, requiredPermission: 'messages:read' },
    ],
  },
  {
    label: 'Build',
    // Pinned open — the core daily authoring surfaces.
    alwaysExpanded: true,
    items: [
      { title: 'Pipelines', href: '/dashboard/pipelines', icon: GitBranch },
      // Golden-path template gallery — instantiate a governed pipeline from a starter.
      { title: 'Templates', href: '/dashboard/templates', icon: LayoutTemplate },
      { title: 'Plugins', href: '/dashboard/plugins', icon: Puzzle },
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
      { title: 'Executions', href: '/dashboard/executions', icon: Activity },
      { title: 'Logs', href: '/dashboard/logs', icon: ScrollText },
      // Plugin-build queue + failed-build triage (sysadmin). An operate surface,
      // moved out of the Platform admin group to sit with the other run views.
      { title: 'Builds', href: '/dashboard/build-queue', icon: Container, systemAdminOnly: true, extraActivePaths: ['/dashboard/triage'] },
    ],
  },
  {
    label: 'Insights',
    items: [
      { title: 'Reports', href: '/dashboard/reports', icon: FileBarChart, requiredPermission: 'reports:read' },
      // Observability is visible to any authenticated user. Server-side
      // $ORG substitution scopes their view to their own org's metrics.
      { title: 'Observability', href: '/dashboard/observability', icon: BarChart3 },
    ],
  },
  {
    label: 'Govern',
    items: [
      { title: 'Compliance', href: '/dashboard/compliance', icon: Shield, requiredPermission: 'compliance:read' },
      // Security audit trail.
      { title: 'Audit Log', href: '/dashboard/audit', icon: History, adminOnly: true },
    ],
  },
  {
    label: 'Organization',
    items: [
      { title: 'Members', href: '/dashboard/members', icon: UsersRound, requiredPermission: 'members:manage' },
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
      { title: 'All Organizations', href: '/dashboard/organizations', icon: Building2, systemAdminOnly: true },
      { title: 'All Users', href: '/dashboard/users', icon: Users, systemAdminOnly: true },
      { title: 'Registry', href: '/dashboard/registry', icon: Boxes, systemAdminOnly: true },
      // Fleet-wide billing admin — a single entry that folds Overview, Discounts,
      // and Promotions into one page with a tab bar (BillingAdminTabs), mirroring
      // the Builds queue/triage consolidation. extraActivePaths keeps this item
      // highlighted while on any of the three sub-routes. All three share the
      // billing-service gate; Promotions additionally needs BILLING_PROMOTIONS_ENABLED
      // server-side (its own page handles the disabled case).
      {
        title: 'Billing Admin',
        href: '/dashboard/admin/billing',
        icon: Landmark,
        systemAdminOnly: true,
        requiresBillingEnabled: true,
        extraActivePaths: ['/dashboard/discounts', '/dashboard/promotions'],
      },
      // Sysadmin roster of which orgs have SSO/IdP configured.
      { title: 'IdP / SSO', href: '/dashboard/admin/idp', icon: Fingerprint, systemAdminOnly: true },
      { title: 'Platform Settings', href: '/dashboard/admin/platform-settings', icon: SlidersHorizontal, systemAdminOnly: true },
    ],
  },
  {
    label: 'Settings',
    items: [
      { title: 'Profile', href: '/dashboard/settings', icon: Settings },
      // Org owner/admin SSO self-service. Gated by the `org:settings` permission
      // AND the `sso` tier entitlement; the page + backend re-enforce both.
      { title: 'Single Sign-On', href: '/dashboard/settings/sso', icon: Fingerprint, requiredPermission: 'org:settings', requiredFeature: 'sso' },
      { title: 'Notifications', href: '/dashboard/notifications', icon: Bell },
      { title: 'API Tokens', href: '/dashboard/tokens', icon: KeyRound },
      { title: 'API Catalog', href: '/dashboard/api-catalog', icon: Code },
      { title: 'Downloads', href: '/dashboard/downloads', icon: Download },
      { title: 'Help', href: '/dashboard/help', icon: HelpCircle },
    ],
  },
];

/**
 * Shared visibility gate for a nav item. Both the sidebar and the command
 * palette filter with this so an item shows in exactly the same places.
 */
export function isNavItemVisible(
  item: NavItem,
  ctx: {
    isAdmin: boolean;
    isSuperAdmin: boolean;
    hasPermission: (perm: string) => boolean;
    billingEnabled?: boolean;
    /** Feature-entitlement check (useFeatures().isEnabled). Superadmins get all
     *  features, so this may be omitted for them and `requiredFeature` still passes. */
    isFeatureEnabled?: (feature: string) => boolean;
  },
): boolean {
  if (item.systemAdminOnly && !ctx.isSuperAdmin) return false;
  if (item.adminOnly && !ctx.isAdmin) return false;
  if (item.requiredPermission && !ctx.hasPermission(item.requiredPermission)) return false;
  if (item.requiresBillingEnabled && !ctx.billingEnabled) return false;
  // Superadmins hold every feature; only enforce the gate for everyone else.
  if (item.requiredFeature && !ctx.isSuperAdmin && !(ctx.isFeatureEnabled?.(item.requiredFeature) ?? false)) return false;
  return true;
}
