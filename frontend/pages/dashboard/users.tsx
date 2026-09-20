import { useState, useMemo, useCallback, useEffect } from 'react';
import { formatError } from '@/lib/constants';
import { Users, UserPlus } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useListPage } from '@/hooks/useListPage';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import { useOrgOptions } from '@/hooks/useOrgOptions';
import { LoadingPage } from '@/components/ui/Loading';
import { SearchInput } from '@/components/ui/SearchInput';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { DataTable } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { ActionBar } from '@/components/ui/ActionBar';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { CreateUserModal } from '@/components/users/CreateUserModal';
import { EditUserModal } from '@/components/users/EditUserModal';
import { BreakglassModal } from '@/components/users/BreakglassModal';
import { DirectMfaResetModal } from '@/components/users/DirectMfaResetModal';
import Link from 'next/link';
import { buildUserColumns } from '@/components/users/userColumns';
import { useRowSelection, allSelected } from '@/components/dashboard/BulkActionBar';
import { BulkSelectionBanner, BulkResultSummary } from '@/components/dashboard/BulkSelectionBanner';
import { useAutoCloseTimer } from '@/hooks/useAutoCloseTimer';
import type { UserListItem, NewUserState, OrgRoleOption } from '@/components/users/types';
import api from '@/lib/api';
import { interpretImpersonationStart } from '@/lib/impersonation-start';
import type { User } from '@/types';

/** The fresh `GET /users/:id` record, in the row shape the editor works on. */
function toListItem(u: User): UserListItem {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    isSuperAdmin: u.isSuperAdmin,
    isEmailVerified: u.isEmailVerified,
    organizationId: u.organizationId,
    organizationName: u.organizationName,
    createdAt: u.createdAt,
    featureOverrides: u.featureOverrides,
  };
}

