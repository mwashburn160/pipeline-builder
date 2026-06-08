import { useState, useMemo, useCallback, useEffect } from 'react';
import { formatError } from '@/lib/constants';
import { Search, Users, Trash2 } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { useDelete } from '@/hooks/useDelete';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { ModalPortal } from '@/components/ui/ModalPortal';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ActionBar } from '@/components/ui/ActionBar';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { FeatureOverridesEditor } from '@/components/admin/FeatureOverridesEditor';
import api from '@/lib/api';

interface UserListItem {
  id: string;
  username: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  /** Global super-admin flag (Pipeline Builder operator). Cross-org. */
  isSuperAdmin?: boolean;
  isEmailVerified: boolean;
  organizationId?: string;
  organizationName?: string;
  createdAt?: string;
  /** Per-user feature-flag overrides. Absent on rows with no overrides.
   *  Edited via the FeatureOverridesEditor inside the user-edit modal. */
  featureOverrides?: Record<string, boolean>;
}

/** System-admin-only page for managing users across all organizations. */
export default function UsersPage() {
  // All /users routes are sysadmin-only server-side (platform/src/routes/users.ts).
  // The previous `requireAdmin: true` let org admins reach the page and fail
  // every API call with 403 — gate matches backend now.
  const { user, isReady, isAuthenticated, isSuperAdmin } = useAuthGuard({ requireSystemAdmin: true });

  const list = useListPage<UserListItem>({
    fields: [
      { key: 'search', type: 'text', defaultValue: '', primary: true },
      { key: 'role', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      const response = await api.listUsers({
        ...(params.search && { search: params.search }),
        ...(params.role && params.role !== 'all' && { role: params.role }),
        offset: Number(params.offset || 0),
        limit: Number(params.limit || 25),
      });
      const data = response.data;
      return {
        items: (data?.users || []) as UserListItem[],
        pagination: data?.pagination,
      };
    },
    enabled: isAuthenticated && isSuperAdmin,
  });

  const del = useDelete<UserListItem>(
    async (u) => {
      await api.deleteUserById(u.id);
    },
    list.refresh,
    (err) => list.setError(formatError(err, 'Failed to delete user')),
  );

  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  const [editRole, setEditRole] = useState<'owner' | 'admin' | 'member'>('member');
  const [newPassword, setNewPassword] = useState('');
  const editForm = useFormState();
  // Gate for grant/revoke platform-admin. When set, StepUpModal renders and
  // calls the captured action on password-verify success.
  const [pendingGrant, setPendingGrant] = useState<UserListItem | null>(null);
  const [impersonateTarget, setImpersonateTarget] = useState<UserListItem | null>(null);

  const executeImpersonate = useCallback(async (stepUpToken: string) => {
    if (!impersonateTarget) return;
    try {
      const res = await api.impersonateUser(impersonateTarget.id, stepUpToken);
      if (res.success && res.data?.accessToken) {
        api.startImpersonation(res.data.accessToken);
        // Hard-reload to refresh useAuth + every cached query under the new
        // identity. Lighter than threading a swap event through every hook.
        window.location.href = '/dashboard';
      } else {
        list.setError(res.message || 'Impersonation failed');
      }
    } catch (err) {
      list.setError(formatError(err, 'Impersonation failed'));
    }
  }, [impersonateTarget, list]);

  // Multi-select state for bulk delete. Stored as a Set of user IDs so
  // selection survives across filter / page changes within a session —
  // matches the typical sysadmin flow (search → check several → repeat
  // with a different search → bulk-delete the union).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ deleted: number; failed: number; errors: string[] } | null>(null);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Header checkbox: select-all / clear-all relative to the visible page.
  const visibleIds = useMemo(() => list.data.map((u) => u.id).filter((id) => id !== user?.id), [list.data, user]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }, [visibleIds, allVisibleSelected]);

  const executeBulkDelete = useCallback(async (stepUpToken: string) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkResult(null);
    try {
      const res = await api.bulkDeleteUsers(ids, stepUpToken);
      if (res.success && res.data) {
        const failures = res.data.results.filter((r) => !r.ok);
        setBulkResult({
          deleted: res.data.summary.deleted,
          failed: res.data.summary.failed,
          // Cap surfaced error count; the audit log holds the full record.
          errors: failures.slice(0, 5).map((r) => `${r.id}: ${r.error}`),
        });
        // Drop successfully deleted from selection so the next click won't replay them.
        setSelectedIds(new Set(failures.map((r) => r.id)));
        list.refresh();
      } else {
        list.setError(res.message || 'Bulk delete failed');
      }
    } catch (err) {
      list.setError(formatError(err, 'Bulk delete failed'));
    }
  }, [selectedIds, list]);

  const handleEditUser = (userItem: UserListItem) => {
    setEditingUser(userItem);
    setEditRole(userItem.role);
    setNewPassword('');
    editForm.reset();
  };

  const handleSaveUser = async () => {
    if (!editingUser) return;

    const updates: { role?: string; password?: string } = {};
    if (editRole !== editingUser.role) updates.role = editRole;
    if (newPassword && newPassword.length >= 8) {
      updates.password = newPassword;
    } else if (newPassword && newPassword.length < 8) {
      editForm.setError('Password must be at least 8 characters');
      return;
    }

    if (Object.keys(updates).length === 0) {
      editForm.setError('No changes to save');
      return;
    }

    const result = await editForm.run(
      () => api.updateUserById(editingUser.id, updates),
      { successMessage: 'User updated successfully' },
    );

    if (result !== null) {
      list.refresh();
      setNewPassword('');
      setTimeout(() => setEditingUser(null), 1500);
    }
  };

  // Open the step-up modal; the actual grant/revoke runs after password
  // verifies in `confirmGrantChange` below.
  const toggleSuperAdmin = useCallback((userItem: UserListItem) => {
    setPendingGrant(userItem);
  }, []);

  const confirmGrantChange = useCallback(async (stepUpToken: string) => {
    if (!pendingGrant) return;
    const verb = pendingGrant.isSuperAdmin ? 'Revoke' : 'Grant';
    try {
      if (pendingGrant.isSuperAdmin) {
        await api.removeUserGrant(pendingGrant.id, 'platform-admin', stepUpToken);
      } else {
        await api.addUserGrant(pendingGrant.id, 'platform-admin', stepUpToken);
      }
      list.refresh();
    } catch (err) {
      list.setError(formatError(err, `Failed to ${verb.toLowerCase()} platform-admin`));
    }
  }, [list, pendingGrant]);

  const userColumns: Column<UserListItem>[] = useMemo(() => [
    {
      id: 'select',
      // Header checkbox toggles all visible (non-self) rows. Indeterminate
      // state isn't surfaced — partial selection just shows unchecked.
      header: (
        <input
          type="checkbox"
          aria-label="Select all visible users"
          checked={allVisibleSelected}
          onChange={toggleSelectAllVisible}
          className="h-4 w-4 cursor-pointer"
        />
      ),
      headerClassName: 'w-10',
      cellClassName: 'w-10',
      render: (u) => (
        u.id === user?.id ? null : (
          <input
            type="checkbox"
            aria-label={`Select ${u.email}`}
            checked={selectedIds.has(u.id)}
            onChange={() => toggleSelected(u.id)}
            className="h-4 w-4 cursor-pointer"
          />
        )
      ),
    },
    {
      id: 'user',
      header: 'User',
      sortValue: (u) => u.username,
      render: (u) => (
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{u.username}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{u.email}</div>
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      sortValue: (u) => u.role,
      render: (u) => (
        <span className="inline-flex items-center gap-1">
          <Badge color={u.role === 'admin' ? 'purple' : 'gray'}>{u.role}</Badge>
          {u.isSuperAdmin && <Badge color="red">platform-admin</Badge>}
        </span>
      ),
    },
    {
      id: 'organization',
      header: 'Organization',
      cellClassName: 'text-sm text-gray-500 dark:text-gray-400',
      sortValue: (u) => u.organizationName || '',
      render: (u) => <>{u.organizationName || 'None'}</>,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (u) => u.isEmailVerified,
      render: (u) => (
        <Badge color={u.isEmailVerified ? 'green' : 'yellow'}>{u.isEmailVerified ? 'Verified' : 'Unverified'}</Badge>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      headerClassName: 'text-right',
      cellClassName: 'text-right text-sm font-medium',
      render: (userItem) => (
        <div className="flex justify-end gap-3">
          <button onClick={() => handleEditUser(userItem)} className="action-link">Edit</button>
          {userItem.id !== user?.id && (
            <>
              <button
                onClick={() => toggleSuperAdmin(userItem)}
                className="action-link"
                title={userItem.isSuperAdmin ? 'Revoke platform-admin grant' : 'Grant platform-admin'}
              >
                {userItem.isSuperAdmin ? 'Revoke admin' : 'Grant admin'}
              </button>
              <button onClick={() => del.open(userItem)} className="action-link-danger">Delete</button>
            </>
          )}
        </div>
      ),
    },
  ], [user, toggleSuperAdmin, selectedIds, toggleSelected, allVisibleSelected, toggleSelectAllVisible, del]);

  if (!isReady || !user) return <LoadingPage />;
  if (!isSuperAdmin) return null;

  return (
    <DashboardLayout title="All Users" subtitle="System-wide user administration">
      {list.error && (
        <div className="alert-error">
          <p>{list.error}</p>
          <button onClick={() => list.setError(null)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      <div className="filter-bar">
        <ActionBar
          left={
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
              <input type="text" placeholder="Search by username or email..." value={list.filters.search} onChange={(e) => list.updateFilter('search', e.target.value)} className="filter-input" />
            </div>
          }
          right={
            <select value={list.filters.role} onChange={(e) => list.updateFilter('role', e.target.value)} className="filter-select">
              <option value="all">All Roles</option>
              <option value="member">Members</option>
              <option value="admin">Admins</option>
            </select>
          }
        />
      </div>

      {selectedIds.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900/40 dark:bg-blue-900/20">
          <span className="text-blue-800 dark:text-blue-200">
            <strong>{selectedIds.size}</strong> user{selectedIds.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => setSelectedIds(new Set())} className="action-link text-sm">Clear</button>
            <button
              onClick={() => setPendingBulkDelete(true)}
              className="btn btn-danger inline-flex items-center gap-1 text-sm"
            >
              <Trash2 className="h-4 w-4" /> Delete {selectedIds.size}
            </button>
          </div>
        </div>
      )}

      {bulkResult && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${bulkResult.failed === 0 ? 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300'}`}>
          <div>
            Bulk delete finished — <strong>{bulkResult.deleted}</strong> deleted, <strong>{bulkResult.failed}</strong> failed.
          </div>
          {bulkResult.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {bulkResult.errors.map((e) => <li key={e}><code>{e}</code></li>)}
            </ul>
          )}
          <button onClick={() => setBulkResult(null)} className="mt-1 text-xs underline">Dismiss</button>
        </div>
      )}

      <DataTable
        data={list.data}
        columns={userColumns}
        isLoading={list.isLoading}
        emptyState={{
          icon: Users,
          title: 'No users found',
          description: list.hasActiveFilters ? 'Try adjusting your search criteria.' : 'No users to display.',
        }}
        getRowKey={(u) => u.id}
        defaultSortColumn="user"
      />

      {!list.isLoading && list.pagination.total > 0 && (
        <Pagination pagination={list.pagination} onPageChange={list.handlePageChange} onPageSizeChange={list.handlePageSizeChange} />
      )}

      {del.target && (
        <DeleteConfirmModal
          title="Delete User"
          itemName={del.target.username}
          loading={del.loading}
          onConfirm={del.confirm}
          onCancel={del.close}
        />
      )}

      {pendingGrant && (
        <StepUpModal
          action={`${pendingGrant.isSuperAdmin ? 'Revoke' : 'Grant'} platform-admin for ${pendingGrant.email}`}
          onConfirmed={confirmGrantChange}
          onClose={() => setPendingGrant(null)}
        />
      )}

      {pendingBulkDelete && (
        <StepUpModal
          action={`Bulk delete ${selectedIds.size} user${selectedIds.size === 1 ? '' : 's'}`}
          onConfirmed={executeBulkDelete}
          onClose={() => setPendingBulkDelete(false)}
        />
      )}

      {impersonateTarget && (
        <StepUpModal
          action={`Start read-only impersonation of ${impersonateTarget.email}`}
          onConfirmed={executeImpersonate}
          onClose={() => setImpersonateTarget(null)}
        />
      )}

      {editingUser && (
        <ModalPortal>
        <div className="modal-backdrop">
          <div className="modal-panel max-w-md">
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Edit User: {editingUser.username}</h2>

            {editForm.error && <div className="alert-error"><p>{editForm.error}</p></div>}
            {editForm.success && <div className="alert-success"><p>{editForm.success}</p></div>}

            <div className="space-y-4">
              <div>
                <label className="label">Email</label>
                <input type="text" value={editingUser.email} disabled className="input bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400" />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 inline-flex items-center gap-1">
                  User ID: <CopyableId value={editingUser.id} size="sm" />
                </p>
              </div>
              <div>
                <label className="label">Organization</label>
                <input type="text" value={editingUser.organizationName || 'None'} disabled className="input bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400" />
              </div>
              <div>
                <label className="label">Role</label>
                <select value={editRole} onChange={(e) => setEditRole(e.target.value as 'owner' | 'admin' | 'member')} className="input" disabled={editForm.loading || editingUser.id === user?.id}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  <option value="owner">Owner</option>
                </select>
                {editingUser.id === user?.id && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Cannot change your own role</p>
                )}
              </div>
              {/* Wrapped in a <form> with a username field + autocomplete hints
                  so browsers/password managers treat this as a credential change
                  (silences Chrome's "Password field is not contained in a form"
                  warning). onSubmit is a no-op — saving goes through the explicit
                  "Save Changes" button below; this just prevents an Enter keypress
                  from reloading the page. */}
              <form onSubmit={(e) => e.preventDefault()}>
                <label className="label">New Password (leave blank to keep current)</label>
                <input type="text" name="username" autoComplete="username" value={editingUser.email} readOnly hidden />
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Minimum 8 characters" autoComplete="new-password" className="input" disabled={editForm.loading} />
              </form>

              <SysadminGrantHistory userId={editingUser.id} isSuperAdmin={editingUser.isSuperAdmin === true} />

              <FeatureOverridesEditor
                userId={editingUser.id}
                initial={editingUser.featureOverrides ?? {}}
                onSaved={() => list.refresh()}
              />
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button onClick={() => setEditingUser(null)} disabled={editForm.loading} className="btn btn-secondary">Cancel</button>
              {/* "View as user" — sysadmin impersonation (read-only). Disabled
                  for sysadmin targets (you can't impersonate another sysadmin)
                  and for the actor themselves. */}
              {editingUser.id !== user?.id && !editingUser.isSuperAdmin && (
                <button
                  onClick={() => setImpersonateTarget(editingUser)}
                  disabled={editForm.loading}
                  className="btn btn-secondary"
                  title="View the app as this user (read-only)"
                >
                  View as user
                </button>
              )}
              <button onClick={handleSaveUser} disabled={editForm.loading} className="btn btn-primary">
                {editForm.loading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
                Save Changes
              </button>
            </div>
          </div>
        </div>
        </ModalPortal>
      )}
    </DashboardLayout>
  );
}

/**
 * Inline timeline of platform-admin grant/revoke events for a user. Queries
 * the audit log filtered to `targetId = userId + action LIKE
 * admin.superadmin.*`. Shows the most recent few entries with date,
 * action, and source ('admin-api' vs 'bootstrap-env').
 *
 * Renders nothing until expanded — keeps the modal lean for the common
 * case (non-sysadmin user edits).
 */
function SysadminGrantHistory({ userId, isSuperAdmin }: { userId: string; isSuperAdmin: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<Array<{ _id: string; action: string; actorId: string; actorEmail?: string; details?: Record<string, unknown>; createdAt: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    api.listAuditEvents({
      targetId: userId,
      // Two actions to fetch; substring match against the regex filter.
      action: 'admin.superadmin',
      limit: 10,
    }).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) setEvents(res.data.events);
      else setError(res.message || 'Failed to load grant history');
    }).catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [userId, expanded]);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left font-medium text-gray-700 dark:text-gray-300"
      >
        <span>Platform-admin grant history {isSuperAdmin && <Badge color="red">currently granted</Badge>}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-2">
          {loading && <LoadingSpinner size="sm" />}
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          {!loading && events.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">No grant events on file.</p>
          )}
          {events.length > 0 && (
            <ul className="space-y-1.5 text-xs text-gray-600 dark:text-gray-400">
              {events.map((e) => {
                const source = (e.details as { source?: string } | undefined)?.source;
                const verb = e.action.endsWith('.grant') ? 'Granted' : 'Revoked';
                return (
                  <li key={e._id} className="flex items-baseline justify-between gap-2">
                    <span>
                      <strong className="text-gray-700 dark:text-gray-300">{verb}</strong>
                      {' '}by{' '}<code>{e.actorEmail || e.actorId}</code>
                      {source && <> · <code>{source}</code></>}
                    </span>
                    <span className="text-gray-500 dark:text-gray-500 whitespace-nowrap">
                      <RelativeTime value={e.createdAt} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

