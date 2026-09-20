// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Building2, Download, MoreHorizontal, Network, RotateCcw, Settings, Trash2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { TeamSettingsDrawer } from './TeamSettingsDrawer';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import { formatError } from '@/lib/constants';
import { formatDateMedium } from '@/lib/format';
import { triggerBlobDownload } from '@/lib/csv-export';
import type { DeletedTeam, OrgTeamRef } from '@/lib/api/domains/organizations';

/** Ties the disabled create control to the sentence that says why. */
const TEAMS_CARD_CREATE_REASON_ID = 'teams-card-create-blocked-reason';

/**
 * The parent org's teams, with everything a parent admin does to one without
 * switching into it: add a member, open it, manage its settings, export it, and
 * delete it — plus the recently-deleted teams it can still restore.
 *
 * Deleting and restoring are step-up gated (the backend `requireStepUp`), so
 * each opens ONE dialog that states what happens — the retention window — and
 * takes the factor in the same place, rather than confirming twice.
 * Every lifecycle change calls `onChanged`, which the page uses to re-read the
 * lists AND `refreshUser()` — `childOrgCount` and the org switcher move with it.
 */
export function TeamsCard({
  parentOrgId,
  parentOrgName,
  teams,
  deletedTeams,
  canManageMembers,
  canOrgSettings,
  canManageSettings,
  onOpen,
  onAddMember,
  onChanged,
  onCreateTeam,
  createTeamDisabledReason,
}: {
  parentOrgId: string;
  parentOrgName?: string;
  teams: OrgTeamRef[];
  deletedTeams: DeletedTeam[];
  /** `members:manage` — add a member / open a team. */
  canManageMembers: boolean;
  /** `org:settings` — export, delete and restore a team. */
  canOrgSettings: boolean;
  /** Any team setting this viewer may edit (name, MFA, impersonation, SSO). */
  canManageSettings: boolean;
  onOpen: (team: OrgTeamRef) => void;
  onAddMember: (team: OrgTeamRef) => void;
  onChanged: () => Promise<void>;
  /** Starts the create-team flow. Passed only when this viewer may create one
   *  (root org + `org:settings`) — the empty state used to tell people to
   *  "create a new one" and then offer nothing to click. */
  onCreateTeam?: () => void;
  /** Why creating is unavailable (e.g. the tier can't parent teams). Rendered
   *  as visible text beside the disabled control, not just as a tooltip. */
  createTeamDisabledReason?: string;
}) {
  const toast = useToast();
  const [managing, setManaging] = useState<OrgTeamRef | null>(null);
  // Deleting a team is destructive AND step-up gated, so it is ONE dialog that
  // states what is lost and takes the factor (the rule settings.tsx documents
  // for "Delete your account" and StepUpModal's own doc comment spells out).
  // This used to open a ConfirmDialog and then a StepUpModal for a single
  // delete: two modals asking the same person the same question.
  const [pendingDelete, setPendingDelete] = useState<OrgTeamRef | null>(null);
  const [pendingRestore, setPendingRestore] = useState<DeletedTeam | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  const exportTeam = async (team: OrgTeamRef) => {
    setExporting(team.orgId);
    try {
      // Raw JSON body (not an ApiResponse envelope), saved like the org export.
      const json = await api.exportOrganization(team.orgId);
      triggerBlobDownload(new Blob([json], { type: 'application/json' }), `team-${team.orgName}-export.json`);
      toast.success(`Exported ${team.orgName}`);
    } catch (e) {
      toast.error(formatError(e, `Failed to export ${team.orgName}`));
    } finally {
      setExporting(null);
    }
  };

  const executeDelete = async (stepUpToken: string) => {
    const team = pendingDelete;
    setPendingDelete(null);
    if (!team) return;
    try {
      await api.deleteTeam(parentOrgId, team.orgId, stepUpToken);
      toast.success(`Deleted ${team.orgName} — restore it from Recently deleted teams`);
      invalidate.organizations();
      await onChanged();
    } catch (e) {
      toast.error(formatError(e, `Failed to delete ${team.orgName}`));
    }
  };

  const executeRestore = async (stepUpToken: string) => {
    const team = pendingRestore;
    setPendingRestore(null);
    if (!team) return;
    try {
      await api.restoreOrganization(team.orgId, stepUpToken);
      toast.success(`Restored ${team.orgName}`);
      invalidate.organizations();
      await onChanged();
    } catch (e) {
      toast.error(formatError(e, `Failed to restore ${team.orgName}`));
    }
  };

  return (
    <Card className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-fg inline-flex items-center gap-2">
          <Building2 className="w-4 h-4 text-fg-subtle" /> Teams <span className="text-fg-subtle font-normal">({teams.length})</span>
        </h2>
        {parentOrgName && <span className="text-xs text-fg-muted truncate">Teams of {parentOrgName}</span>}
      </div>

      {teams.length === 0 ? (
        <div className="py-2 space-y-2">
          {/* Say only what's actually on offer: "create a new one" with no
              control was an instruction to nowhere for a viewer who can't
              create, and a dead end for one who can. */}
          <p className="text-sm text-fg-muted">
            No live teams.{deletedTeams.length > 0 ? ' Restore a deleted team below.' : ''}
          </p>
          {onCreateTeam && (
            <div className="space-y-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={onCreateTeam}
                disabled={!!createTeamDisabledReason}
                aria-describedby={createTeamDisabledReason ? TEAMS_CARD_CREATE_REASON_ID : undefined}
                className="disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Building2 className="w-3.5 h-3.5 mr-1.5" /> Create a team
              </Button>
              {createTeamDisabledReason && (
                <p id={TEAMS_CARD_CREATE_REASON_ID} className="text-2xs text-fg-muted">{createTeamDisabledReason}</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {teams.map((t) => (
            <li key={t.orgId} className="py-2 flex items-center justify-between gap-2 text-sm">
              <span className="font-medium text-fg truncate">{t.orgName}</span>
              <div className="flex items-center gap-3 shrink-0">
                {canManageMembers && (
                  <button onClick={() => onAddMember(t)} className="action-link text-xs inline-flex items-center gap-1">
                    <UserPlus className="w-3.5 h-3.5" /> Add member
                  </button>
                )}
                {canManageSettings && (
                  <button
                    onClick={() => setManaging(t)}
                    className="action-link text-xs inline-flex items-center gap-1"
                    aria-label={`Manage ${t.orgName}`}
                  >
                    <Settings className="w-3.5 h-3.5" /> Manage
                  </button>
                )}
                <button onClick={() => onOpen(t)} className="action-link text-xs" aria-label={`Open ${t.orgName}`}>Open →</button>
                {canOrgSettings && (
                  <TeamRowMenu
                    team={t}
                    exporting={exporting === t.orgId}
                    onExport={() => void exportTeam(t)}
                    onDelete={() => setPendingDelete(t)}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {teams.length > 0 && (
        <p className="mt-2 text-xs text-fg-muted">
          <strong>Manage</strong> a team&apos;s settings from here, <strong>open</strong> it to manage its members directly,
          or add an existing member to teams with the <Network className="w-3 h-3 inline mx-0.5 -mt-0.5" /> action on each member row.
        </p>
      )}

      {canOrgSettings && deletedTeams.length > 0 && (
        <section aria-labelledby="deleted-teams-heading" className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800">
          <h3 id="deleted-teams-heading" className="text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1">
            Recently deleted teams
          </h3>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {deletedTeams.map((t) => (
              <li key={t.orgId} className="py-2 flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium text-fg-muted truncate">{t.orgName}</span>
                  <span className="block text-xs text-fg-muted">
                    Deleted <RelativeTime value={t.deletedAt} /> · purged permanently on {formatDateMedium(t.purgeAfter)}
                  </span>
                </span>
                <button
                  onClick={() => setPendingRestore(t)}
                  className="action-link text-xs inline-flex items-center gap-1 shrink-0"
                  aria-label={`Restore ${t.orgName}`}
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {managing && (
        <TeamSettingsDrawer
          team={managing}
          onClose={() => setManaging(null)}
          onRenamed={onChanged}
        />
      )}

      {pendingDelete && (
        <StepUpModal
          title={`Delete team ${pendingDelete.orgName}?`}
          action={`Delete team ${pendingDelete.orgName}`}
          details={(
            <>
              <p>
                <span className="font-medium">{pendingDelete.orgName}</span> disappears straight away and its members
                lose access to it.
              </p>
              <p className="mt-2">
                It stays restorable from <strong>Recently deleted teams</strong> until its retention window ends, then it
                and its data are purged permanently. Export it first if you need a copy.
              </p>
            </>
          )}
          onConfirmed={executeDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}
      {pendingRestore && (
        <StepUpModal
          action={`Restore team ${pendingRestore.orgName}`}
          onConfirmed={executeRestore}
          onClose={() => setPendingRestore(null)}
        />
      )}
    </Card>
  );
}

/** Overflow menu for a team's lifecycle actions (export, delete). */
function TeamRowMenu({ team, exporting, onExport, onDelete }: {
  team: OrgTeamRef;
  exporting: boolean;
  onExport: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn: () => void) => () => { setOpen(false); fn(); };
  const item = 'w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700/60 transition-colors';

  return (
    <div ref={ref} className="relative">
      <IconButton onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={`More actions for ${team.orgName}`}>
        <MoreHorizontal className="w-4 h-4" />
      </IconButton>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-50 w-48 py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl text-left">
          <button type="button" role="menuitem" onClick={run(onExport)} disabled={exporting} className={`${item} text-gray-700 dark:text-gray-200 disabled:opacity-60`}>
            <Download className="w-3.5 h-3.5 text-fg-subtle" /> {exporting ? 'Exporting…' : 'Export data'}
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
          <button type="button" role="menuitem" onClick={run(onDelete)} className={`${item} text-red-600 dark:text-red-400`}>
            <Trash2 className="w-3.5 h-3.5" /> Delete team
          </button>
        </div>
      )}
    </div>
  );
}
