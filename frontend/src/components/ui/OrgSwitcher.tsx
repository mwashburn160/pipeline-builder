import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import { ChevronsUpDown, Building2, Check, Users } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { clearPluginCache } from '@/hooks/usePlugins';
import type { UserOrgMembership } from '@/types';

/**
 * Order memberships so teams (orgs with a `parentOrgId` present in the list)
 * render indented under their parent. Roots — and any team whose parent the
 * user isn't a member of — render at the top level. Stable input order.
 */
function nestOrgs(orgs: UserOrgMembership[]): Array<{ org: UserOrgMembership; depth: number }> {
  const byId = new Map(orgs.map(o => [o.id, o]));
  const out: Array<{ org: UserOrgMembership; depth: number }> = [];
  for (const o of orgs) {
    if (o.parentOrgId && byId.has(o.parentOrgId)) continue; // rendered under its parent
    out.push({ org: o, depth: 0 });
    for (const child of orgs) {
      if (child.parentOrgId === o.id) out.push({ org: child, depth: 1 });
    }
  }
  return out;
}

interface OrgSwitcherProps {
  /** Extra classes appended to the root container. */
  className?: string;
  /** Collapsed sidebar: render a compact icon trigger with a right-popout menu. */
  collapsed?: boolean;
  /** `header` renders a compact horizontal pill for the top app bar; `sidebar` (default) renders the vertical card. */
  variant?: 'sidebar' | 'header';
}

/**
 * Organization switcher.
 * Displays the active organization as an always-visible context anchor and, when
 * the user belongs to 2+ orgs, opens a dropdown to switch between memberships.
 */
