// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/SearchInput';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { StepUpModal } from '@/components/admin/StepUpModal';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { interpretImpersonationStart } from '@/lib/impersonation-start';
import type { OrganizationMember } from '@/types';

interface TeamMemberAccessProps {
  /** The teams directly under the active (root) organization. */
  teams: { orgId: string; orgName: string }[];
  currentUserId: string;
  readOnly: boolean;
}

/**
 * View a team member's account, from the parent organization.
 *
 * A parent organization's admins already administer its teams, so viewing a
 * team member's account needs no approval — the team's admins are told, not
 * asked. This panel is where that happens.
 *
 * It is deliberately separate from the main roster rather than a button on it.
 * The roster lists the ACTIVE organization's own members, and viewing a member
 * of your own organization isn't something a parent admin can do — a button
 * there would always be refused. Only a TEAM's roster is offered here, and the
 * request names that team so the session is scoped to it.
 *
 * Read-only by design: managing a team's members still happens from the team.
 */
export function TeamMemberAccess({ teams, currentUserId, readOnly }: TeamMemberAccessProps) {
  const [teamId, setTeamId] = useState(teams[0]?.orgId ?? '');
  const [search, setSearch] = useState('');
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<OrganizationMember | null>(null);

  const team = teams.find((t) => t.orgId === teamId);

  const load = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    try {
      const res = await api.getOrganizationMembers(teamId, {
        limit: 25,
        status: 'active',
        ...(search ? { search } : {}),
      });
      setMembers(res.data?.members ?? []);
      setError(null);
    } catch (e) {
      setError(formatError(e, 'Could not load that team\'s members'));
    } finally {
      setLoading(false);
    }
  }, [teamId, search]);

  useEffect(() => { void load(); }, [load]);

  const view = async (member: OrganizationMember, stepUpToken: string) => {
    try {
      const outcome = interpretImpersonationStart(
        // Name the team: the session is about THIS team, whichever org the member
        // last had active.
        await api.impersonateUser(member.id, stepUpToken, { orgId: teamId }),
        'Could not open that account',
      );
      if (outcome.kind === 'started') {
        api.startImpersonation(outcome.accessToken, outcome.requestId);
        window.location.href = '/dashboard';
        return;
      }
      // A parent admin is never asked to wait, so `waiting` here means something
      // unexpected — report it rather than pretend it worked.
      setError(outcome.kind === 'failed' ? outcome.message : 'That request is waiting for approval.');
    } catch (e) {
      setError(formatError(e, 'Could not open that account'));
    } finally {
      setViewing(null);
    }
  };

  if (teams.length === 0) return null;

  return (
    <SectionCard
      icon={Eye}
      title="View a team member's account"
      description="See a team member's account exactly as they do, read-only, for 15 minutes. The team's admins are notified."
    >
      {error && <div className="mb-3"><ErrorAlert message={error} /></div>}

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="team-member-access-team" className="label">Team</label>
          <Select
            id="team-member-access-team"
            value={teamId}
            onChange={(e) => { setTeamId(e.target.value); setSearch(''); }}
          >
            {teams.map((t) => <option key={t.orgId} value={t.orgId}>{t.orgName}</option>)}
          </Select>
        </div>
        <div className="min-w-[12rem] flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search this team" />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-[var(--pb-text-muted)]">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : members.length === 0 ? (
        <p className="py-2 text-sm text-[var(--pb-text-muted)]">No active members{search ? ' match that search' : ''}.</p>
      ) : (
        <ul className="divide-y divide-[var(--pb-border)]">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.username}</p>
                <p className="truncate text-xs text-[var(--pb-text-muted)]">{m.email}</p>
              </div>
              {m.id !== currentUserId && (
                <Button type="button" variant="secondary" disabled={readOnly} onClick={() => setViewing(m)}>
                  View as user
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {viewing && (
        <StepUpModal
          action={`View ${viewing.email}'s account in ${team?.orgName ?? 'this team'}, read-only. The team's admins will be notified.`}
          onConfirmed={(token) => view(viewing, token)}
          onClose={() => setViewing(null)}
        />
      )}
    </SectionCard>
  );
}
