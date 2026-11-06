// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Badge, type BadgeColor } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { type Column } from '@/components/ui/DataTable';

/** One row of the invitations roster, as the list endpoint returns it. */
export interface InvitationListItem {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  /** Roles assigned on acceptance, resolved to names by the listing. */
  roleNames?: string[];
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedBy: string;
  inviterName: string;
  expiresAt: string;
  createdAt: string;
}

// `pending` is YELLOW, as it is on every other status surface (MFA resets,
// publish requests, compliance scans and exemptions): it means "waiting on
// someone", which is what the yellow token says. It was blue only here.
/** Keyed off the row's own `status` union, so a status added to it is a compile
 *  error here rather than a row that falls through to the grey default. */
const STATUS_BADGE_COLOR: Record<InvitationListItem['status'], BadgeColor> = {
  pending: 'yellow',
  accepted: 'green',
  expired: 'gray',
  revoked: 'red',
};

interface BuildInvitationColumnsOptions {
  /** Read-only-aware `can('invitations:manage')` — gates the selection
   *  checkboxes and the Resend / Revoke row actions, so a read-only
   *  impersonation session sees the roster without controls that would 403. */
  canManageInvitations: boolean;
  /** The invitation currently being resent, so its button shows progress. */
  resendLoadingId: string | null;
  selectedIds: Set<string>;
  allPendingSelected: boolean;
  toggleSelected: (id: string) => void;
  toggleSelectAllPending: () => void;
  onResend: (inv: InvitationListItem) => void;
  onRevoke: (inv: InvitationListItem) => void;
}

/**
 * Builds the Invitations roster DataTable columns.
 *
 * A pure helper so the page reads as orchestration, matching
 * `buildMemberColumns` — the two rosters are the same shape of surface, and the
 * page had 76 lines of column definition inline between its handlers and its
 * render.
 */
export function buildInvitationColumns({
  canManageInvitations,
  resendLoadingId,
  selectedIds,
  allPendingSelected,
  toggleSelected,
  toggleSelectAllPending,
  onResend,
  onRevoke,
}: BuildInvitationColumnsOptions): Column<InvitationListItem>[] {
  return [
    ...(canManageInvitations ? [{
      id: 'select',
      // Header checkbox toggles all visible pending rows. Only pending invites
      // are revocable, so non-pending rows render no checkbox.
      header: (
        <Checkbox
          aria-label="Select all pending invitations"
          checked={allPendingSelected}
          onChange={toggleSelectAllPending}
          className="h-4 w-4 cursor-pointer"
        />
      ),
      headerClassName: 'w-10',
      cellClassName: 'w-10',
      render: (inv: InvitationListItem) => inv.status === 'pending' ? (
        <Checkbox
          aria-label={`Select invitation for ${inv.email}`}
          checked={selectedIds.has(inv.id)}
          onChange={() => toggleSelected(inv.id)}
          className="h-4 w-4 cursor-pointer"
        />
      ) : null,
    } as Column<InvitationListItem>] : []),
    // NOTE: no `sortValue` on these columns. The list is server-paginated and
    // the invitations list endpoint has no sort param, so a client sort would
    // only reorder the current page — misleading. Sort affordance intentionally
    // dropped until/unless the backend supports it.
    {
      id: 'email',
      header: 'Email',
      render: (inv) => <span className="text-sm font-medium text-fg">{inv.email}</span>,
    },
    {
      id: 'role',
      header: 'Grants',
      /**
       * The coarse role AND the Roles the invitation will assign on acceptance.
       *
       * An invitation can carry Roles now, and the queue showed only the coarse
       * word — so a reviewer could not tell that accepting this one also confers
       * `Security Officer`. "What will this actually grant?" is the question a
       * pending-invitation list exists to answer.
       */
      render: (inv) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Badge color={inv.role === 'admin' ? 'purple' : 'gray'}>{inv.role}</Badge>
          {(inv.roleNames ?? []).map((name) => (
            <Badge key={name} color="blue">{name}</Badge>
          ))}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      render: (inv) => <Badge color={STATUS_BADGE_COLOR[inv.status] || 'gray'}>{inv.status}</Badge>,
    },
    {
      id: 'invitedBy',
      header: 'Invited by',
      cellClassName: 'text-sm text-fg-muted',
      render: (inv) => <>{inv.inviterName || inv.invitedBy || 'Unknown'}</>,
    },
    {
      id: 'createdAt',
      header: 'Created',
      cellClassName: 'text-sm text-fg-muted',
      render: (inv) => <RelativeTime value={inv.createdAt} />,
    },
    {
      id: 'expiresAt',
      header: 'Expires',
      cellClassName: 'text-sm text-fg-muted',
      render: (inv) => <RelativeTime value={inv.expiresAt} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (inv) => inv.status === 'pending' && canManageInvitations ? (
        <>
          <button onClick={() => onResend(inv)} disabled={resendLoadingId === inv.id} className="action-link mr-4">
            {resendLoadingId === inv.id ? 'Sending...' : 'Resend'}
          </button>
          <button onClick={() => onRevoke(inv)} className="action-link-danger">Revoke</button>
        </>
      ) : null,
    },
  ];
}
