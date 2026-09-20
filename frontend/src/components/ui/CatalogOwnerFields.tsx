// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import { Users } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { useFetch } from '@/hooks/useFetch';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import api from '@/lib/api';
import type { OwnerType, Visibility } from '@/types';

/** The owner a catalog entity is assigned to, as this control models it. */
export interface CatalogOwner {
  ownerId?: string | null;
  ownerType?: OwnerType | null;
}

/** Props for {@link CatalogOwnerFields}. */
interface CatalogOwnerFieldsProps {
  /** Current owner (from the fetched record). */
  value: CatalogOwner;
  /** Called with the new owner when the admin picks one. */
  onChange: (owner: CatalogOwner) => void;
  /** The entity's current visibility — a team can only READ it at the `public`
   *  rung, so the warning depends on it. */
  visibility: Visibility;
  /** Raise the visibility to `public` (only supplied when the viewer holds the
   *  entity's `:publish` permission). Omitted ⇒ the control explains instead. */
  onShareWithTeams?: () => void;
  /** Whether the viewer may write `ownerId`/`ownerType` at all — the server
   *  drops them for a non-admin, so a member gets a read-only explanation. */
  canAssign: boolean;
  /** Who "a person" means when switching back off a team owner: the record's own
   *  user owner if it had one, else its creator. The server schema requires a
   *  non-empty `ownerId`, so there is no "clear the owner" option — handing back
   *  a team-owned entity has to name the person it returns to. */
  personOwnerId: string;
  /** Display name for {@link personOwnerId}, when the caller can resolve one. */
  personOwnerLabel?: string;
  /** Plural noun for the copy — `'pipelines'` / `'plugins'`. */
  entityNoun: string;
  /** The entity's publish permission, named when the viewer lacks it
   *  (`'pipelines:publish'` / `'plugins:publish'`). */
  publishPermission: string;
  /** Distinguishes the control's DOM ids when two ever render on one page. */
  idPrefix?: string;
  disabled?: boolean;
}

const TEAM_PREFIX = 'team:';

/**
 * Owner + team-access control for a catalog entity (pipelines and plugins).
 *
 * This is the answer to "I made a team — how do I give it this?", and the
 * answer is deliberately NOT a move. A pipeline or plugin belongs to the org
 * that created it, permanently: both tables are FORCE'd RLS with
 * `WITH CHECK (org_id = current_org_id())`, so Postgres rejects an UPDATE that
 * rewrites `org_id`, and the rows that reference them (registry, events,
 * deployment outcomes, incidents, compliance scans) each carry their own
 * `org_id` too. Re-homing an entity would mean a multi-table,
 * multi-tenant-context migration with no atomicity — and it would buy nothing:
 * quota pools at the account root and a team's own limits are seeded to -1, so
 * moving one between orgs in a single account changes no counter anywhere.
 *
 * What the model DOES support, and what this exposes:
 *
 *   - `ownerType: 'team'` + `ownerId: <team org id>` — the catalog owner, what
 *     "my services", the owner filter and the scorecard leaderboard key off.
 *   - `visibility: 'public'` — the rung a team org actually reads its parent's
 *     rows at. Pipelines and plugins share ONE predicate for this
 *     (`AccessControlQueryBuilder.buildAccessControl`, widened to
 *     `orgId = parentOrgId AND visibility = 'public'`), and both services pass
 *     the team's `parentOrgId` on every read path, so the warning below is
 *     equally true of either. Owning something the team cannot see would be a
 *     label with nothing behind it, so the two are shown together.
 *
 * Lives in the UI kit next to `VisibilitySelect`, which is shared by the same
 * entities for the same reason and likewise takes its `:publish` permission as
 * a parameter.
 */
export function CatalogOwnerFields({
  value, onChange, visibility, onShareWithTeams, canAssign,
  personOwnerId, personOwnerLabel, entityNoun, publishPermission, idPrefix = 'catalog', disabled,
}: CatalogOwnerFieldsProps) {
  const { activeOrg, hasChildOrgs, isChildOrg } = useOrgHierarchy();
  const orgId = activeOrg?.id;
  const selectId = `${idPrefix}Owner`;

  // Teams of the ACTIVE org. Only a root org parents teams, so a team org (or a
  // flat org) issues no request at all. Best-effort: a failed read just leaves
  // the team options out.
  const teamsQ = useFetch<Array<{ orgId: string; orgName: string }>>(async (signal) => {
    if (!orgId || !hasChildOrgs || isChildOrg) return [];
    try {
      return (await api.getOrganizationTeams(orgId, { signal })).data?.teams ?? [];
    } catch {
      return [];
    }
  }, [orgId, hasChildOrgs, isChildOrg]);
  const teams = teamsQ.data ?? [];

  const selected = useMemo(() => {
    if (value.ownerType === 'team' && value.ownerId) return `${TEAM_PREFIX}${value.ownerId}`;
    return 'user';
  }, [value.ownerId, value.ownerType]);

  // A team owner the roster no longer lists (deleted team, or a teams read that
  // failed) must still render as the current selection rather than silently
  // snapping the control to "a person" — which a save would then persist.
  const orphanTeamId = value.ownerType === 'team' && value.ownerId && !teams.some((t) => t.orgId === value.ownerId)
    ? value.ownerId
    : null;

  const teamOwned = value.ownerType === 'team';
  const teamCanRead = visibility === 'public';

  if (!hasChildOrgs && !teamOwned) return null;

  return (
    <div data-testid="catalog-owner-fields">
      <label className="label" htmlFor={selectId}>Owner</label>
      <Select
        id={selectId}
        value={selected}
        disabled={disabled || !canAssign}
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith(TEAM_PREFIX)) onChange({ ownerId: v.slice(TEAM_PREFIX.length), ownerType: 'team' });
          else onChange({ ownerId: personOwnerId, ownerType: 'user' });
        }}
      >
        <option value="user">{personOwnerLabel ? `${personOwnerLabel} (a person)` : 'A person'}</option>
        {orphanTeamId && <option value={`${TEAM_PREFIX}${orphanTeamId}`}>Team {orphanTeamId} (no longer listed)</option>}
        {teams.map((t) => (
          <option key={t.orgId} value={`${TEAM_PREFIX}${t.orgId}`}>Team: {t.orgName}</option>
        ))}
      </Select>
      {!canAssign ? (
        <p className="text-xs text-fg-subtle mt-1">Only an organization admin can reassign ownership.</p>
      ) : (
        <p className="text-xs text-fg-subtle mt-1">
          {`These ${entityNoun} stay in the organization that created them`} — assigning a team sets who owns it, not where it lives.
        </p>
      )}
      {teamOwned && !teamCanRead && (
        <p className="text-xs text-warning-strong mt-1 inline-flex items-start gap-1.5" data-testid="team-visibility-warning">
          <Users className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Teams only see this organization&apos;s <span className="font-medium">public</span> {entityNoun}, so the owning team
            can&apos;t open this one yet.
            {onShareWithTeams
              ? <> <button type="button" className="action-link" onClick={onShareWithTeams} disabled={disabled}>Set visibility to public</button>.</>
              : <> You need <code className="text-2xs">{publishPermission}</code> to change that.</>}
          </span>
        </p>
      )}
    </div>
  );
}
