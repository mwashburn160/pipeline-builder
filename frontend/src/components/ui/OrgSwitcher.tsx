import { useState, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRouter } from 'next/router';
import { ChevronsUpDown, Building2, Check, Users, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import { pageGateRefuses } from '@/lib/page-access';
import { isSystemAdmin, isOrgAdmin, hasPermission } from '@/lib/auth-helpers';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import type { UserOrgMembership } from '@/types';
import { formatError } from '@/lib/constants';

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

/** "Team of Acme" when the parent's name is known, else plain "Team". */
function teamCaption(org: UserOrgMembership): string {
  return org.parentOrgName ? `Team of ${org.parentOrgName}` : 'Team';
}

/** At most this many Role names on a row before the rest collapse to "+N". */
const ROLE_CHIPS = 2;

/**
 * What a row says the viewer IS in that org.
 *
 * The ROLES, not the coarse `role` word: permissions come only from the Roles
 * assigned to a person, and `role` survives for `isAdmin`/ownership/display
 * alone. A row labelled "member" for somebody holding a `Release Manager` Role
 * names the one field that grants nothing.
 *
 * Three fallbacks, in order: an inherited-authority row has no membership and so
 * no Roles (the authority is the parent's); an org whose Roles are not assigned
 * yet, or a cached payload from before `roleNames` existed, still has `role`.
 */
function authorityLabel(org: UserOrgMembership, isTeamRow: boolean): { text: string; title?: string } {
  if (org.viaAncestor) {
    return {
      text: 'via parent',
      title: 'Admin access through the parent organization — not a member of this team',
    };
  }
  const roles = org.roleNames ?? [];
  if (roles.length === 0) return { text: isTeamRow ? 'team' : org.role };
  if (roles.length <= ROLE_CHIPS) return { text: roles.join(' · '), title: roles.join(', ') };
  return {
    text: `${roles.slice(0, ROLE_CHIPS).join(' · ')} +${roles.length - ROLE_CHIPS}`,
    title: roles.join(', '),
  };
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
  // The active org's hierarchy state comes from the ONE shared source rather
  // than being re-derived from `activeOrg.parentOrgId` here — the switcher is
  // the org-context anchor, so it must read the same signal every other
  // hierarchy surface gates on.
  const { isChildOrg: activeIsTeam, viaAncestor: activeViaAncestor } = useOrgHierarchy();
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  /** The switch awaiting its new identity — see the landing effect below. */
  const pendingSwitchRef = useRef<{ orgId: string; orgName: string } | null>(null);

  /**
   * Keyboard behaviour a `role="menu"` owes the user: Escape, arrow keys, and
   * focus never left inside a vanished menu. `organizations.length > 1` is
   * re-derived here (rather than reusing `canSwitch`) because that constant is
   * declared after the `!user` early return, below these hooks.
   */
  const menuItems = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open || organizations.length <= 1) return;
    const items = menuItems();
    const index = items.indexOf(document.activeElement as HTMLElement);

    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      ref.current?.querySelector<HTMLElement>('button')?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      const next = e.key === 'ArrowDown'
        ? (index < 0 ? 0 : (index + 1) % items.length)
        : (index <= 0 ? items.length - 1 : index - 1);
      items[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
    } else if (e.key === 'Tab') {
      // Tabbing out of a menu is a dismissal, not navigation within it.
      setOpen(false);
    }
  };

  // Move focus into the menu on open, so the arrow keys have a starting point.
  useEffect(() => {
    if (!open || organizations.length <= 1) return;
    menuItems()[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- menuItems() reads a ref
  }, [open, organizations.length]);

  /**
   * Land the switch, once the new identity has arrived.
   *
   * THE FAILURE THIS REMOVES. Permissions are per-organization, and the switch
   * used to re-render the SAME path. Switch into an org whose Role lacks
   * `billing:read` while standing on /dashboard/billing and the page the person
   * was already reading turns into `<AccessDenied>` — a refusal produced by
   * their own working click, with no hint that the click is what did it.
   *
   * So the gate is re-evaluated against the POST-switch identity and, when it no
   * longer holds, the person goes to the dashboard with a toast that names the
   * page that did not come along. When it does hold, the original behaviour
   * stands: re-render in place.
   *
   * Keyed on the user object: `switchOrganization` resolves only after a forced
   * refresh, so the first render carrying the new `organizationId` is the one
   * with the new permissions.
   */
  useEffect(() => {
    const pending = pendingSwitchRef.current;
    if (!pending || !user || user.organizationId !== pending.orgId) return;
    pendingSwitchRef.current = null;
    setSwitching(false);

    const refused = pageGateRefuses(router.pathname, {
      isSuperAdmin: isSystemAdmin(user),
      isOrgAdmin: isOrgAdmin(user),
      hasPermission: (permission) => hasPermission(user, permission),
    });
    if (refused) {
      toast.info(`Switched to ${pending.orgName}. This page isn't available there, so you're on the dashboard.`);
      void router.replace('/dashboard');
      return;
    }
    toast.success(`Switched to ${pending.orgName}`);
    void router.replace(router.asPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `router` and `toast` are stable for this effect's purpose; re-running on every router change would re-fire the landing
  }, [user]);

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

  const activeName = activeOrg?.name || user.organizationName || 'Select org';

  /**
   * An inherited-authority session is IN a team it is not a member of: no
   * roster row, no seat, and the role on screen is the parent's authority, not
   * a membership. The menu already marks the row "via parent"; the anchor must
   * keep saying so once the switch has happened, or the team reads as one the
   * viewer belongs to.
   */
  const viaAncestorNote = activeViaAncestor
    ? `Admin access through ${activeOrg?.parentOrgName ?? 'the parent organization'} — you are not a member of this team`
    : undefined;

  const handleSwitch = async (orgId: string) => {
    if (orgId === user.organizationId || switching) return;
    setSwitching(true);
    // Recorded BEFORE the await, not after. `switchOrganization` resolves only
    // once a forced profile refresh has applied, and that refresh re-renders —
    // so a ref set afterwards can be set too late: the render carrying the new
    // identity has already run the landing effect, found no pending switch, and
    // the effect will not re-run because its dependency has not changed again.
    // Set first, and let the effect's own `organizationId` check be what decides.
    const orgName = organizations.find(o => o.id === orgId)?.name || orgId;
    pendingSwitchRef.current = { orgId, orgName };
    try {
      await switchOrganization(orgId);
      setOpen(false);
    } catch (err) {
      pendingSwitchRef.current = null;
      toast.error(formatError(err, 'Failed to switch organization'));
      setSwitching(false);
    }
  };

  // Shared dropdown menu (same content across variants; only the anchoring
  // differs: header pops down left-aligned at a fixed width, the collapsed rail
  // pops out to the right, and the sidebar card fills its own width).
  const menuPosition = variant === 'header'
    ? 'left-0 top-full mt-1.5 w-64 max-w-[calc(100vw-2rem)]'
    : collapsed
      ? 'left-full top-0 ml-2 w-60'
      : 'left-0 right-0 top-full mt-1.5';
  const menu = open && canSwitch && (
    <div
      className={`absolute z-50 bg-surface border border-default rounded-xl shadow-xl overflow-hidden ${menuPosition}`}
      role="menu"
    >
      <div className="px-3 py-2 border-b border-default text-2xs font-semibold uppercase tracking-wide text-fg-subtle">
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
                  ? 'bg-info-bg text-info font-medium'
                  : 'text-fg-muted hover:bg-surface-muted'
              }`}
            >
              {depth > 0 || org.parentOrgId
                ? <Users className="w-3.5 h-3.5 text-fg-subtle shrink-0" aria-hidden />
                : <Building2 className="w-3.5 h-3.5 text-fg-subtle shrink-0" aria-hidden />}
              <span className="flex-1 min-w-0 text-left">
                <span className="block truncate">{org.name}</span>
                {/* A team listed at the top level (the user isn't a member of its
                    parent) must still read as a team, not an account. */}
                {depth === 0 && org.parentOrgId && (
                  <span className="block truncate text-2xs font-normal text-fg-subtle">
                    {teamCaption(org)}
                  </span>
                )}
              </span>
              {/* `switch-org` REFUSES an aal-1 session switching into an org
                  whose `adminActionsRequireMfa` policy is on, so this says so
                  BEFORE the click instead of afterwards as an error. The title
                  sits on a wrapper: lucide icons take no `title`. */}
              {org.requiresMfa && (
                <span
                  className="shrink-0 inline-flex"
                  title="This organization requires multi-factor authentication — sign in with a passkey or an authenticator code to switch here"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-fg-subtle" aria-label="Requires multi-factor authentication" />
                </span>
              )}
              <span
                className="text-xs text-fg-subtle shrink-0 max-w-[8rem] truncate"
                title={authorityLabel(org, depth > 0).title}
              >
                {authorityLabel(org, depth > 0).text}
              </span>
              {isActive && <Check className="w-4 h-4 text-brand shrink-0" />}
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
      // Delegates arrow/Home/End/Escape navigation for the menu it wraps; the wrapper itself is not a control.
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div ref={ref} onKeyDown={onMenuKeyDown} className={`relative ${className}`}>
        <button
          type="button"
          onClick={() => canSwitch && setOpen(!open)}
          // The pill truncates the name on narrow screens, so the full name
          // rides in the accessible name and the hover title.
          aria-label={`${canSwitch ? `Switch organization (current: ${activeName})` : `Organization: ${activeName}`}${viaAncestorNote ? `. ${viaAncestorNote}` : ''}`}
          title={viaAncestorNote ? `${activeName} — ${viaAncestorNote}` : activeName}
          aria-haspopup={canSwitch ? 'menu' : undefined}
          aria-expanded={canSwitch ? open : undefined}
          className={`inline-flex items-center gap-2 h-8 px-2 sm:px-3 max-w-full min-w-0 rounded-lg bg-violet-600 text-white shadow-sm transition-opacity ${
            canSwitch ? 'hover:opacity-90 cursor-pointer' : 'cursor-default'
          }`}
        >
          {activeIsTeam ? <Users className="w-4 h-4 shrink-0" /> : <Building2 className="w-4 h-4 shrink-0" />}
          <span className="text-sm font-semibold truncate min-w-0 max-w-[6rem] sm:max-w-[14rem]">{activeName}</span>
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
      // Delegates arrow/Home/End/Escape navigation for the menu it wraps; the wrapper itself is not a control.
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div ref={ref} onKeyDown={onMenuKeyDown} className={`relative flex justify-center ${className}`}>
        <Tooltip content={`${canSwitch ? `Organization: ${activeName} — click to switch` : `Organization: ${activeName}`}${viaAncestorNote ? ` (${viaAncestorNote})` : ''}`}>
          <button
            type="button"
            onClick={() => canSwitch && setOpen(!open)}
            aria-label={canSwitch ? 'Switch organization' : `Organization: ${activeName}`}
            aria-haspopup={canSwitch ? 'menu' : undefined}
            aria-expanded={canSwitch ? open : undefined}
            className={`relative flex items-center justify-center w-10 h-10 rounded-lg border border-default bg-info-bg text-info transition-colors ${
              canSwitch ? 'hover:border-info-border cursor-pointer' : 'cursor-default'
            }`}
          >
            <Building2 className="w-5 h-5" />
            {canSwitch && <ChevronsUpDown className="w-3 h-3 text-fg-subtle absolute -bottom-0.5 -right-0.5 bg-surface rounded-full" />}
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
    // Delegates arrow/Home/End/Escape navigation for the menu it wraps; the wrapper itself is not a control.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={ref} onKeyDown={onMenuKeyDown} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => canSwitch && setOpen(!open)}
        aria-label={`${canSwitch ? 'Switch organization' : `Organization: ${activeName}`}${viaAncestorNote ? `. ${viaAncestorNote}` : ''}`}
        aria-haspopup={canSwitch ? 'menu' : undefined}
        aria-expanded={canSwitch ? open : undefined}
        className={`group flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg border border-default bg-surface-muted/80 shadow-sm transition-colors ${
          canSwitch ? 'hover:bg-surface hover:border-info-border cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="flex items-center justify-center w-8 h-8 rounded-md bg-info-bg text-info shrink-0">
          {activeIsTeam ? <Users className="w-4 h-4" /> : <Building2 className="w-4 h-4" />}
        </span>
        <span className="flex-1 min-w-0 text-left">
          <span className="block truncate text-2xs font-semibold uppercase tracking-wide text-fg-subtle" title={viaAncestorNote}>
            {activeIsTeam && activeOrg ? teamCaption(activeOrg) : 'Organization'}
            {viaAncestorNote && <span className="normal-case"> · via parent</span>}
          </span>
          <span className="block text-sm font-semibold text-fg truncate leading-tight">
            {activeName}
          </span>
        </span>
        {canSwitch && <ChevronsUpDown className="w-4 h-4 text-fg-subtle group-hover:text-brand shrink-0 transition-colors" />}
      </button>
      {menu}
    </div>
  );
}
