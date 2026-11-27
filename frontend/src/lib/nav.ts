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
  UserRound,
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
  LifeBuoy,
  Sparkles,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Permission } from '@pipeline-builder/api-core/permissions';
import { ECOSYSTEM_CONSOLE_PERMISSIONS } from './ecosystem-access';
import { SUPPORT_FEATURE_FLAGS } from './feature-flags';

// ---------------------------------------------------------------------------
// Single source of truth for dashboard navigation.
//
// Both the Sidebar and the Command Palette (⌘K) consume this. Keeping one
// definition means a new page added here automatically appears in BOTH places
// with the same role/feature gating, with no second copy to drift.
// ---------------------------------------------------------------------------

/** One alternative of {@link NavItem.requiredAnyOf}: all of its fields must hold. */
export interface NavGate {
  permission: Permission;
  requiresBillingEnabled?: boolean;
}

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
  requiredPermission?: Permission;
  /** Show when the viewer holds ANY of these permissions (superadmins bypass).
   *  Checked in addition to `requiredPermission`. Not derived into a page gate:
   *  the one page using it (the Ecosystem console) enforces the same rule
   *  itself, see `src/lib/ecosystem-access.ts`. */
  requiredAnyPermission?: readonly Permission[];
  /**
   * Show when the viewer meets ANY ONE of these whole gates (superadmins bypass
   * the permission half, never the deployment half). For a tabbed page whose
   * tabs carry more than a permission: Usage & billing's billing tab also needs
   * the billing SERVICE, so `billing:read` counts only where billing runs, and
   * a billing-only viewer on a billing-disabled install sees no row that would
   * lead to an empty page. Checked in addition to the other gates. Like
   * `requiredAnyPermission`, not derived into a page gate here; the page
   * enforces the same rule from its tab table.
   */
  requiredAnyOf?: readonly NavGate[];
  /**
   * Show ONLY while the active org is the system org — HIDDEN elsewhere, never
   * locked. This is a governance boundary (only the system org
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
  /**
   * Like {@link requiredFeature} but an OR: the item is locked only when the
   * viewer holds NONE of these entitlements.
   *
   * Added for support, whose three levels are MUTUALLY EXCLUSIVE — an account
   * holds `support_standard` or `support_priority`, never both — so a
   * single-flag gate would lock the page for a customer who had simply bought
   * the other one. Mirrors `requiresAnyOf` on a billing bundle, which exists
   * for the same reason: `requires` could not express "either of these".
   *
   * Locks exactly as `requiredFeature` does: the item stays listed, muted, and
   * still routes to the page's own `FeatureLock` upsell. The reported flag is
   * the FIRST in the list, which is the cheapest one that would unlock it — the
   * right thing to put in front of somebody who holds none.
   */
  requiredAnyFeature?: readonly string[];
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
   * Observability, triage under Builds, the tabs of a tabbed page (Messages
   * under Inbox, Roles under Members) — that need to be findable by name without
   * a second sidebar row that would light up alongside its parent. Gating is identical either way, and
   * the entry still declares the route's read gate for `page-access.ts`.
   */
  paletteOnly?: boolean;
  /**
   * Extra search terms for the command palette, for an entry whose title isn't
   * what the user would type (⌘K matches title, section label and these). The
   * sidebar ignores them.
   */
  keywords?: string;
  /**
   * The sub-group this item sits in within its section (Platform's Tenants,
   * Catalog, Commerce, Operations). The sidebar renders each group under its own
   * collapsible heading, in first-appearance order; ⌘K searches the group name.
   */
  group?: string;
  /** Carries the unread-messages badge (the Inbox row). */
  showsUnreadCount?: boolean;
}

/**
 * Where a section renders. `sidebar` (the default) is the left rail; `account`
 * is the top-bar avatar menu and `help` the top-bar "?" menu. Every placement is
 * in ⌘K and declares page gates for `page-access.ts` the same way.
 */
