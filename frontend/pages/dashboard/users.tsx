import { useState, useMemo, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { Search, Users, Trash2, UserPlus } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useListPage } from '@/hooks/useListPage';
import { useFormState } from '@/hooks/useFormState';
import { useDelete } from '@/hooks/useDelete';
import { useOrgOptions } from '@/hooks/useOrgOptions';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { DataTable } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ActionBar } from '@/components/ui/ActionBar';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { CreateUserModal } from '@/components/users/CreateUserModal';
import { EditUserModal } from '@/components/users/EditUserModal';
import { buildUserColumns } from '@/components/users/userColumns';
import type { UserListItem, NewUserState, OrgRoleOption } from '@/components/users/types';
import api from '@/lib/api';

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

  // Shared org picker for both the create- and edit-user modals.
  const { orgOptions, loadOrgOptions } = useOrgOptions();

  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  const [editUsername, setEditUsername] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editOrgId, setEditOrgId] = useState('');
  const [editRole, setEditRole] = useState<'owner' | 'admin' | 'member'>('member');
  const [newPassword, setNewPassword] = useState('');
  const editForm = useFormState();
  // Gate for grant/revoke platform-admin. When set, StepUpModal renders and
  // calls the captured action on password-verify success.
  const [pendingGrant, setPendingGrant] = useState<UserListItem | null>(null);
  const [impersonateTarget, setImpersonateTarget] = useState<UserListItem | null>(null);

  // Create-user modal state.
  const [showCreate, setShowCreate] = useState(false);
  const createForm = useFormState();
  const [newUser, setNewUser] = useState<NewUserState>({ username: '', email: '', password: '', organizationId: '', role: 'member', isSuperAdmin: false });
  // Roles of the currently-selected org (org-scoped; empty until an org is
  // picked) + the subset checked for assignment. Roles require an org, so
  // selecting/clearing the org refetches + resets this.
  const [orgRoles, setOrgRoles] = useState<OrgRoleOption[]>([]);
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(new Set());

  // Load an org's roles for the assignment picker; clears when no org.
  const loadOrgRoles = useCallback((orgId: string) => {
    if (!orgId) { setOrgRoles([]); return; }
    api.getOrganizationRoles(orgId)
      .then((res) => { if (res.success && res.data) setOrgRoles(res.data.roles.map((g) => ({ id: g.id, name: g.name, grantsRole: g.grantsRole }))); })
      .catch(() => setOrgRoles([]));
  }, []);

  // Org change: update the field, reset any role selection (roles are
  // org-scoped), and refetch the new org's roles.
  const handleCreateOrgChange = useCallback((orgId: string) => {
    setNewUser((s) => ({ ...s, organizationId: orgId }));
    setSelectedRoleIds(new Set());
    loadOrgRoles(orgId);
  }, [loadOrgRoles]);

  const toggleRole = useCallback((id: string) => {
    setSelectedRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openCreate = useCallback(() => {
    setNewUser({ username: '', email: '', password: '', organizationId: '', role: 'member', isSuperAdmin: false });
    setOrgRoles([]);
    setSelectedRoleIds(new Set());
    createForm.reset();
    setShowCreate(true);
    // Populate the org picker. Best-effort — a failure just leaves the
    // "— No organization —" default (users can still be created org-less).
    loadOrgOptions();
  }, [createForm, loadOrgOptions]);

  const handleCreateUser = async () => {
    if (newUser.username.trim().length < 2) { createForm.setError('Username must be at least 2 characters'); return; }
    if (!newUser.email.trim()) { createForm.setError('Email is required'); return; }
    if (newUser.password.length < 8) { createForm.setError('Password must be at least 8 characters'); return; }

    const result = await createForm.run(
      () => api.createUser({
        username: newUser.username.trim(),
        email: newUser.email.trim(),
        password: newUser.password,
        ...(newUser.isSuperAdmin && { isSuperAdmin: true }),
        ...(newUser.organizationId && { organizationId: newUser.organizationId, role: newUser.role }),
        // Roles are org-scoped — only send them alongside an org.
        ...(newUser.organizationId && selectedRoleIds.size > 0 && { roleIds: Array.from(selectedRoleIds) }),
      }),
      { successMessage: 'User created successfully' },
    );

    if (result !== null) {
      list.refresh();
      setTimeout(() => setShowCreate(false), 1200);
    }
  };

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
    setEditUsername(userItem.username);
    setEditEmail(userItem.email);
    setEditOrgId(userItem.organizationId || '');
    setEditRole(userItem.role);
    setNewPassword('');
    editForm.reset();
    // Populate the org picker (shared with the create modal). Best-effort —
    // a failure just leaves the current org selectable via its own value.
    loadOrgOptions();
  };

  const handleSaveUser = async () => {
    if (!editingUser) return;

    // Build the body from only the fields that actually changed so an
    // untouched email/username/org isn't re-sent (and re-validated) server-side.
    const updates: { username?: string; email?: string; role?: string; organizationId?: string | null; password?: string } = {};

    const trimmedUsername = editUsername.trim();
    if (trimmedUsername !== editingUser.username) {
      if (trimmedUsername.length < 2) { editForm.setError('Username must be at least 2 characters'); return; }
      updates.username = trimmedUsername;
    }

    const trimmedEmail = editEmail.trim();
    if (trimmedEmail !== editingUser.email) {
      if (!trimmedEmail) { editForm.setError('Email is required'); return; }
      updates.email = trimmedEmail;
    }

    if (editRole !== editingUser.role) updates.role = editRole;

    // Empty selection => "— No organization —"; send null to remove from org.
    if (editOrgId !== (editingUser.organizationId || '')) {
      updates.organizationId = editOrgId === '' ? null : editOrgId;
    }

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

  const userColumns = useMemo(() => buildUserColumns({
    currentUserId: user?.id,
    allVisibleSelected,
    onToggleSelectAllVisible: toggleSelectAllVisible,
    selectedIds,
    onToggleSelected: toggleSelected,
    onEdit: handleEditUser,
    onToggleSuperAdmin: toggleSuperAdmin,
    onDelete: (u) => del.open(u),
  }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, toggleSuperAdmin, selectedIds, toggleSelected, allVisibleSelected, toggleSelectAllVisible, del]);

  if (!isReady || !user) return <LoadingPage />;
  if (!isSuperAdmin) return null;

  return (
    <DashboardLayout
      title="All Users"
      subtitle="System-wide user administration"
      actions={
        <Button onClick={openCreate} className="inline-flex items-center gap-1">
          <UserPlus className="h-4 w-4" /> Add User
        </Button>
      }
    >
      <ErrorAlert message={list.error} onDismiss={() => list.setError(null)} />

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
            <Button
              variant="danger"
              onClick={() => setPendingBulkDelete(true)}
              className="inline-flex items-center gap-1 text-sm"
            >
              <Trash2 className="h-4 w-4" /> Delete {selectedIds.size}
            </Button>
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

      <CreateUserModal
        open={showCreate}
        form={createForm}
        newUser={newUser}
        setNewUser={setNewUser}
        orgOptions={orgOptions}
        orgRoles={orgRoles}
        selectedRoleIds={selectedRoleIds}
        onOrgChange={handleCreateOrgChange}
        onToggleRole={toggleRole}
        onSubmit={handleCreateUser}
        onClose={() => setShowCreate(false)}
      />

      <EditUserModal
        editingUser={editingUser}
        form={editForm}
        currentUserId={user?.id}
        editUsername={editUsername}
        onEditUsernameChange={setEditUsername}
        editEmail={editEmail}
        onEditEmailChange={setEditEmail}
        editOrgId={editOrgId}
        onEditOrgIdChange={setEditOrgId}
        editRole={editRole}
        onEditRoleChange={setEditRole}
        newPassword={newPassword}
        onNewPasswordChange={setNewPassword}
        orgOptions={orgOptions}
        onImpersonate={() => setImpersonateTarget(editingUser)}
        onSubmit={handleSaveUser}
        onClose={() => setEditingUser(null)}
        onFeatureSaved={() => list.refresh()}
      />
    </DashboardLayout>
  );
}
