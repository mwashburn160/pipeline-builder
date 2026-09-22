import { useState, useMemo, useCallback, useId } from 'react';
import { formatError } from '@/lib/constants';
import { Mail } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useListPage } from '@/hooks/useListPage';
import { LoadingPage } from '@/components/ui/Loading';
import { SearchInput } from '@/components/ui/SearchInput';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useRowSelection, allSelected } from '@/components/dashboard/BulkActionBar';
import { BulkSelectionBanner, BulkResultSummary } from '@/components/dashboard/BulkSelectionBanner';
import { useToast } from '@/components/ui/Toast';
import { InviteFollowUpNotice } from '@/components/invitations/InviteFollowUpNotice';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import api from '@/lib/api';

interface InvitationListItem {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedBy: string;
  inviterName: string;
  expiresAt: string;
  createdAt: string;
}

const STATUS_BADGE_COLOR: Record<string, 'blue' | 'green' | 'gray' | 'red'> = {
  pending: 'blue',
  accepted: 'green',
  expired: 'gray',
  revoked: 'red',
};

export default function InvitationsPage() {
  const uid = useId();
  // The read gate (`invitations:manage`) comes from the nav entry via page-access.
  const { accessDenied, user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin, can } = useAuthGuard();
  const toast = useToast();
  // Role admins/owners (via bundle) and custom-group members granted it.
  const canManageInvitations = can('invitations:manage');
  // Drives the team wording in the invite follow-up notice: an org with teams
  // has somewhere to place the invitee AFTER acceptance; a flat org doesn't yet.
  const { hasChildOrgs } = useOrgHierarchy();

  const list = useListPage<InvitationListItem>({
    fields: [
      { key: 'search', type: 'text', defaultValue: '', primary: true },
      { key: 'status', type: 'select', defaultValue: 'all' },
      { key: 'invitationType', type: 'select', defaultValue: 'all' },
      { key: 'role', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      const response = await api.listInvitations({
        ...(params.search && { search: params.search }),
        ...(params.status && params.status !== 'all' && { status: params.status }),
        ...(params.invitationType && params.invitationType !== 'all' && { invitationType: params.invitationType }),
        ...(params.role && params.role !== 'all' && { role: params.role as 'admin' | 'member' }),
        offset: Number(params.offset || 0),
        limit: Number(params.limit || 25),
      });
      const data = response.data;
      return {
        items: (data?.invitations || []) as InvitationListItem[],
        pagination: data?.pagination,
      };
    },
    enabled: isAuthenticated && canManageInvitations,
  });

  // Send modal state — supports single + bulk send. The input is always
  // a textarea so bulk send is just "paste in a CSV column". Each line
  // (or each comma-separated value) becomes one invitation.
  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [sendEmail, setSendEmail] = useState('');
  const [sendRole, setSendRole] = useState<'admin' | 'member'>('member');
  const [sendInvitationType, setSendInvitationType] = useState('any');
  const [sendLoading, setSendLoading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<{ sent: number; failed: number; errors: string[] } | null>(null);

  // Revoke state
  const [revokeTarget, setRevokeTarget] = useState<InvitationListItem | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);

  // Resend state
  const [resendLoadingId, setResendLoadingId] = useState<string | null>(null);

  // Bulk-revoke multi-select. Only pending invites are selectable (the others
  // can't be revoked). Mirrors the users-page bulk-delete UX: a Set of ids, a
  // header select-all over the visible pending rows, and a confirm before firing.
  const { selectedIds, toggle: toggleSelected, toggleAll, clear: clearSelection, replace: replaceSelection } = useRowSelection();
  const [pendingBulkRevoke, setPendingBulkRevoke] = useState(false);
  const [bulkRevokeLoading, setBulkRevokeLoading] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ revoked: number; failed: number; errors: string[] } | null>(null);

  const pendingVisibleIds = useMemo(
    () => list.data.filter((inv) => inv.status === 'pending').map((inv) => inv.id),
    [list.data],
  );
  const allPendingSelected = allSelected(selectedIds, pendingVisibleIds);
  const toggleSelectAllPending = useCallback(() => toggleAll(pendingVisibleIds), [toggleAll, pendingVisibleIds]);

  const handleBulkRevoke = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkRevokeLoading(true);
    setBulkResult(null);
    const results = await Promise.allSettled(ids.map((id) => api.revokeInvitation(id)));

    const errors: string[] = [];
    let revoked = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.success) {
        revoked++;
      } else {
        const msg = r.status === 'rejected'
          ? (r.reason instanceof Error ? r.reason.message : String(r.reason))
          : (r.value.message || 'revoke failed');
        errors.push(`${ids[i]}: ${msg}`);
      }
    });

    setBulkRevokeLoading(false);
    setPendingBulkRevoke(false);
    setBulkResult({ revoked, failed: errors.length, errors: errors.slice(0, 10) });
    // Keep only the ones that failed selected, so a retry hits just those.
    replaceSelection(
      results.map((r, i) => ({ r, id: ids[i] }))
        .filter(({ r }) => !(r.status === 'fulfilled' && r.value.success))
        .map(({ id }) => id),
    );
    if (revoked > 0) list.refresh();
  };

  /** Split a textarea of pasted emails on any of newline / comma / semicolon /
   *  whitespace, lowercased + deduped. Rejects anything without an `@`. */
  function parseEmailList(input: string): string[] {
    const tokens = input.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const valid = tokens.filter((t) => /.+@.+/.test(t));
    return Array.from(new Set(valid));
  }

  const handleSendInvitation = async () => {
    const emails = parseEmailList(sendEmail);
    if (emails.length === 0) {
      setSendError('Enter at least one valid email address');
      return;
    }
    setSendLoading(true);
    setSendError(null);
    setSendResult(null);

    // Fire each invite in parallel. Promise.allSettled keeps partial-
    // success cases informative — one bad email shouldn't block the rest.
    const results = await Promise.allSettled(
      emails.map((email) =>
        api.sendInvitation({ email, role: sendRole, invitationType: sendInvitationType }),
      ),
    );

    const errors: string[] = [];
    let sent = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.success) {
        sent++;
      } else {
        const msg = r.status === 'rejected'
          ? (r.reason instanceof Error ? r.reason.message : String(r.reason))
          : (r.value.message || 'send failed');
        errors.push(`${emails[i]}: ${msg}`);
      }
    });

    setSendLoading(false);
    setSendResult({ sent, failed: errors.length, errors: errors.slice(0, 10) });

    if (sent > 0) {
      list.refresh();
      if (errors.length === 0) {
        // Clean exit — close on next tick so users see the success message.
        setTimeout(() => {
          setSendModalOpen(false);
          setSendEmail('');
          setSendRole('member');
          setSendInvitationType('any');
          setSendResult(null);
        }, 1200);
      }
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevokeLoading(true);
    try {
      await api.revokeInvitation(revokeTarget.id);
      toast.success(`Invitation to ${revokeTarget.email} revoked`);
      setRevokeTarget(null);
      list.refresh();
    } catch (err) {
      list.setError(formatError(err, 'Failed to revoke invitation'));
      setRevokeTarget(null);
    } finally {
      setRevokeLoading(false);
    }
  };

  const handleResend = async (invitation: InvitationListItem) => {
    setResendLoadingId(invitation.id);
    try {
      await api.resendInvitation(invitation.id);
      toast.success(`Invitation to ${invitation.email} resent`);
      list.refresh();
    } catch (err) {
      list.setError(formatError(err, 'Failed to resend invitation'));
    } finally {
      setResendLoadingId(null);
    }
  };

  // The row and bulk actions share the header button's gate. Only "Send
  // Invitation" was gated; Resend, Revoke, the checkboxes and bulk Revoke
  // rendered for anyone who could READ the page — most visibly a sysadmin in a
  // read-only impersonation, where every one of them was a live control the
  // backend then 403'd (bulk revoke reporting N failures).
  const columns: Column<InvitationListItem>[] = useMemo(() => [
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
      header: 'Role',
      render: (inv) => <Badge color={inv.role === 'admin' ? 'purple' : 'gray'}>{inv.role}</Badge>,
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
          <button onClick={() => handleResend(inv)} disabled={resendLoadingId === inv.id} className="action-link mr-4">
            {resendLoadingId === inv.id ? 'Sending...' : 'Resend'}
          </button>
          <button onClick={() => setRevokeTarget(inv)} className="action-link-danger">Revoke</button>
        </>
      ) : null,
    },
  ], [canManageInvitations, resendLoadingId, selectedIds, allPendingSelected, toggleSelected, toggleSelectAllPending]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Invitations"
      subtitle="Pending and sent invites"
      actions={
        canManageInvitations ? (
          <Button onClick={() => { setSendModalOpen(true); setSendError(null); }}>
            Send Invitation
          </Button>
        ) : undefined
      }
    >
      <RoleBanner isSuperAdmin={isSuperAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="invitations" orgName={user.organizationName} />

      <ErrorAlert message={list.error} onRetry={list.refresh} onDismiss={() => list.setError(null)} />

      {canManageInvitations && <BulkSelectionBanner
        count={selectedIds.size}
        noun="invitation"
        actionLabel="Revoke"
        onClear={clearSelection}
        onAction={() => setPendingBulkRevoke(true)}
      />}

      {bulkResult && (
        <BulkResultSummary failed={bulkResult.failed} errors={bulkResult.errors}>
          Bulk revoke finished — <strong>{bulkResult.revoked}</strong> revoked, <strong>{bulkResult.failed}</strong> failed.
        </BulkResultSummary>
      )}

      {/* Filter */}
      <div className="filter-bar">
        <div className="flex flex-col sm:flex-row gap-4">
          <SearchInput
            containerClassName="flex-1 min-w-0"
            placeholder="Search by email..."
            value={list.filters.search}
            onChange={(v) => list.updateFilter('search', v)}
            className="w-full"
            aria-label="Search invitations by email"
          />
          <FilterSelect
            value={list.filters.status}
            onChange={(e) => list.updateFilter('status', e.target.value)}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </FilterSelect>
          <FilterSelect
            value={list.filters.invitationType}
            onChange={(e) => list.updateFilter('invitationType', e.target.value)}
            aria-label="Filter by invitation type"
          >
            <option value="all">All types</option>
            <option value="email">Email</option>
            <option value="oauth">OAuth</option>
          </FilterSelect>
          <FilterSelect
            value={list.filters.role}
            onChange={(e) => list.updateFilter('role', e.target.value)}
            aria-label="Filter by role"
          >
            <option value="all">All roles</option>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </FilterSelect>
        </div>
      </div>

      <DataTable
        data={list.data}
        columns={columns}
        isLoading={list.isLoading}
        loadFailed={!!list.error}
        onRetry={list.refresh}
        emptyState={{
          icon: Mail,
          title: 'No invitations found',
          description: list.hasActiveFilters ? 'Try adjusting your filter.' : 'Send an invitation to add team members.',
          // Same gate as the header button: without `invitations:manage` the
          // send would 403, so the empty state must not offer it either.
          action: list.hasActiveFilters || !canManageInvitations ? undefined : (
            <Button onClick={() => { setSendModalOpen(true); setSendError(null); }}>
              <Mail className="w-4 h-4 mr-1.5" /> Send invitation
            </Button>
          ),
        }}
        getRowKey={(inv) => inv.id}
      />

      {!list.isLoading && list.pagination.total > 0 && (
        <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
      )}

      {/* Bulk-revoke confirmation */}
      {pendingBulkRevoke && (
        <DeleteConfirmModal
          title="Revoke invitations"
          itemName={`${selectedIds.size} invitation${selectedIds.size === 1 ? '' : 's'}`}
          loading={bulkRevokeLoading}
          onConfirm={handleBulkRevoke}
          onCancel={() => setPendingBulkRevoke(false)}
        />
      )}

      {/* Revoke confirmation */}
      {revokeTarget && (
        <DeleteConfirmModal
          title="Revoke invitation"
          itemName={revokeTarget.email}
          loading={revokeLoading}
          onConfirm={handleRevoke}
          onCancel={() => setRevokeTarget(null)}
        />
      )}

      {/* Send Invitation Modal */}
      {sendModalOpen && (
        <Modal
          title="Send invitations"
          onClose={() => !sendLoading && setSendModalOpen(false)}
          maxWidth="max-w-md"
          footer={
            <ModalFooter
              onCancel={() => setSendModalOpen(false)}
              onConfirm={handleSendInvitation}
              confirmLabel="Send"
              loading={sendLoading}
            />
          }
        >
          <p className="text-xs text-fg-muted mb-3">
            Paste one or many emails — separated by newlines, commas, or spaces. Each email gets its own invitation.
          </p>

          <ErrorAlert message={sendError} />

          {sendResult && (
            <div className={`rounded-lg px-3 py-2 text-sm mb-2 ${sendResult.failed === 0
              ? 'bg-success-bg text-success-strong'
              : 'bg-warning-bg text-warning-strong'}`}
            >
              Sent <strong>{sendResult.sent}</strong>, failed <strong>{sendResult.failed}</strong>.
              {sendResult.errors.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {sendResult.errors.map((e) => <li key={e}><code>{e}</code></li>)}
                </ul>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="label" htmlFor={`${uid}-email-s`}>Email(s)</label>
              <Textarea
                id={`${uid}-email-s`}
                value={sendEmail}
                onChange={(e) => setSendEmail(e.target.value)}
                placeholder={'user@example.com\nteam@example.com, lead@example.com'}
                className="min-h-[6rem] font-mono text-sm"
                disabled={sendLoading}
              />
              {sendEmail.trim() && (
                <p className="mt-1 text-xs text-fg-muted">
                  Will send to <strong>{parseEmailList(sendEmail).length}</strong> address{parseEmailList(sendEmail).length === 1 ? '' : 'es'}.
                </p>
              )}
            </div>
            <div>
              <label className="label" htmlFor={`${uid}-role`}>Role</label>
              <Select id={`${uid}-role`} value={sendRole} onChange={(e) => setSendRole(e.target.value as 'admin' | 'member')} disabled={sendLoading}>
                <option value="member">Member — build pipelines, no administration</option>
                <option value="admin">Admin — full administration of this organization</option>
              </Select>
              {/* The coarse role is only the first of three layers (role → Roles →
                  teams), and an org-wide MFA requirement can stop the invitee at
                  first sign-in. Say so here rather than letting them find out. */}
              <div className="mt-2">
                <InviteFollowUpNotice orgId={user?.organizationId} role={sendRole} hasTeams={hasChildOrgs} />
              </div>
            </div>
            <div>
              <label className="label" htmlFor={`${uid}-invitation-type`}>Invitation type</label>
              <Select id={`${uid}-invitation-type`} value={sendInvitationType} onChange={(e) => setSendInvitationType(e.target.value)} disabled={sendLoading}>
                <option value="any">Any (Email or OAuth)</option>
                <option value="email">Email only</option>
                <option value="oauth">OAuth Only</option>
              </Select>
            </div>
          </div>
        </Modal>
      )}
    </DashboardLayout>
  );
}