export type NavPlacement = 'sidebar' | 'account' | 'help';

export interface NavSection {
  label: string;
  items: NavItem[];
  placement?: NavPlacement;
  /**
   * Pin this section open: it renders expanded, ignores any persisted
   * collapsed state, and shows no collapse chevron. Use for sections whose
   * items are easily "lost" when hidden (e.g. Insights → Reports), so a stale
   * localStorage collapse can't make navigation look like it's missing.
   */
  alwaysExpanded?: boolean;
}

export const QUICK_ACTIONS: { href: string; label: string; icon: LucideIcon; color: string; requiredPermission?: Permission }[] = [
  // `?create=1` makes the target page open its create modal on arrival, so these
  // genuinely start a create flow rather than just navigating to the list.
  // `requiredPermission` hides the action for users who can't perform the write
  // (and it's read-only-impersonation-aware via `can()` at the render site) —
  // otherwise a read-only member would land on a create modal that then 403s.
  // `color` carries the full colour treatment, from the token set. ONE action is
  // accented (creating a pipeline is the thing this product is for); the others
  // are quiet, so the top of the rail reads as a toolbar rather than as three
  // competing buttons in blue, amber and green.
  { href: '/dashboard/pipelines?create=1', label: 'Create pipeline', icon: Plus, color: 'bg-brand-solid text-white hover:bg-brand-solid-strong', requiredPermission: 'pipelines:write' },
  { href: '/dashboard/plugins?create=1', label: 'Add plugin', icon: Plus, color: 'bg-surface-muted text-fg-muted hover:text-fg', requiredPermission: 'plugins:write' },
  { href: '/dashboard/downloads', label: 'Get the CLI', icon: Download, color: 'bg-surface-muted text-fg-muted hover:text-fg' },
];