export function OrgSwitcher({ className = '', collapsed = false, variant = 'sidebar' }: OrgSwitcherProps = {}) {
  const { user, organizations, switchOrganization } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!user) return null;

  const activeOrg = organizations.find(o => o.id === user.organizationId);

  // Always render the current-org context (so it's easy to locate); it only
  // becomes an interactive dropdown once the user belongs to 2+ orgs.
  const canSwitch = organizations.length > 1;

  const activeIsTeam = !!activeOrg?.parentOrgId;
  const activeName = activeOrg?.name || user.organizationName || 'Select org';

  const handleSwitch = async (orgId: string) => {
    if (orgId === user.organizationId || switching) return;
    setSwitching(true);
    try {
      await switchOrganization(orgId);
      clearPluginCache();
      setOpen(false);
      const orgName = organizations.find(o => o.id === orgId)?.name || orgId;
      toast.success(`Switched to ${orgName}`);
      router.replace(router.asPath);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to switch organization');
    } finally {
      setSwitching(false);
    }
  };

  // Shared dropdown menu (same content across variants; only the anchoring
  // differs: header pops down left-aligned at a fixed width, the collapsed rail
  // pops out to the right, and the sidebar card fills its own width).
  const menuPosition = variant === 'header'
    ? 'left-0 top-full mt-1.5 w-64'
    : collapsed
      ? 'left-full top-0 ml-2 w-60'
      : 'left-0 right-0 top-full mt-1.5';
  const menu = open && canSwitch && (
    <div
      className={`absolute z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden ${menuPosition}`}
      role="menu"
    >
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700/60 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
        Switch organization
      </div>
      <div className="py-1 max-h-64 overflow-y-auto">
        {nestOrgs(organizations).map(({ org, depth }) => {
          const isActive = org.id === user.organizationId;
          return (
            <button
              key={org.id}
              type="button"
              role="menuitem"
              onClick={() => handleSwitch(org.id)}
              disabled={switching}
              style={depth ? { paddingLeft: '1.75rem' } : undefined}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-medium'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}
            >
              {depth > 0
                ? <Users className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden />
                : <Building2 className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden />}
              <span className="truncate flex-1 text-left">{org.name}</span>
              <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">{depth > 0 ? 'team' : org.role}</span>
              {isActive && <Check className="w-4 h-4 text-blue-500 shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );

  // Header: a solid pill matching the sidebar quick-action buttons' style
  // (white icon/text, rounded-lg, h-8, hover:opacity-90) but in violet so it
  // reads as the org-context anchor, distinct from the blue/amber/green action
  // buttons — an org/team icon, the active name, and (when switchable) the
  // up/down affordance. Dropdown opens below, left-aligned.
  if (variant === 'header') {
    return (
      <div ref={ref} className={`relative ${className}`}>
        <button
          type="button"
          onClick={() => canSwitch && setOpen(!open)}
          aria-label={canSwitch ? 'Switch organization' : `Organization: ${activeName}`}
          aria-haspopup={canSwitch ? 'menu' : undefined}
          aria-expanded={canSwitch ? open : undefined}
          className={`inline-flex items-center gap-2 h-8 px-3 rounded-lg bg-violet-600 text-white shadow-sm transition-opacity ${
            canSwitch ? 'hover:opacity-90 cursor-pointer' : 'cursor-default'
          }`}
        >
          {activeIsTeam ? <Users className="w-4 h-4 shrink-0" /> : <Building2 className="w-4 h-4 shrink-0" />}
          <span className="text-sm font-semibold truncate max-w-[10rem] sm:max-w-[14rem]">{activeName}</span>
          {canSwitch && <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-white/80" />}
        </button>
        {menu}
      </div>
    );
  }

  // Collapsed rail: a single prominent icon button that pops the menu out to
  // the right (the full card doesn't fit in a 64px rail).
  if (collapsed) {
    return (
      <div ref={ref} className={`relative flex justify-center ${className}`}>
        <Tooltip content={canSwitch ? `Organization: ${activeName} — click to switch` : `Organization: ${activeName}`}>
          <button
            type="button"
            onClick={() => canSwitch && setOpen(!open)}
            aria-label={canSwitch ? 'Switch organization' : `Organization: ${activeName}`}
            aria-haspopup={canSwitch ? 'menu' : undefined}
            aria-expanded={canSwitch ? open : undefined}
            className={`relative flex items-center justify-center w-10 h-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 transition-colors ${
              canSwitch ? 'hover:border-blue-400 dark:hover:border-blue-600 cursor-pointer' : 'cursor-default'
            }`}
          >
            <Building2 className="w-5 h-5" />
            {canSwitch && <ChevronsUpDown className="w-3 h-3 text-gray-400 absolute -bottom-0.5 -right-0.5 bg-white dark:bg-gray-900 rounded-full" />}
          </button>
        </Tooltip>
        {menu}
      </div>
    );
  }

  // Expanded: a bordered "org card" that clearly reads as a selector — an
  // uppercase Organization/Team caption over the active name, with the
  // up/down switcher affordance on the right.
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => canSwitch && setOpen(!open)}
        aria-label={canSwitch ? 'Switch organization' : `Organization: ${activeName}`}
        aria-haspopup={canSwitch ? 'menu' : undefined}
        aria-expanded={canSwitch ? open : undefined}
        className={`group flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-800/60 shadow-sm transition-colors ${
          canSwitch ? 'hover:bg-white dark:hover:bg-gray-800 hover:border-blue-300 dark:hover:border-blue-700 cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="flex items-center justify-center w-8 h-8 rounded-md bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 shrink-0">
          {activeIsTeam ? <Users className="w-4 h-4" /> : <Building2 className="w-4 h-4" />}
        </span>
        <span className="flex-1 min-w-0 text-left">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {activeIsTeam ? 'Team' : 'Organization'}
          </span>
          <span className="block text-sm font-semibold text-gray-900 dark:text-gray-100 truncate leading-tight">
            {activeName}
          </span>
        </span>
        {canSwitch && <ChevronsUpDown className="w-4 h-4 text-gray-400 group-hover:text-blue-500 shrink-0 transition-colors" />}
      </button>
      {menu}
    </div>
  );
}