/** System-admin-only page for managing users across all organizations. */
export default function UsersPage() {
  // Fleet-wide user administration is a sysadmin surface; the gate comes from
  // the nav entry (`systemAdminOnly`) via page-access.
  const { accessDenied, user, isReady, isAuthenticated, isSuperAdmin } = useAuthGuard();

  const list = useListPage<UserListItem>({
    fields: [
      { key: 'search', type: 'text', defaultValue: '', primary: true },
      { key: 'role', type: 'select', defaultValue: 'all' },
      // Org scope. The backend only applies the `role` filter when a specific
      // org is selected (cross-org role filtering is a no-op server-side), so
      // scoping to an org here also makes the Role filter meaningful.
      { key: 'organizationId', type: 'select', defaultValue: 'all' },
    ],
    fetcher: async (params) => {
      const response = await api.listUsers({
        ...(params.search && { search: params.search }),
        ...(params.role && params.role !== 'all' && { role: params.role }),
        ...(params.organizationId && params.organizationId !== 'all' && { organizationId: params.organizationId }),
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

  // Deleting an account and editing it both need a fresh password check; the
  // pending action is held here until StepUpModal confirms.
  const [pendingDelete, setPendingDelete] = useState<UserListItem | null>(null);
  const [pendingEdit, setPendingEdit] = useState<Parameters<typeof api.updateUserById>[1] | null>(null);

  const executeDelete = useCallback(async (stepUpToken: string) => {
    if (!pendingDelete) return;
    try {
      await api.deleteUserById(pendingDelete.id, stepUpToken);
      list.refresh();
    } catch (err) {
      list.setError(formatError(err, 'Failed to delete user'));
    } finally {
      setPendingDelete(null);
    }
  }, [list, pendingDelete]);

  // Shared org picker for both the create- and edit-user modals — reused to
  // populate the cross-org "Organization" filter dropdown below.
  const { orgOptions, loadOrgOptions } = useOrgOptions();

  // Populate the org filter dropdown once the page is authorized.
  useEffect(() => {
    if (isAuthenticated && isSuperAdmin) loadOrgOptions();
  }, [isAuthenticated, isSuperAdmin, loadOrgOptions]);

  // Client-side "Super Admins only" facet over the current page (no backend
  // param — platform-admin isn't a server-side list filter).
  const [superAdminsOnly, setSuperAdminsOnly] = useState(false);
  const displayedUsers = useMemo(
    () => (superAdminsOnly ? list.data.filter((u) => u.isSuperAdmin) : list.data),
    [list.data, superAdminsOnly],
  );

  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  // The editor opens on the list row (no flash), then re-reads the user so it
  // shows — and diffs against — their CURRENT record, not a possibly stale row.
  const editingId = editingUser?.id ?? null;
  const detail = useFetch(
    async (signal) => (editingId ? (await api.getUser(editingId, { signal })).data?.user ?? null : null),
    [editingId],
  );
  // Delayed auto-close after a successful create/edit, so the success message is
  // readable before the modal goes.
  const editClose = useAutoCloseTimer();
  const createClose = useAutoCloseTimer();
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
  // Emergency access: pick the target, collect a justification, THEN step up.
  const [breakglassTarget, setBreakglassTarget] = useState<UserListItem | null>(null);
  // Sysadmin DIRECT MFA reset — for an org with no second admin to approve a
  // two-person request.
  const [resetMfaTarget, setResetMfaTarget] = useState<UserListItem | null>(null);
  const [breakglassJustification, setBreakglassJustification] = useState<string | null>(null);
  // A request that is waiting on someone else. Not an error — it's the consent
  // flow working — so it gets its own notice rather than the error banner.
  const [waitingNotice, setWaitingNotice] = useState<string | null>(null);

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
    createClose.cancel();
    setNewUser({ username: '', email: '', password: '', organizationId: '', role: 'member', isSuperAdmin: false });
    setOrgRoles([]);
    setSelectedRoleIds(new Set());
    createForm.reset();
    setShowCreate(true);
    // Populate the org picker. Best-effort — a failure just leaves the
    // "— No organization —" default (users can still be created org-less).
    loadOrgOptions();
  }, [createForm, loadOrgOptions, createClose]);

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
      createClose.schedule(() => setShowCreate(false), 1200);
    }
  };

  const executeImpersonate = useCallback(async (stepUpToken: string) => {
    if (!impersonateTarget) return;
    try {
      const outcome = interpretImpersonationStart(
        await api.impersonateUser(impersonateTarget.id, stepUpToken),
        'Impersonation failed',
      );
      if (outcome.kind === 'waiting') {
        // The org requires consent: nothing to start yet. Say so, instead of
        // silently doing nothing or reporting the consent flow as an error.
        setWaitingNotice(`Access to ${impersonateTarget.email} is waiting for approval.`);
      } else if (outcome.kind === 'started') {
        // requestId is kept so "Stop impersonating" can end the session on the
        // server, not just in this browser.
        api.startImpersonation(outcome.accessToken, outcome.requestId);
        // Hard-reload to refresh useAuth + every cached query under the new
        // identity. Lighter than threading a swap event through every hook.
        window.location.href = '/dashboard';
      } else {
        list.setError(outcome.message);
      }
    } catch (err) {
      list.setError(formatError(err, 'Impersonation failed'));
    }
  }, [impersonateTarget, list]);

  const executeBreakglass = useCallback(async (stepUpToken: string) => {
    if (!breakglassTarget || !breakglassJustification) return;
    try {
      const outcome = interpretImpersonationStart(
        await api.breakglassImpersonation(breakglassTarget.id, breakglassJustification, stepUpToken),
        'Emergency access failed',
      );
      if (outcome.kind === 'waiting') {
        setWaitingNotice(`Emergency access to ${breakglassTarget.email} needs a second administrator to approve it.`);
      } else if (outcome.kind === 'started') {
        api.startImpersonation(outcome.accessToken, outcome.requestId);
        window.location.href = '/dashboard';
      } else {
        list.setError(outcome.message);
      }
    } catch (err) {
      list.setError(formatError(err, 'Emergency access failed'));
    } finally {
      setBreakglassTarget(null);
      setBreakglassJustification(null);
    }
  }, [breakglassTarget, breakglassJustification, list]);

  // Multi-select state for bulk delete. Stored as a Set of user IDs so
  // selection survives across filter / page changes within a session —
  // matches the typical sysadmin flow (search → check several → repeat
  // with a different search → bulk-delete the union).
  const { selectedIds, toggle: toggleSelected, toggleAll, clear: clearSelection, replace: replaceSelection } = useRowSelection();
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ deleted: number; failed: number; errors: string[] } | null>(null);

  // Header checkbox: select-all / clear-all relative to the visible page.
  // Derive from `displayedUsers` (the "Super Admins only" facet), NOT the raw
  // page — otherwise select-all would select hidden rows and feed them into the
  // destructive bulk-delete.
  const visibleIds = useMemo(() => displayedUsers.map((u) => u.id).filter((id) => id !== user?.id), [displayedUsers, user]);
  const allVisibleSelected = allSelected(selectedIds, visibleIds);
  const toggleSelectAllVisible = useCallback(() => toggleAll(visibleIds), [toggleAll, visibleIds]);

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
        replaceSelection(failures.map((r) => r.id));
        list.refresh();
      } else {
        list.setError(res.message || 'Bulk delete failed');
      }
    } catch (err) {
      list.setError(formatError(err, 'Bulk delete failed'));
    }
  }, [selectedIds, list, replaceSelection]);

  /** Load a user record into the editor's fields. */
  const fillEditor = useCallback((userItem: UserListItem) => {
    setEditingUser(userItem);
    setEditUsername(userItem.username);
    setEditEmail(userItem.email);
    setEditOrgId(userItem.organizationId || '');
    setEditRole(userItem.role);
  }, []);

  const handleEditUser = (userItem: UserListItem) => {
    editClose.cancel();
    fillEditor(userItem);
    setNewPassword('');
    editForm.reset();
    // Populate the org picker (shared with the create modal). Best-effort —
    // a failure just leaves the current org selectable via its own value.
    loadOrgOptions();
  };

  // Swap the row for the fresh record once it arrives (only for the user still
  // open — a late answer for a closed editor is dropped by the key change).
  useEffect(() => {
    if (detail.data && detail.data.id === editingId) fillEditor(toListItem(detail.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the fetched record
  }, [detail.data]);

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

    setPendingEdit(updates);
  };

  const executeEdit = async (stepUpToken: string) => {
    const updates = pendingEdit;
    setPendingEdit(null);
    if (!editingUser || !updates) return;
    const result = await editForm.run(
      () => api.updateUserById(editingUser.id, updates, stepUpToken),
      { successMessage: 'User updated successfully' },
    );

    if (result !== null) {
      list.refresh();
      detail.refetch();
      setNewPassword('');
      const savedId = editingUser.id;
      editClose.schedule(() => {
        setEditingUser((current) => (current?.id === savedId ? null : current));
      }, 1500);
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
    onDelete: (u) => setPendingDelete(u),
    onResetMfa: (u) => setResetMfaTarget(u),
  }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the column builder closes over per-render handlers; the listed values are what change it
    [user, toggleSuperAdmin, selectedIds, toggleSelected, allVisibleSelected, toggleSelectAllVisible]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
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
      <ErrorAlert message={list.error} onRetry={list.refresh} onDismiss={() => list.setError(null)} />
      {waitingNotice && (
        <InfoAlert
          message={<>{waitingNotice} Once it&apos;s approved, open it from <Link href="/dashboard/access-requests" className="action-link">Access requests</Link>.</>}
          onDismiss={() => setWaitingNotice(null)}
        />
      )}

      <div className="filter-bar">
        <ActionBar
          left={
            <SearchInput placeholder="Search by username or email..." value={list.filters.search} onChange={(v) => list.updateFilter('search', v)} aria-label="Search users by username or email" />
          }
          right={
            <div className="flex flex-wrap items-center gap-2">
              <FilterSelect value={list.filters.organizationId} onChange={(e) => list.updateFilter('organizationId', e.target.value)} aria-label="Filter by organization">
                <option value="all">All Organizations</option>
                {orgOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </FilterSelect>
              <FilterSelect value={list.filters.role} onChange={(e) => list.updateFilter('role', e.target.value)} aria-label="Filter by role">
                <option value="all">All Roles</option>
                <option value="member">Members</option>
                <option value="admin">Admins</option>
              </FilterSelect>
              <button
                type="button"
                onClick={() => setSuperAdminsOnly((v) => !v)}
                aria-pressed={superAdminsOnly}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${superAdminsOnly
                  ? 'bg-brand text-white border-brand'
                  : 'bg-surface text-fg-muted border-default hover:bg-surface-muted'}`}
              >
                Super Admins only
              </button>
            </div>
          }
        />
      </div>

      <BulkSelectionBanner
        count={selectedIds.size}
        noun="user"
        actionLabel="Delete"
        onClear={clearSelection}
        onAction={() => setPendingBulkDelete(true)}
      />

      {bulkResult && (
        <BulkResultSummary failed={bulkResult.failed} errors={bulkResult.errors} onDismiss={() => setBulkResult(null)}>
          Bulk delete finished — <strong>{bulkResult.deleted}</strong> deleted, <strong>{bulkResult.failed}</strong> failed.
        </BulkResultSummary>
      )}

      {/* The "Super Admins only" facet is applied client-side over the current
          page (platform-admin isn't a server list filter), so label it as
          page-scoped rather than implying it searched every org. */}
      {superAdminsOnly && (
        <InfoAlert
          className="mt-3"
          message={`Filtering Super Admins on the current page only — showing ${displayedUsers.length} of ${list.data.length}.`}
        />
      )}

      <DataTable
        data={displayedUsers}
        columns={userColumns}
        isLoading={list.isLoading}
        loadFailed={!!list.error}
        onRetry={list.refresh}
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

      {pendingDelete && (
        <StepUpModal
          action={`Permanently delete ${pendingDelete.email}'s account from every organization`}
          onConfirmed={executeDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}

      {editingUser && pendingEdit && (
        <StepUpModal
          action={`Save changes to ${editingUser.email}`}
          onConfirmed={executeEdit}
          onClose={() => setPendingEdit(null)}
        />
      )}

      {pendingGrant && (
        <StepUpModal
          action={`${pendingGrant.isSuperAdmin ? 'Revoke' : 'Grant'} platform-admin for ${pendingGrant.email}`}
          /* Backed by a route that accepts only a SECOND FACTOR (#8) — a
             passkey or an authenticator code. A password re-prompt proves
             nothing an attacker holding this session doesn't already have. */
          requireStrongFactor
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
          /* Backed by a route that accepts only a SECOND FACTOR (#8) — a
             passkey or an authenticator code. A password re-prompt proves
             nothing an attacker holding this session doesn't already have. */
          requireStrongFactor
          onConfirmed={executeImpersonate}
          onClose={() => setImpersonateTarget(null)}
        />
      )}

      {resetMfaTarget && (
        <DirectMfaResetModal
          target={resetMfaTarget}
          onClose={() => setResetMfaTarget(null)}
          onDone={() => list.refresh()}
        />
      )}

      {breakglassTarget && !breakglassJustification && (
        <BreakglassModal
          targetLabel={breakglassTarget.email}
          onContinue={setBreakglassJustification}
          onClose={() => setBreakglassTarget(null)}
        />
      )}
      {breakglassTarget && breakglassJustification && (
        <StepUpModal
          action={`Take emergency access to ${breakglassTarget.email}`}
          /* Backed by a route that accepts only a SECOND FACTOR (#8) — a
             passkey or an authenticator code. A password re-prompt proves
             nothing an attacker holding this session doesn't already have. */
          requireStrongFactor
          onConfirmed={executeBreakglass}
          onClose={() => { setBreakglassTarget(null); setBreakglassJustification(null); }}
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
        onBreakglass={() => setBreakglassTarget(editingUser)}
        onSubmit={handleSaveUser}
        onClose={() => setEditingUser(null)}
        onFeatureSaved={() => { list.refresh(); detail.refetch(); }}
        detailLoading={detail.loading}
        detailError={detail.error ? formatError(detail.error, 'Could not load this user\'s latest details — showing the list row.') : null}
      />
    </DashboardLayout>
  );
}
