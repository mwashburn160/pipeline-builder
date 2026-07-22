import { useState, useMemo, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { Mail, Trash2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { RelativeTime } from '@/components/ui/RelativeTime';
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
  const { user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin, can } = useAuthGuard({ requirePermission: 'invitations:manage' });
  // Role admins/owners (via bundle) and custom-group members granted it.
  const canManageInvitations = can('invitations:manage');

  const list = useListPage<InvitationListItem>({
    fields: [
      { key: 'status', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      const response = await api.listInvitations({
        ...(params.status && params.status !== 'all' && { status: params.status }),
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingBulkRevoke, setPendingBulkRevoke] = useState(false);
  const [bulkRevokeLoading, setBulkRevokeLoading] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ revoked: number; failed: number; errors: string[] } | null>(null);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const pendingVisibleIds = useMemo(
    () => list.data.filter((inv) => inv.status === 'pending').map((inv) => inv.id),
    [list.data],
  );
  const allPendingSelected = pendingVisibleIds.length > 0 && pendingVisibleIds.every((id) => selectedIds.has(id));
  const toggleSelectAllPending = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPendingSelected) pendingVisibleIds.forEach((id) => next.delete(id));
      else pendingVisibleIds.forEach((id) => next.add(id));
      return next;
    });
  }, [pendingVisibleIds, allPendingSelected]);

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
    const failedIds = new Set(
      results.map((r, i) => ({ r, id: ids[i] }))
        .filter(({ r }) => !(r.status === 'fulfilled' && r.value.success))
        .map(({ id }) => id),
    );
    setSelectedIds(failedIds);
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
      list.refresh();
    } catch (err) {
      list.setError(formatError(err, 'Failed to resend invitation'));
    } finally {
      setResendLoadingId(null);
    }
  };

  const columns: Column<InvitationListItem>[] = useMemo(() => [
    {
      id: 'select',
      // Header checkbox toggles all visible pending rows. Only pending invites
      // are revocable, so non-pending rows render no checkbox.
      header: (
        <input
          type="checkbox"
          aria-label="Select all pending invitations"
          checked={allPendingSelected}
          onChange={toggleSelectAllPending}
          className="h-4 w-4 cursor-pointer"
        />
      ),
      headerClassName: 'w-10',
      cellClassName: 'w-10',
      render: (inv) => inv.status === 'pending' ? (
        <input
          type="checkbox"
          aria-label={`Select invitation for ${inv.email}`}
          checked={selectedIds.has(inv.id)}
          onChange={() => toggleSelected(inv.id)}
          className="h-4 w-4 cursor-pointer"
        />
      ) : null,
    },
    {
      id: 'email',
      header: 'Email',
      sortValue: (inv) => inv.email,
      render: (inv) => <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{inv.email}</span>,
    },
    {
      id: 'role',
      header: 'Role',
      sortValue: (inv) => inv.role,
      render: (inv) => <Badge color={inv.role === 'admin' ? 'purple' : 'gray'}>{inv.role}</Badge>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (inv) => inv.status,
      render: (inv) => <Badge color={STATUS_BADGE_COLOR[inv.status] || 'gray'}>{inv.status}</Badge>,
    },
    {
      id: 'invitedBy',
      header: 'Invited By',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (inv) => inv.inviterName || inv.invitedBy,
      render: (inv) => <>{inv.inviterName || inv.invitedBy || 'Unknown'}</>,
    },
    {
      id: 'createdAt',
      header: 'Created',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (inv) => inv.createdAt,
      render: (inv) => <RelativeTime value={inv.createdAt} />,
    },
    {
      id: 'expiresAt',
      header: 'Expires',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (inv) => inv.expiresAt,
      render: (inv) => <RelativeTime value={inv.expiresAt} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (inv) => inv.status === 'pending' ? (
        <>
          <button onClick={() => handleResend(inv)} disabled={resendLoadingId === inv.id} className="action-link mr-4">
            {resendLoadingId === inv.id ? 'Sending...' : 'Resend'}
          </button>
          <button onClick={() => setRevokeTarget(inv)} className="action-link-danger">Revoke</button>
        </>
      ) : null,
    },
  ], [resendLoadingId, selectedIds, allPendingSelected, toggleSelected, toggleSelectAllPending]);

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

      <ErrorAlert message={list.error} onDismiss={() => list.setError(null)} />

      {selectedIds.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900/40 dark:bg-blue-900/20">
          <span className="text-blue-800 dark:text-blue-200">
            <strong>{selectedIds.size}</strong> invitation{selectedIds.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => setSelectedIds(new Set())} className="action-link text-sm">Clear</button>
            <Button
              variant="danger"
              onClick={() => setPendingBulkRevoke(true)}
              className="inline-flex items-center gap-1 text-sm"
            >
              <Trash2 className="h-4 w-4" /> Revoke {selectedIds.size}
            </Button>
          </div>
        </div>
      )}

      {bulkResult && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${bulkResult.failed === 0 ? 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300'}`}>
          <div>
            Bulk revoke finished — <strong>{bulkResult.revoked}</strong> revoked, <strong>{bulkResult.failed}</strong> failed.
          </div>
          {bulkResult.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {bulkResult.errors.map((e) => <li key={e}><code>{e}</code></li>)}
            </ul>
          )}
        </div>
      )}

      {/* Filter */}
      <div className="filter-bar">
        <div className="flex flex-col sm:flex-row gap-4">
          <select
            value={list.filters.status}
            onChange={(e) => list.updateFilter('status', e.target.value)}
            className="filter-select"
          >
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </select>
        </div>
      </div>

      <DataTable
        data={list.data}
        columns={columns}
        isLoading={list.isLoading}
        emptyState={{
          icon: Mail,
          title: 'No invitations found',
          description: list.hasActiveFilters ? 'Try adjusting your filter.' : 'Send an invitation to add team members.',
          action: list.hasActiveFilters ? undefined : (
            <Button onClick={() => { setSendModalOpen(true); setSendError(null); }}>
              <Mail className="w-4 h-4 mr-1.5" /> Send invitation
            </Button>
          ),
        }}
        getRowKey={(inv) => inv.id}
        defaultSortColumn="createdAt"
      />

      {!list.isLoading && list.pagination.total > 0 && (
        <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
      )}

      {/* Bulk-revoke confirmation */}
      {pendingBulkRevoke && (
        <DeleteConfirmModal
          title="Revoke Invitations"
          itemName={`${selectedIds.size} invitation${selectedIds.size === 1 ? '' : 's'}`}
          loading={bulkRevokeLoading}
          onConfirm={handleBulkRevoke}
          onCancel={() => setPendingBulkRevoke(false)}
        />
      )}

      {/* Revoke confirmation */}
      {revokeTarget && (
        <DeleteConfirmModal
          title="Revoke Invitation"
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
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Paste one or many emails — separated by newlines, commas, or spaces. Each email gets its own invitation.
          </p>

          <ErrorAlert message={sendError} />

          {sendResult && (
            <div className={`rounded-lg px-3 py-2 text-sm mb-2 ${sendResult.failed === 0
              ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
              : 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300'}`}
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
              <label className="label">Email(s)</label>
              <Textarea
                value={sendEmail}
                onChange={(e) => setSendEmail(e.target.value)}
                placeholder={'user@example.com\nteam@example.com, lead@example.com'}
                className="min-h-[6rem] font-mono text-sm"
                disabled={sendLoading}
              />
              {sendEmail.trim() && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Will send to <strong>{parseEmailList(sendEmail).length}</strong> address{parseEmailList(sendEmail).length === 1 ? '' : 'es'}.
                </p>
              )}
            </div>
            <div>
              <label className="label">Role</label>
              <Select value={sendRole} onChange={(e) => setSendRole(e.target.value as 'admin' | 'member')} disabled={sendLoading}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            </div>
            <div>
              <label className="label">Invitation Type</label>
              <Select value={sendInvitationType} onChange={(e) => setSendInvitationType(e.target.value)} disabled={sendLoading}>
                <option value="any">Any (Email or OAuth)</option>
                <option value="email">Email Only</option>
                <option value="oauth">OAuth Only</option>
              </Select>
            </div>
          </div>
        </Modal>
      )}
    </DashboardLayout>
  );
}