// ---------------------------------------------------------------------------
// Journey-based information architecture. Sidebar groups map to what a
// developer is trying to DO — Home (orient) → Build (author) → Run (ship,
// operate and watch) → Insights (analyze and govern) — then the org-scoped
// Organization section and the system-admin Platform section, which is split
// into sub-groups because it is the longest list in the app.
//
// Personal settings and help are NOT sidebar sections: they live in the top
// bar's avatar menu and "?" menu (`placement`). They stay in this list so ⌘K
// finds them and `page-access.ts` keeps deriving their page gates.
//
// The tabs of Inbox (Messages, Access requests), Members (Teams, Roles,
// Invitations) and Usage & billing (Quotas, Billing) each have a palette-only
// entry pointing at the TAB, with the tab's own gate, so ⌘K answers their names.
// ---------------------------------------------------------------------------
export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Home',
    items: [
      { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      // Notifications, messages and access requests, as tabs. Ungated: the
      // notifications tab and access requests are for every member; the
      // messages tab keeps `messages:read` (the palette-only entry below).
      {
        title: 'Inbox',
        href: '/dashboard/inbox',
        icon: Inbox,
        showsUnreadCount: true,
        keywords: 'inbox notifications action items queue',
      },
      // Developer-portal "my services": the pipelines & plugins this user owns.
      { title: 'My services', href: '/dashboard/my-services', icon: Layers },
      /*
       * The tenant's own support cases: number, status, and the response target
       * each one was opened against.
       *
       * A SEPARATE entry from Messages, not a tab on it, because the two need
       * different gates and a NavItem declares one gate for one route — and
       * because nobody types "messages" looking for a support ticket, which is
       * what the keywords on both are for.
       *
       * `requiredAnyFeature` rather than `requiredFeature`: the three support
       * levels are mutually exclusive, so naming one would lock the page for a
       * customer who bought the other.
       *
       * LOCKED, NEVER HIDDEN — and that is the whole point of the gate for a
       * paywalled product. An org without the add-on sees the row, sees it is
       * locked, routes here and gets the upsell. A support product invisible to
       * non-buyers sells nothing.
       *
       * Messages stays UNGATED by entitlement beside it, deliberately: B3's
       * carve-out requires that security reports, billing disputes and account
       * lockouts still reach us from an org holding no support add-on, so the
       * route they travel must not sit behind an entitlement.
       */
      {
        title: 'Support',
        href: '/dashboard/support',
        icon: LifeBuoy,
        requiredPermission: 'messages:read',
        requiredAnyFeature: SUPPORT_FEATURE_FLAGS,
        keywords: 'support case ticket help response target sla incident contact desk',
      },
      // The Messages tab of Inbox, by name in ⌘K.
      {
        title: 'Messages',
        href: '/dashboard/inbox?tab=messages',
        icon: MessageSquare,
        requiredPermission: 'messages:read',
        paletteOnly: true,
        keywords: 'messages inbox announcement conversation thread',
      },
      // The Access requests tab of Inbox. NO permission gate on purpose: the
      // person most often asked is the impersonated user, who is usually not an
      // admin. The server filters what each person sees.
      {
        title: 'Access requests',
        href: '/dashboard/inbox?tab=access-requests',
        icon: KeyRound,
        paletteOnly: true,
        keywords: 'access request impersonation view account viewing session approve',
      },
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
    label: 'Run',
    // Pinned open — ship, operate and watch surfaces are frequently hit.
    alwaysExpanded: true,
    items: [
      // Deployed-pipelines registry (view/register/deregister + drift vs config).
      { title: 'Deployments', href: '/dashboard/deployments', icon: Rocket, requiredPermission: 'pipelines:read', keywords: 'deliver ship' },
      // Per-pipeline run health.
      { title: 'Executions', href: '/dashboard/executions', icon: Activity, requiredPermission: 'reports:read' },
      // Plugin-build queue + failed-build triage.
      { title: 'Builds', href: '/dashboard/build-queue', icon: Container, requiredPermission: 'plugin_queue:manage', extraActivePaths: ['/dashboard/triage'] },
      // The failed-build (DLQ) tab of Builds, by name in ⌘K.
      { title: 'Build triage', href: '/dashboard/triage', icon: Wrench, requiredPermission: 'plugins:write', paletteOnly: true },
      // Application logs (Loki). Rides `observability:read` — already in the
      // member bundle — so logs appear for existing roles with no migration;
      // DOWNLOADING them additionally needs `logs:export`, checked on the page.
      { title: 'Logs', href: '/dashboard/logs', icon: ScrollText, requiredPermission: 'observability:read' },
      // The landing page lists the dashboards the caller can see (GET /dashboards),
      // which the platform gates on `dashboards:read` — in the member bundle, so
      // every built-in role keeps it. Server-side $ORG substitution still scopes
      // the metrics inside a dashboard to the viewer's own org.
      { title: 'Observability', href: '/dashboard/observability', icon: BarChart3, requiredPermission: 'dashboards:read', keywords: 'metrics dashboards grafana monitoring' },
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
    label: 'Insights',
    items: [
      { title: 'Reports', href: '/dashboard/reports', icon: FileBarChart, requiredPermission: 'reports:read' },
      { title: 'Compliance', href: '/dashboard/compliance', icon: Shield, requiredPermission: 'compliance:read', keywords: 'govern policy' },
      // Security audit trail.
      // `audit:read`, not the coarse admin label. The route is `any(audit:read)`,
      // the permission is org-assignable and in the admin bundle (so every admin
      // keeps the page), and TWO Role templates hand it out — Security Officer
      // and Access Approver. On `adminOnly` both templates granted a permission
      // whose only UI was locked behind a label their holders do not have.
      // Its activity charts sit under /observability, so `extraActivePaths`
      // keeps this row (not Observability) lit there.
      {
        title: 'Audit log',
        href: '/dashboard/audit',
        icon: History,
        requiredPermission: 'audit:read',
        extraActivePaths: ['/dashboard/observability/audit-activity'],
        keywords: 'govern audit trail',
      },
      // Org-wide audit activity charts — same audience as the Audit log.
      { title: 'Audit activity', href: '/dashboard/observability/audit-activity', icon: LineChart, requiredPermission: 'observability:read', paletteOnly: true },
    ],
  },
  {
    label: 'Organization',
    items: [
      // Members, teams, roles and invitations as tabs. Each TAB keeps its own
      // permission (the palette-only entries below), so the row shows for anyone
      // holding ANY of them. `requiredAnyPermission` is not derived into a page
      // gate: the tabbed page enforces "any of these" itself and gates each tab.
      {
        title: 'Members',
        href: '/dashboard/members',
        icon: UsersRound,
        requiredAnyPermission: ['members:manage', 'roles:manage', 'invitations:manage'],
        keywords: 'members people users roster',
      },
      // Quotas and billing as tabs; the same "any tab" rule, as whole gates:
      // the billing tab also needs the billing SERVICE enabled, so a viewer who
      // holds only `billing:read` on a billing-disabled install sees no row.
      {
        title: 'Usage & billing',
        href: '/dashboard/usage',
        icon: Gauge,
        requiredAnyOf: [
          { permission: 'quotas:read' },
          { permission: 'billing:read', requiresBillingEnabled: true },
        ],
        keywords: 'usage quotas limits billing plan subscription invoices',
      },
      // The org tab of the settings page; its profile tab is in the avatar menu.
      // SSO and incident reporting are sub-pages (`/dashboard/settings/*`), so
      // this row stays lit on them too.
      {
        title: 'Org settings',
        href: '/dashboard/settings?tab=organization',
        icon: Settings,
        keywords: 'organization settings configuration org',
      },
      // Teams (sub-organizations) are a tab on Members. With no entry of its own,
      // "teams" was unfindable in ⌘K and invisible to an org that has none yet,
      // which is exactly the org that needs to find the create control.
      {
        title: 'Teams',
        href: '/dashboard/members?tab=teams',
        icon: Building2,
        requiredPermission: 'members:manage',
        paletteOnly: true,
        keywords: 'team teams sub-organization suborg child org hierarchy create team',
      },
      { title: 'Roles', href: '/dashboard/members?tab=roles', icon: ShieldCheck, requiredPermission: 'roles:manage', paletteOnly: true, keywords: 'roles permissions groups rbac' },
      { title: 'Invitations', href: '/dashboard/members?tab=invitations', icon: Mail, requiredPermission: 'invitations:manage', paletteOnly: true, keywords: 'invite invitations pending' },
      { title: 'Quotas', href: '/dashboard/usage?tab=quotas', icon: Gauge, requiredPermission: 'quotas:read', paletteOnly: true, keywords: 'quotas limits usage' },
      // Gated by the `billing:read` permission AND by whether the billing SERVICE
      // is enabled in this deployment (`requiresBillingEnabled` → /api/billing/config).
      // Deliberately NOT a per-user feature-flag gate — billing visibility is a
      // deployment/permission concern, not a tier entitlement.
      { title: 'Billing', href: '/dashboard/usage?tab=billing', icon: CreditCard, requiredPermission: 'billing:read', requiresBillingEnabled: true, paletteOnly: true, keywords: 'billing plan subscription invoices payment stripe' },
      // Org owner/admin SSO self-service. Gated by the dedicated `org_idp:write`
      // permission (split out of `org_settings:write`) AND the `sso` tier entitlement;
      // the page + backend re-enforce both. Locked (not hidden) off-plan in ⌘K.
      { title: 'Single sign-on', href: '/dashboard/settings/sso', icon: Fingerprint, requiredPermission: 'org_idp:write', requiredFeature: 'sso', paletteOnly: true, keywords: 'sso saml oidc idp identity provider org settings' },
      // Org-admin incident-reporting setup (DORA post-deploy CFR + MTTR). Stays
      // `adminOnly` rather than taking a single permission, and this is the one
      // place in the sweep where that is the RIGHT answer: the page's controls
      // span two permissions (`org_settings:write` to save the config,
      // `reports:read` for the wiring test), and a page gate naming either one
      // admits a viewer that the other control then refuses. `adminOnly` covers
      // both. Also gated on the `advanced_reporting` entitlement, like DORA.
      { title: 'Incident reporting', href: '/dashboard/settings/incident-reporting', icon: Siren, adminOnly: true, requiredFeature: 'advanced_reporting', paletteOnly: true, keywords: 'incident reporting dora mttr cfr pagerduty opsgenie org settings' },
    ],
  },
  {
    // Platform-wide administration (system admins only). Kept separate from the
    // org-scoped "Organization" section above so the two scopes aren't confused,
    // and split into sub-groups (`group`) because it is the longest list.
    label: 'Platform',
    items: [
      // `orgs:read`, which is what `GET /organizations` actually asks for — not
      // `platform:read`, the DEPLOY's own configuration. The two were one
      // permission until they were split, and the split exists so that holding
      // the customer roster does not also hand over the deployment internals:
      // Support Agent and Console Administrator carry `orgs:read` for exactly
      // this page, and a `platform:read` gate here made that pointless.
      { title: 'All organizations', href: '/dashboard/organizations', icon: Building2, requiredPermission: 'orgs:read', group: 'Tenants' },
      { title: 'All users', href: '/dashboard/users', icon: Users, systemAdminOnly: true, group: 'Tenants' },
      // The fleet SSO roster is a TAB on All organizations. Kept findable in ⌘K.
      {
        title: 'SSO roster',
        href: '/dashboard/organizations?tab=sso',
        icon: Fingerprint,
        requiredPermission: 'org_idp:write',
        paletteOnly: true,
        group: 'Tenants',
        keywords: 'sso idp saml oidc identity provider roster which orgs',
      },
      { title: 'Registry', href: '/dashboard/registry', icon: Boxes, requiredPermission: 'registry:read', group: 'Catalog' },
      // The managed pipeline toolchain (build image + cdk-synth releases):
      // canary, promotion, adoption, recovery. `toolchain:operate` is
      // system-org-only and also the page's read gate; `systemOrgOnly` hides
      // the row from a superadmin acting inside a tenant org, where the routes
      // refuse (the page says "not available" on a deep link).
      {
        title: 'Toolchain',
        href: '/dashboard/toolchain',
        icon: Wrench,
        requiredPermission: 'toolchain:operate',
        systemOrgOnly: true,
        group: 'Catalog',
        keywords: 'toolchain pipeline-bootstrap cdk-synth build image release canary promote platform default yank rollback',
      },
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
        group: 'Catalog',
        keywords: 'ecosystem moderation moderate publish queue publisher verification ecosystem manager marketplace',
      },
      // The Ecosystem console's Retention tab: superseded system plugin
      // versions, the dry run and "Run a pass now".
      {
        title: 'Plugin retention',
        href: '/dashboard/admin/ecosystem?tab=storage&section=retention',
        icon: Store,
        requiredPermission: 'plugins:moderate',
        systemOrgOnly: true,
        group: 'Catalog',
        keywords: 'retention superseded plugin versions deprecate yank reclaim storage cleanup prune',
      },
      // Every org's runner signing-key status (never key material) and the
      // platform pause toggle for all runner traffic. System org only: the
      // routes behind it are requireSystemOrgPermission('orgs:read').
      {
        title: 'Runner signing keys',
        href: '/dashboard/admin/runner-signing-keys',
        icon: KeyRound,
        requiredPermission: 'orgs:read',
        systemOrgOnly: true,
        group: 'Catalog',
        keywords: 'runner signing key rotation jwks pause runs deliveries kill switch over age unreadable',
      },
      // Fleet-wide billing admin. Its sibling pages (campaigns, discounts,
      // promotions, offers) are rows of their own in Commerce, so each lights
      // its own row. All share the billing-service gate; Promotions additionally
      // needs BILLING_PROMOTIONS_ENABLED server-side (its page handles that).
      { title: 'Billing admin', href: '/dashboard/admin/billing', icon: Landmark, requiredPermission: 'billing:operate', requiresBillingEnabled: true, group: 'Commerce' },
      { title: 'Campaigns', href: '/dashboard/campaigns', icon: Megaphone, requiredPermission: 'billing:operate', requiresBillingEnabled: true, group: 'Commerce' },
      { title: 'Discounts', href: '/dashboard/discounts', icon: Percent, requiredPermission: 'billing:operate', requiresBillingEnabled: true, group: 'Commerce' },
      { title: 'Promotions', href: '/dashboard/promotions', icon: Megaphone, requiredPermission: 'billing:operate', requiresBillingEnabled: true, group: 'Commerce' },
      // Expansion offers. `subscriptions:read` rather than `billing:operate`,
      // matching the Overview tab and the routes it reads — an Account Manager
      // who can run campaigns is not necessarily the Role that reviews what an
      // automated granter did fleet-wide.
      { title: 'Offers', href: '/dashboard/admin/offers', icon: Sparkles, requiredPermission: 'subscriptions:read', requiresBillingEnabled: true, group: 'Commerce' },
      // The support queue: every open case across ALL tenants, longest-waiting
      // first. Gated on `support_cases:write`, which is what the routes behind it
      // now require — `messages:read` could not stand for this, because ordinary
      // members hold it in every tenant while this surface spans all of them.
      {
        title: 'Support queue',
        href: '/dashboard/admin/support',
        icon: LifeBuoy,
        requiredPermission: 'support_cases:write',
        group: 'Operations',
        keywords: 'support queue case ticket triage ageing sla response',
      },
      // The cascade outbox: every downstream leg of an org purge or a user
      // erasure, and the Redrive for a dead or stuck one (the
      // PlatformCascadeLegDead runbook step). System org only: the routes are
      // requireSystemOrgPermission('platform:read'), the redrive 'orgs:manage'.
      {
        title: 'Cascade outbox',
        href: '/dashboard/admin/cascade',
        icon: Workflow,
        requiredPermission: 'platform:read',
        systemOrgOnly: true,
        group: 'Operations',
        keywords: 'cascade outbox org purge user erasure gdpr dead leg redrive redeliver stuck',
      },
      { title: 'Platform settings', href: '/dashboard/admin/settings', icon: SlidersHorizontal, requiredPermission: 'platform:read', group: 'Operations' },
    ],
  },
  {
    // The top-bar avatar menu. Personal, so ungated.
    label: 'Account',
    placement: 'account',
    items: [
      { title: 'Profile', href: '/dashboard/settings?tab=profile', icon: UserRound, keywords: 'profile account name email password' },
      // ONE home for sign-in factors, sessions, access keys and the org's
      // service accounts.
      { title: 'Security', href: '/dashboard/security', icon: ShieldCheck, keywords: 'passkey totp mfa two-factor recovery codes sessions access keys tokens' },
      { title: 'Notification preferences', href: '/dashboard/notifications', icon: Bell, keywords: 'notifications email opt out alerts' },
    ],
  },
  {
    // The top-bar "?" menu.
    label: 'Help',
    placement: 'help',
    items: [
      { title: 'Help', href: '/dashboard/help', icon: HelpCircle, keywords: 'docs documentation guide' },
      { title: 'API catalog', href: '/dashboard/api-catalog', icon: Code, keywords: 'api reference openapi endpoints' },
      { title: 'Downloads', href: '/dashboard/downloads', icon: Download, keywords: 'cli download install command line' },
    ],
  },
];

