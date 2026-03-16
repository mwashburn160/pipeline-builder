import { useEffect, useState, useMemo, useCallback } from 'react';
import { Mail } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import api from '@/lib/api';

interface InvitationListItem {
  id: string;
  email: string;
  role: 'user' | 'admin';
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
  const { user, isReady, isAuthenticated, isSysAdmin, isOrgAdminUser, isAdmin } = useAuthGuard({ requireAdmin: true });
  const [invitations, setInvitations] = useState<InvitationListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'accepted' | 'expired' | 'revoked'>('all');

  // Send modal state
  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [sendEmail, setSendEmail] = useState('');
  const [sendRole, setSendRole] = useState<'user' | 'admin'>('user');
  const [sendInvitationType, setSendInvitationType] = useState('any');
  const [sendLoading, setSendLoading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Revoke state
  const [revokeTarget, setRevokeTarget] = useState<InvitationListItem | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);

  // Resend state
  const [resendLoadingId, setResendLoadingId] = useState<string | null>(null);

  const fetchInvitations = useCallback(async () => {
    if (!isAuthenticated || !isAdmin) return;
    try {
      setIsLoading(true);
      const response = await api.listInvitations();
      const list = (response.data?.invitations || []) as InvitationListItem[];
      setInvitations(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invitations');
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, isAdmin]);

  useEffect(() => {
    if (isAuthenticated && isAdmin) fetchInvitations();
  }, [isAuthenticated, isAdmin, fetchInvitations]);

  const filteredInvitations = useMemo(
    () => statusFilter === 'all' ? invitations : invitations.filter((inv) => inv.status === statusFilter),
    [invitations, statusFilter],
  );

  const handleSendInvitation = async () => {
    if (!sendEmail.trim()) {
      setSendError('Email is required');
      return;
    }
    setSendLoading(true);
    setSendError(null);
    try {
      await api.sendInvitation({ email: sendEmail.trim(), role: sendRole, invitationType: sendInvitationType });
      setSendModalOpen(false);
      setSendEmail('');
      setSendRole('user');
      setSendInvitationType('any');
      await fetchInvitations();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send invitation');
    } finally {
      setSendLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevokeLoading(true);
    try {
      await api.revokeInvitation(revokeTarget.id);
      setInvitations((prev) => prev.map((inv) => inv.id === revokeTarget.id ? { ...inv, status: 'revoked' as const } : inv));
      setRevokeTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke invitation');
      setRevokeTarget(null);
    } finally {
      setRevokeLoading(false);
    }
  };

  const handleResend = async (invitation: InvitationListItem) => {
    setResendLoadingId(invitation.id);
    try {
      await api.resendInvitation(invitation.id);
      await fetchInvitations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend invitation');
    } finally {
      setResendLoadingId(null);
    }
  };

  const columns: Column<InvitationListItem>[] = useMemo(() => [
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
      render: (inv) => <>{inv.createdAt ? new Date(inv.createdAt).toLocaleDateString() : '-'}</>,
    },
    {
      id: 'expiresAt',
      header: 'Expires',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (inv) => inv.expiresAt,
      render: (inv) => <>{inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString() : '-'}</>,
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (inv) => inv.status === 'pending' ? (
        <>
          <button
            onClick={() => handleResend(inv)}
            disabled={resendLoadingId === inv.id}
            className="action-link mr-4"
          >
            {resendLoadingId === inv.id ? 'Sending...' : 'Resend'}
          </button>
          <button
            onClick={() => setRevokeTarget(inv)}
            className="action-link-danger"
          >
            Revoke
          </button>
        </>
      ) : null,
    },
  ], [resendLoadingId]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Invitations"
      subtitle="Pending and sent invites"
      actions={
        <button onClick={() => { setSendModalOpen(true); setSendError(null); }} className="btn btn-primary">
          Send Invitation
        </button>
      }
    >
      <RoleBanner isSysAdmin={isSysAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="invitations" orgName={user.organizationName} />

      {error && (
        <div className="alert-error">
          <p>{error}</p>
          <button onClick={() => setError(null)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      {/* Filter */}
      <div className="filter-bar">
        <div className="flex flex-col sm:flex-row gap-4">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
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
        data={filteredInvitations}
        columns={columns}
        isLoading={isLoading}
        emptyState={{
          icon: Mail,
          title: 'No invitations found',
          description: statusFilter !== 'all' ? 'Try adjusting your filter.' : 'Send an invitation to add team members.',
        }}
        getRowKey={(inv) => inv.id}
        defaultSortColumn="createdAt"
      />

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
        <div className="modal-backdrop">
          <div className="modal-panel max-w-md">
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Send Invitation</h2>

            {sendError && (
              <div className="alert-error"><p>{sendError}</p></div>
            )}

            <div className="space-y-4">
              <div>
                <label className="label">Email</label>
                <input
                  type="email"
                  value={sendEmail}
                  onChange={(e) => setSendEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="input"
                  disabled={sendLoading}
                />
              </div>
              <div>
                <label className="label">Role</label>
                <select value={sendRole} onChange={(e) => setSendRole(e.target.value as 'user' | 'admin')} className="input" disabled={sendLoading}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label className="label">Invitation Type</label>
                <select value={sendInvitationType} onChange={(e) => setSendInvitationType(e.target.value)} className="input" disabled={sendLoading}>
                  <option value="any">Any (Email or OAuth)</option>
                  <option value="email">Email Only</option>
                  <option value="oauth">OAuth Only</option>
                </select>
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button onClick={() => setSendModalOpen(false)} disabled={sendLoading} className="btn btn-secondary">Cancel</button>
              <button onClick={handleSendInvitation} disabled={sendLoading} className="btn btn-primary">
                {sendLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
