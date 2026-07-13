import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, ShieldAlert, Users, UserPlus, UserMinus, Crown, AlertTriangle, Plus, Pencil, Trash2, KeyRound } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFormState } from '@/hooks/useFormState';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { PERMISSION_CATEGORIES, permissionLabel, roleDisplayName } from '@/lib/permissions';
import api from '@/lib/api';
import type { OrganizationRole, RoleGrant } from '@/types';

/** Badge colour per coarse role a Role grants — superadmin is the loudest. */
const ROLE_BADGE: Record<RoleGrant, 'red' | 'purple' | 'gray'> = {
  superadmin: 'red',
  admin: 'purple',
  member: 'gray',
};

const ROLE_LABEL: Record<RoleGrant, string> = {
  superadmin: 'grants platform admin',
  admin: 'grants org admin',
  member: 'standard access',
};

export default function RolesPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin, can } = useAuthGuard({ requirePermission: 'roles:manage' });
  // Capability to manage Roles — role admins/owners (via their bundle) and
  // custom-role members granted `roles:manage`. The page is guarded on it.
  const canManageRoles = can('roles:manage');
  const toast = useToast();
  const orgId = user?.organizationId;

  const [roles, setRoles] = useState<OrganizationRole[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-member modal (scoped to one Role).
  const [addToRole, setAddToRole] = useState<OrganizationRole | null>(null);
  const [addEmail, setAddEmail] = useState('');
  const addForm = useFormState();

  // Remove confirmation — carries the Role + member so the warning can name
  // the exact consequence (revokes org-admin / platform-admin).
  const [removeTarget, setRemoveTarget] = useState<{ role: OrganizationRole; member: OrganizationRole['members'][number] } | null>(null);
  const [removeLoading, setRemoveLoading] = useState(false);

  const fetchRoles = useCallback(async () => {
    if (!orgId) return;
    try {
      setIsLoading(true);
      const res = await api.getOrganizationRoles(orgId);
      setRoles(res.data?.roles ?? []);
      setError(null);
    } catch {
      setError('Failed to load roles');
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    if (isAuthenticated && canManageRoles && orgId) fetchRoles();
  }, [isAuthenticated, canManageRoles, orgId, fetchRoles]);

  // Role-based UI: a Role that grants platform admin (Superadmins) can only be
  // managed by an existing platform admin; org admins manage the rest.
  const canEditRole = (r: OrganizationRole) => (r.grantsRole === 'superadmin' ? isSuperAdmin : canManageRoles);

  // Why a member's removal is blocked (mirrors the backend lockout guards so the
  // button is disabled rather than failing with an error toast). Returns the
  // reason string, or null when removal is allowed. Member-only Roles (Member)
  // are never blocked — losing them revokes nothing.
  const removeBlockReason = (r: OrganizationRole, memberId: string): string | null => {
    // Note: the org owner is intentionally NOT special-cased here. The backend
    // preserves owner access regardless of Role membership (recomputeUserOrgRole
    // never downgrades 'owner'), so an owner removing themselves from a Role
    // can't actually lose owner access — only the Role's granted access.
    if (r.grantsRole === 'member') return null;
    // G2: can't remove yourself from a Role granting your own admin/superadmin.
    if (memberId === user?.id) return 'You cannot remove yourself from this role — it grants your own access. Have another admin do it.';
    // G3: can't empty a privilege-granting Role.
    if (r.members.length <= 1) return 'Cannot remove the last member — the organization would have no one in this role. Add another first.';
    return null;
  };

  const openAdd = (r: OrganizationRole) => {
    setAddEmail('');
    addForm.reset();
    setAddToRole(r);
  };

  const handleAdd = async () => {
    if (!orgId || !addToRole || !addEmail.trim()) return;
    const email = addEmail.trim().toLowerCase();
    const result = await addForm.run(() => api.addRoleMember(orgId, addToRole.id, { email }));
    if (result !== null) {
      toast.success(`Added ${email} to ${roleDisplayName(addToRole.name)}`);
      setAddToRole(null);
      setAddEmail('');
      fetchRoles();
    }
  };

  const handleRemove = async () => {
    if (!orgId || !removeTarget) return;
    const { role, member } = removeTarget;
    setRemoveLoading(true);
    try {
      const res = await api.removeRoleMember(orgId, role.id, member.id);
      if (!res.success) throw new Error(res.message || 'Failed to remove from role');
      toast.success(`Removed ${member.username} from ${roleDisplayName(role.name)}`);
      setRemoveTarget(null);
      fetchRoles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove from role');
    } finally {
      setRemoveLoading(false);
    }
  };

  // Create / edit a custom Role. `editorRole === null` = create;
  // otherwise editing that (non-system) Role.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorRole, setEditorRole] = useState<OrganizationRole | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleDesc, setRoleDesc] = useState('');
  const [rolePerms, setRolePerms] = useState<Set<string>>(new Set());
  const editorForm = useFormState();
  const [deleteTarget, setDeleteTarget] = useState<OrganizationRole | null>(null);
  const del = useFormState();

  const openCreate = () => {
    setEditorRole(null);
    setRoleName('');
    setRoleDesc('');
    setRolePerms(new Set());
    editorForm.reset();
    setEditorOpen(true);
  };

  const openEdit = (r: OrganizationRole) => {
    setEditorRole(r);
    setRoleName(r.name);
    setRoleDesc(r.description ?? '');
    setRolePerms(new Set(r.permissions));
    editorForm.reset();
    setEditorOpen(true);
  };

  const togglePerm = (id: string) => {
    setRolePerms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSaveRole = async () => {
    if (!orgId || !roleName.trim()) return;
    const payload = {
      name: roleName.trim(),
      description: roleDesc.trim() || undefined,
      permissions: [...rolePerms],
    };
    const result = await editorForm.run(() => editorRole
      ? api.updateRole(orgId, editorRole.id, payload)
      : api.createRole(orgId, payload));
    if (result !== null) {
      toast.success(editorRole ? `Updated ${payload.name}` : `Created ${payload.name}`);
      setEditorOpen(false);
      fetchRoles();
    }
  };

  const handleDeleteRole = async () => {
    if (!orgId || !deleteTarget) return;
    const result = await del.run(() => api.deleteRole(orgId, deleteTarget.id));
    if (result !== null) {
      toast.success(`Deleted ${roleDisplayName(deleteTarget.name)}`);
      setDeleteTarget(null);
      fetchRoles();
    }
  };

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Roles"
      subtitle="A Role is a named set of permissions. Assign Roles to people to grant them access."
      maxWidth="4xl"
      actions={
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-1.5" /> New Role
        </Button>
      }
    >
      <RoleBanner isSuperAdmin={isSuperAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="roles" />

      <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-600 dark:text-gray-400">
        <ShieldCheck className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
        <span>
          A member&apos;s access is the union of their Roles. Adding someone to the <strong>Admin</strong> role grants
          them org-admin; removing them revokes it. The <strong>Superadmins</strong> role (system organization only)
          grants platform-wide admin. The organization <strong>owner</strong> always keeps owner access regardless of Roles.
        </span>
      </div>

      <ErrorAlert message={error} onDismiss={() => setError(null)} />

      {isLoading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading roles…</p>
      ) : roles.length === 0 ? (
        <div className="card text-center py-10">
          <Users className="w-8 h-8 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
          <p className="text-sm text-gray-500 dark:text-gray-400">No roles in this organization yet.</p>
          <div className="mt-4">
            <Button onClick={openCreate}>
              <Plus className="w-4 h-4 mr-1.5" /> Create your first role
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {roles.map((r) => {
            const editable = canEditRole(r);
            const isSuperRole = r.grantsRole === 'superadmin';
            return (
              <div key={r.id} className="card">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-2 flex-wrap">
                      {isSuperRole ? <ShieldAlert className="w-4 h-4 text-red-500" /> : <ShieldCheck className="w-4 h-4 text-gray-400" />}
                      {roleDisplayName(r.name)}
                      {r.system
                        ? <Badge color={ROLE_BADGE[r.grantsRole]}>{r.grantsRole}</Badge>
                        : <Badge color="blue">custom</Badge>}
                    </h2>
                    {r.description && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{r.description}</p>
                    )}
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {r.system ? ROLE_LABEL[r.grantsRole] : `${r.permissions.length} permission${r.permissions.length === 1 ? '' : 's'}`} · {r.members.length} member{r.members.length === 1 ? '' : 's'}
                    </p>
                    {r.permissions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {r.permissions.map((p) => (
                          <span key={p} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                            <KeyRound className="w-2.5 h-2.5 text-gray-400" />{permissionLabel(p)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {editable && !r.system && (
                      <>
                        <IconButton tone="primary" onClick={() => openEdit(r)} title={`Edit ${roleDisplayName(r.name)}`} aria-label={`Edit ${roleDisplayName(r.name)}`}>
                          <Pencil className="w-4 h-4" />
                        </IconButton>
                        <IconButton tone="danger" onClick={() => setDeleteTarget(r)} title={`Delete ${roleDisplayName(r.name)}`} aria-label={`Delete ${roleDisplayName(r.name)}`}>
                          <Trash2 className="w-4 h-4" />
                        </IconButton>
                      </>
                    )}
                    {editable && (
                      <Button variant="secondary" size="sm" onClick={() => openAdd(r)}>
                        <UserPlus className="w-3.5 h-3.5 mr-1" /> Add member
                      </Button>
                    )}
                  </div>
                </div>

                {r.members.length === 0 ? (
                  <p className="text-xs text-gray-400 dark:text-gray-500 italic">No members.</p>
                ) : (
                  <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {r.members.map((m) => {
                      const blockReason = removeBlockReason(r, m.id);
                      return (
                        <li key={m.id} className="py-2 flex items-center justify-between gap-2 text-sm">
                          <div className="min-w-0">
                            <span className="font-medium text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
                              {m.username}
                              {m.id === user?.id && <span className="text-xs text-gray-400">(you)</span>}
                            </span>
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{m.email}</p>
                          </div>
                          {editable && (
                            <IconButton
                              tone="danger"
                              onClick={() => setRemoveTarget({ role: r, member: m })}
                              disabled={!!blockReason}
                              className="disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-400 disabled:hover:bg-transparent"
                              title={blockReason ?? `Remove ${m.username} from ${roleDisplayName(r.name)}`}
                              aria-label={`Remove ${m.username} from ${roleDisplayName(r.name)}`}
                            >
                              {blockReason ? <Crown className="w-4 h-4" /> : <UserMinus className="w-4 h-4" />}
                            </IconButton>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add member to a Role */}
      {addToRole && (
        <Modal
          title={`Add member to ${roleDisplayName(addToRole.name)}`}
          onClose={() => setAddToRole(null)}
          footer={
            <ModalFooter
              onCancel={() => setAddToRole(null)}
              onConfirm={handleAdd}
              confirmLabel="Add Member"
              loading={addForm.loading}
              confirmDisabled={!addEmail.trim()}
            />
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            Enter the email of an <strong>existing organization member</strong> to add to <strong>{roleDisplayName(addToRole.name)}</strong>.
          </p>
          {addToRole.grantsRole !== 'member' && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mb-3 inline-flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              This role {addToRole.grantsRole === 'superadmin' ? 'grants platform-wide admin' : 'grants organization admin'}. Add with care.
            </p>
          )}
          <Input
            type="email"
            placeholder="user@example.com"
            value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="text-sm mt-1"
            autoFocus
          />
          {addForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{addForm.error}</p>}
        </Modal>
      )}

      {/* Remove confirmation with consequence warning */}
      {removeTarget && (
        <Modal
          title={`Remove from ${roleDisplayName(removeTarget.role.name)}`}
          onClose={() => !removeLoading && setRemoveTarget(null)}
          footer={
            <ModalFooter
              onCancel={() => setRemoveTarget(null)}
              onConfirm={handleRemove}
              confirmLabel="Remove"
              confirmVariant="danger"
              loading={removeLoading}
            />
          }
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-300">
              <p>
                Remove <strong className="text-gray-900 dark:text-gray-100">{removeTarget.member.username}</strong> from{' '}
                <strong className="text-gray-900 dark:text-gray-100">{roleDisplayName(removeTarget.role.name)}</strong>?
              </p>
              {removeTarget.role.grantsRole === 'superadmin' && (
                <p className="mt-2 text-amber-700 dark:text-amber-400">
                  This will <strong>revoke their platform-admin access</strong> (unless another role still grants it).
                </p>
              )}
              {removeTarget.role.grantsRole === 'admin' && (
                <p className="mt-2 text-amber-700 dark:text-amber-400">
                  This will <strong>revoke their organization-admin access</strong> (unless another role still grants it). The
                  organization owner keeps owner access regardless.
                </p>
              )}
              {removeTarget.role.grantsRole === 'member' && (
                <p className="mt-2 text-gray-500 dark:text-gray-400">They&apos;ll remain an organization member; only this role assignment is removed.</p>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Create / edit a custom Role */}
      {editorOpen && (
        <Modal
          title={editorRole ? `Edit ${roleDisplayName(editorRole.name)}` : 'New Role'}
          onClose={() => !editorForm.loading && setEditorOpen(false)}
          footer={
            <ModalFooter
              onCancel={() => setEditorOpen(false)}
              onConfirm={handleSaveRole}
              confirmLabel={editorRole ? 'Save changes' : 'Create role'}
              loading={editorForm.loading}
              confirmDisabled={!roleName.trim()}
            />
          }
        >
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Name</label>
              <Input
                type="text"
                placeholder="e.g. Deployers, QA, Read-only"
                value={roleName}
                onChange={(e) => setRoleName(e.target.value)}
                className="text-sm"
                autoFocus
                disabled={editorForm.loading}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Description <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <Input
                type="text"
                placeholder="What this role is for"
                value={roleDesc}
                onChange={(e) => setRoleDesc(e.target.value)}
                className="text-sm"
                disabled={editorForm.loading}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Permissions <span className="text-gray-400 font-normal">({rolePerms.size} selected)</span>
              </label>
              <div className="max-h-72 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-100 dark:divide-gray-800">
                {PERMISSION_CATEGORIES.map(({ category, permissions }) => (
                  <div key={category} className="p-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{category}</p>
                    <div className="mt-1.5 space-y-1.5">
                      {permissions.map((p) => (
                        <label key={p.id} className="flex items-start gap-2 text-xs cursor-pointer">
                          <Checkbox
                            checked={rolePerms.has(p.id)}
                            onChange={() => togglePerm(p.id)}
                            disabled={editorForm.loading}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="font-medium text-gray-800 dark:text-gray-200">{p.label}</span>
                            <span className="block text-gray-400 dark:text-gray-500">{p.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500">
                Members of this role get these permissions on top of their base access. The org owner and admins already have everything.
              </p>
            </div>
          </div>
          {editorForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{editorForm.error}</p>}
        </Modal>
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          title="Delete Role"
          itemName={roleDisplayName(deleteTarget.name)}
          loading={del.loading}
          onConfirm={handleDeleteRole}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </DashboardLayout>
  );
}