/** The sections the left rail renders, in order. */
export const SIDEBAR_SECTIONS: NavSection[] = NAV_SECTIONS.filter((s) => (s.placement ?? 'sidebar') === 'sidebar');

const sectionAt = (placement: NavPlacement): NavSection => {
  const section = NAV_SECTIONS.find((s) => s.placement === placement);
  if (!section) throw new Error(`no nav section for placement ${placement}`);
  return section;
};
/** The top-bar avatar menu's links. */
export const ACCOUNT_MENU_SECTION: NavSection = sectionAt('account');
/** The top-bar "?" menu's links. */
export const HELP_MENU_SECTION: NavSection = sectionAt('help');

/**
 * Split a section's items into consecutive sub-groups, in first-appearance
 * order. Items with no `group` form a leading unnamed run.
 */
export function groupNavItems(items: NavItem[]): { group?: string; items: NavItem[] }[] {
  const out: { group?: string; items: NavItem[] }[] = [];
  for (const item of items) {
    const existing = out.find((g) => g.group === item.group);
    if (existing) existing.items.push(item);
    else out.push({ group: item.group, items: [item] });
  }
  return out;
}

/** `true` when `path` is `prefix` or a sub-route of it. */
const underPath = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

/**
 * The one item among `items` that the URL `currentPath` belongs to, or
 * `undefined`. `currentPath` may carry a query (`router.asPath`).
 *
 * The most specific match wins, so a URL lights exactly one row:
 *  - an href with a query (`/dashboard/settings?tab=organization`) matches its
 *    own path only when every query value in the href matches, and any
 *    sub-route of it (`/dashboard/settings/sso`) regardless;
 *  - a bare href matches its path and sub-routes (`/dashboard` matches only
 *    itself);
 *  - `extraActivePaths` match their path and sub-routes;
 *  - the longest matched path wins, and an exact query match beats a path match.
 */
