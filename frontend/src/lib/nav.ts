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
  requiredFeature?: string;
  /** Extra path prefixes that should also mark this item active (e.g. a sibling
   *  route folded into the same nav entry, like /triage under "Builds"). */
  extraActivePaths?: string[];
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const QUICK_ACTIONS: { href: string; label: string; icon: LucideIcon; color: string }[] = [
  // `?create=1` makes the target page open its create modal on arrival, so these
  // genuinely start a create flow rather than just navigating to the list.
  { href: '/dashboard/pipelines?create=1', label: 'Create Pipeline', icon: Plus, color: 'bg-blue-600' },
  { href: '/dashboard/plugins?create=1', label: 'Add Plugin', icon: Plus, color: 'bg-amber-500' },
  { href: '/dashboard/downloads', label: 'Get the CLI', icon: Download, color: 'bg-green-600' },
];

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Overview',
    items: [
      { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { title: 'Messages', href: '/dashboard/messages', icon: MessageSquare },
    ],
  },
  {
    label: 'Build',
    items: [
      { title: 'Pipelines', href: '/dashboard/pipelines', icon: GitBranch },
      { title: 'Plugins', href: '/dashboard/plugins', icon: Puzzle },
    ],
  },
  {
    label: 'Insights',
    items: [
      { title: 'Reports', href: '/dashboard/reports', icon: FileBarChart },
      // Per-pipeline run health (was only reachable from the home card).
      { title: 'Executions', href: '/dashboard/executions', icon: Activity },
      { title: 'Logs', href: '/dashboard/logs', icon: ScrollText },
      // Security audit trail (was only reachable from deep links).
      { title: 'Audit Log', href: '/dashboard/audit', icon: History, adminOnly: true },
      { title: 'Compliance', href: '/dashboard/compliance', icon: Shield, requiredPermission: 'compliance:read' },
      // Observability is visible to any authenticated user. Server-side
      // $ORG substitution scopes their view to their own org's metrics;
      // sysadmins see all orgs.
      { title: 'Observability', href: '/dashboard/observability', icon: BarChart3 },
    ],
  },
  {
    label: 'Organization',
    items: [
      { title: 'Members', href: '/dashboard/members', icon: UsersRound, requiredPermission: 'members:manage' },
      { title: 'Groups', href: '/dashboard/groups', icon: ShieldCheck, requiredPermission: 'groups:manage' },
      { title: 'Invitations', href: '/dashboard/invitations', icon: Mail, requiredPermission: 'invitations:manage' },
      { title: 'Quotas', href: '/dashboard/quotas', icon: Gauge, requiredPermission: 'quotas:read' },
      { title: 'Billing', href: '/dashboard/billing', icon: CreditCard, requiredPermission: 'billing:read', requiredFeature: 'billing' },
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
      { title: 'Builds', href: '/dashboard/build-queue', icon: Container, systemAdminOnly: true, extraActivePaths: ['/dashboard/triage'] },
      { title: 'Platform Settings', href: '/dashboard/admin/platform-settings', icon: SlidersHorizontal, systemAdminOnly: true },
    ],
  },
  {
    label: 'Settings',
    items: [
      { title: 'Profile', href: '/dashboard/settings', icon: Settings },
      { title: 'Notifications', href: '/dashboard/notifications', icon: Bell },
      { title: 'API Tokens', href: '/dashboard/tokens', icon: KeyRound },
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
  ctx: { isAdmin: boolean; isSuperAdmin: boolean; isFeatureEnabled: (name: string) => boolean; hasPermission: (perm: string) => boolean },
): boolean {
  if (item.systemAdminOnly && !ctx.isSuperAdmin) return false;
  if (item.adminOnly && !ctx.isAdmin) return false;
  if (item.requiredPermission && !ctx.hasPermission(item.requiredPermission)) return false;
  if (item.requiredFeature && !ctx.isFeatureEnabled(item.requiredFeature)) return false;
  return true;
}