export function activeNavItem(items: NavItem[], currentPath: string): NavItem | undefined {
  const [rawPath, rawQuery = ''] = currentPath.split('#')[0].split('?');
  const path = rawPath.length > 1 ? rawPath.replace(/\/$/, '') : rawPath;
  const query = new URLSearchParams(rawQuery);

  let best: { item: NavItem; score: number } | undefined;
  const offer = (item: NavItem, score: number) => {
    if (!best || score > best.score) best = { item, score };
  };

  for (const item of items) {
    const [hrefPath, hrefQuery] = item.href.split('?');
    if (hrefPath === '/dashboard') {
      if (path === '/dashboard') offer(item, hrefPath.length);
    } else if (hrefQuery) {
      const wanted = [...new URLSearchParams(hrefQuery)];
      if (path === hrefPath && wanted.every(([k, v]) => query.get(k) === v)) offer(item, hrefPath.length + 0.5);
      else if (path.startsWith(`${hrefPath}/`)) offer(item, hrefPath.length);
    } else if (underPath(path, hrefPath)) {
      offer(item, hrefPath.length);
    }
    for (const extra of item.extraActivePaths ?? []) {
      if (underPath(path, extra)) offer(item, extra.length);
    }
  }
  return best?.item;
}

/** What the sidebar and ⌘K know about the viewer when they gate the nav. */
export interface NavVisibilityContext {
  isAdmin: boolean;
  isSuperAdmin: boolean;
  hasPermission: (perm: Permission) => boolean;
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
  if (item.requiredAnyOf && !item.requiredAnyOf.some((g) =>
    ctx.hasPermission(g.permission) && (!g.requiresBillingEnabled || !!ctx.billingEnabled))) return false;
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
  if (ctx.isSuperAdmin) return undefined;
  // The OR form first: holding ANY member unlocks it, and the flag reported
  // when none is held is the FIRST listed -- the cheapest route in, which is
  // the right thing to show somebody who has none of them.
  const anyOf = item.requiredAnyFeature;
  if (anyOf?.length) {
    return anyOf.some((f) => ctx.isFeatureEnabled?.(f)) ? undefined : anyOf[0];
  }
  if (!item.requiredFeature) return undefined;
  return ctx.isFeatureEnabled?.(item.requiredFeature) ? undefined : item.requiredFeature;
}
