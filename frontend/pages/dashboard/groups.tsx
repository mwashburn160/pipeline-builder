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
import { PERMISSION_CATEGORIES, permissionLabel } from '@/lib/permissions';
import api from '@/lib/api';
import type { OrganizationGroup, GroupRole } from '@/types';

/** Badge colour per role a group grants — superadmin is the loudest. */
const ROLE_BADGE: Record<GroupRole, 'red' | 'purple' | 'gray'> = {
  superadmin: 'red',
  admin: 'purple',
  member: 'gray',
};

const ROLE_LABEL: Record<GroupRole, string> = {
  superadmin: 'grants platform admin',
  admin: 'grants org admin',
  member: 'standard access',
};

export default function GroupsPage() {
  const { user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin, can } = useAuthGuard({ requirePermission: 'groups:manage' });
  // Capability to manage groups — role admins/owners (via their bundle) and
  // custom-group members granted `groups:manage`. The page is guarded on it.
  const canManageGroups = can('groups:manage');
  const toast = useToast();
  const orgId = user?.organizationId;

  const [groups, setGroups] = useState<OrganizationGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-member modal (scoped to one group).
  const [addToGroup, setAddToGroup] = useState<OrganizationGroup | null>(null);
  const [addEmail, setAddEmail] = useState('');
  const addForm = useFormState();

  // Remove confirmation — carries the group + member so the warning can name
  // the exact consequence (revokes org-admin / platform-admin).
  const [removeTarget, setRemoveTarget] = useState<{ group: OrganizationGroup; member: OrganizationGroup['members'][number] } | null>(null);
  const [removeLoading, setRemoveLoading] = useState(false);

  const fetchGroups = useCallback(async () => {
    if (!orgId) return;
    try {
      setIsLoading(true);
      const res = await api.getOrganizationGroups(orgId);
      setGroups(res.data?.groups ?? []);
      setError(null);
    } catch {
      setError('Failed to load groups');
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    if (isAuthenticated && canManageGroups && orgId) fetchGroups();
  }, [isAuthenticated, canManageGroups, orgId, fetchGroups]);

  // Role-based UI: a group that grants platform admin (Superadmins) can only be
  // managed by an existing platform admin; org admins manage the rest.
  const canEditGroup = (g: OrganizationGroup) => (g.grantsRole === 'superadmin' ? isSuperAdmin : canManageGroups);

  // Why a member's removal is blocked (mirrors the backend lockout guards so the
  // button is disabled rather than failing with an error toast). Returns the
  // reason string, or null when removal is allowed. Member-only groups (Developers)
  // are never blocked — losing them revokes nothing.
  const removeBlockReason = (g: OrganizationGroup, memberId: string): string | null => {
    // Note: the org owner is intentionally NOT special-cased here. The backend
    // preserves owner access regardless of group membership (recomputeUserOrgRole
    // never downgrades 'owner'), so an owner removing themselves from a group
    // can't actually lose owner access — only the group's granted role.
    if (g.grantsRole === 'member') return null;
    // G2: can't remove yourself from a group granting your own admin/superadmin.
    if (memberId === user?.id) return 'You cannot remove yourself from this group — it grants your own access. Have another admin do it.';
    // G3: can't empty a privilege-granting group.
    if (g.members.length <= 1) return 'Cannot remove the last member — the organization would have no one in this role. Add another first.';
    return null;
  };

  const openAdd = (g: OrganizationGroup) => {
    setAddEmail('');
    addForm.reset();
    setAddToGroup(g);
  };

  const handleAdd = async () => {
    if (!orgId || !addToGroup || !addEmail.trim()) return;
    const email = addEmail.trim().toLowerCase();
    const result = await addForm.run(() => api.addGroupMember(orgId, addToGroup.id, { email }));
    if (result !== null) {
      toast.success(`Added ${email} to ${addToGroup.name}`);
      setAddToGroup(null);
      setAddEmail('');
      fetchGroups();
    }
  };

  const handleRemove = async () => {
    if (!orgId || !removeTarget) return;
    const { group, member } = removeTarget;
    setRemoveLoading(true);
    try {
      const res = await api.removeGroupMember(orgId, group.id, member.id);
      if (!res.success) throw new Error(res.message || 'Failed to remove from group');
      toast.success(`Removed ${member.username} from ${group.name}`);
      setRemoveTarget(null);
      fetchGroups();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove from group');
    } finally {
      setRemoveLoading(false);
    }
  };

  // Create / edit a custom permission group. `editorGroup === null` = create;
  // otherwise editing that (non-system) group.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorGroup, setEditorGroup] = useState<OrganizationGroup | null>(null);
  const [groupName, setGroupName] = useState('');
  const [groupDesc, setGroupDesc] = useState('');
  const [groupPerms, setGroupPerms] = useState<Set<string>>(new Set());
  const editorForm = useFormState();
  const [deleteTarget, setDeleteTarget] = useState<OrganizationGroup | null>(null);
  const del = useFormState();

  const openCreate = () => {
    setEditorGroup(null);
    setGroupName('');
    setGroupDesc('');
    setGroupPerms(new Set());
    editorForm.reset();
    setEditorOpen(true);
  };

  const openEdit = (g: OrganizationGroup) => {
    setEditorGroup(g);
    setGroupName(g.name);
    setGroupDesc(g.description ?? '');
    setGroupPerms(new Set(g.permissions));
    editorForm.reset();
    setEditorOpen(true);
  };

  const togglePerm = (id: string) => {
    setGroupPerms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSaveGroup = async () => {
    if (!orgId || !groupName.trim()) return;
    const payload = {
      name: groupName.trim(),
      description: groupDesc.trim() || undefined,
      permissions: [...groupPerms],
    };
    const result = await editorForm.run(() => editorGroup
      ? api.updateGroup(orgId, editorGroup.id, payload)
      : api.createGroup(orgId, payload));
    if (result !== null) {
      toast.success(editorGroup ? `Updated ${payload.name}` : `Created ${payload.name}`);
      setEditorOpen(false);
      fetchGroups();
    }
  };

  const handleDeleteGroup = async () => {
    if (!orgId || !deleteTarget) return;
    const result = await del.run(() => api.deleteGroup(orgId, deleteTarget.id));
    if (result !== null) {
      toast.success(`Deleted ${deleteTarget.name}`);
      setDeleteTarget(null);
      fetchGroups();
    }
  };

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Groups"
      subtitle="Permission groups grant roles and fine-grained permissions to their members"
      maxWidth="4xl"
      actions={
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-1.5" /> New Group
        </Button>
      }
    >
      <RoleBanner isSuperAdmin={isSuperAdmin} isOrgAdmin={isOrgAdminUser} isAdmin={isAdmin} resourceName="permission groups" />

      <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-600 dark:text-gray-400">
        <ShieldCheck className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
        <span>
          A member&apos;s role is derived from their groups. Adding someone to <strong>Administrators</strong> grants
          them org-admin; removing them revokes it. The <strong>Superadmins</strong> group (system organization only)
          grants platform-wide admin. The organization <strong>owner</strong> always keeps owner access regardless of groups.
        </span>
      </div>

      <ErrorAlert message={error} onDismiss={() => setError(null)} />

      {isLoading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading groups…</p>
      ) : groups.length === 0 ? (
        <div className="card text-center py-10">
          <Users className="w-8 h-8 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
          <p className="text-sm text-gray-500 dark:text-gray-400">No permission groups in this organization yet.</p>
          <div className="mt-4">
            <Button onClick={openCreate}>
              <Plus className="w-4 h-4 mr-1.5" /> Create your first group
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const editable = canEditGroup(g);
            const isSuperGroup = g.grantsRole === 'superadmin';
            return (
              <div key={g.id} className="card">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-2 flex-wrap">
                      {isSuperGroup ? <ShieldAlert className="w-4 h-4 text-red-500" /> : <ShieldCheck className="w-4 h-4 text-gray-400" />}
                      {g.name}
                      {g.system
                        ? <Badge color={ROLE_BADGE[g.grantsRole]}>{g.grantsRole}</Badge>
                        : <Badge color="blue">custom</Badge>}
                    </h2>
                    {g.description && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{g.description}</p>
                    )}
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {g.system ? ROLE_LABEL[g.grantsRole] : `${g.permissions.length} permission${g.permissions.length === 1 ? '' : 's'}`} · {g.members.length} member{g.members.length === 1 ? '' : 's'}
                    </p>
                    {g.permissions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {g.permissions.map((p) => (
                          <span key={p} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                            <KeyRound className="w-2.5 h-2.5 text-gray-400" />{permissionLabel(p)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {editable && !g.system && (
                      <>
                        <IconButton tone="primary" onClick={() => openEdit(g)} title={`Edit ${g.name}`} aria-label={`Edit ${g.name}`}>
                          <Pencil className="w-4 h-4" />
                        </IconButton>
                        <IconButton tone="danger" onClick={() => setDeleteTarget(g)} title={`Delete ${g.name}`} aria-label={`Delete ${g.name}`}>
                          <Trash2 className="w-4 h-4" />
                        </IconButton>
                      </>
                    )}
                    {editable && (
                      <Button variant="secondary" size="sm" onClick={() => openAdd(g)}>
                        <UserPlus className="w-3.5 h-3.5 mr-1" /> Add member
                      </Button>
                    )}
                  </div>
                </div>

                {g.members.length === 0 ? (
                  <p className="text-xs text-gray-400 dark:text-gray-500 italic">No members.</p>
                ) : (
                  <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {g.members.map((m) => {
                      const blockReason = removeBlockReason(g, m.id);
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
                              onClick={() => setRemoveTarget({ group: g, member: m })}
                              disabled={!!blockReason}
                              className="disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-400 disabled:hover:bg-transparent"
                              title={blockReason ?? `Remove ${m.username} from ${g.name}`}
                              aria-label={`Remove ${m.username} from ${g.name}`}
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

      {/* Add member to group */}
      {addToGroup && (
        <Modal
          title={`Add member to ${addToGroup.name}`}
          onClose={() => setAddToGroup(null)}
          footer={
            <ModalFooter
              onCancel={() => setAddToGroup(null)}
              onConfirm={handleAdd}
              confirmLabel="Add Member"
              loading={addForm.loading}
              confirmDisabled={!addEmail.trim()}
            />
          }
        >
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            Enter the email of an <strong>existing organization member</strong> to add to <strong>{addToGroup.name}</strong>.
          </p>
          {addToGroup.grantsRole !== 'member' && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mb-3 inline-flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              This group {addToGroup.grantsRole === 'superadmin' ? 'grants platform-wide admin' : 'grants organization admin'}. Add with care.
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
          title={`Remove from ${removeTarget.group.name}`}
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
                <strong className="text-gray-900 dark:text-gray-100">{removeTarget.group.name}</strong>?
              </p>
              {removeTarget.group.grantsRole === 'superadmin' && (
                <p className="mt-2 text-amber-700 dark:text-amber-400">
                  This will <strong>revoke their platform-admin access</strong> (unless another group still grants it).
                </p>
              )}
              {removeTarget.group.grantsRole === 'admin' && (
                <p className="mt-2 text-amber-700 dark:text-amber-400">
                  This will <strong>revoke their organization-admin access</strong> (unless another group still grants it). The
                  organization owner keeps owner access regardless.
                </p>
              )}
              {removeTarget.group.grantsRole === 'member' && (
                <p className="mt-2 text-gray-500 dark:text-gray-400">They&apos;ll remain an organization member; only this group assignment is removed.</p>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Create / edit a custom permission group */}
      {editorOpen && (
        <Modal
          title={editorGroup ? `Edit ${editorGroup.name}` : 'New Permission Group'}
          onClose={() => !editorForm.loading && setEditorOpen(false)}
          footer={
            <ModalFooter
              onCancel={() => setEditorOpen(false)}
              onConfirm={handleSaveGroup}
              confirmLabel={editorGroup ? 'Save changes' : 'Create group'}
              loading={editorForm.loading}
              confirmDisabled={!groupName.trim()}
            />
          }
        >
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Name</label>
              <Input
                type="text"
                placeholder="e.g. Deployers, QA, Read-only"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
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
                placeholder="What this group is for"
                value={groupDesc}
                onChange={(e) => setGroupDesc(e.target.value)}
                className="text-sm"
                disabled={editorForm.loading}
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Permissions <span className="text-gray-400 font-normal">({groupPerms.size} selected)</span>
              </label>
              <div className="max-h-72 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-100 dark:divide-gray-800">
                {PERMISSION_CATEGORIES.map(({ category, permissions }) => (
                  <div key={category} className="p-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{category}</p>
                    <div className="mt-1.5 space-y-1.5">
                      {permissions.map((p) => (
                        <label key={p.id} className="flex items-start gap-2 text-xs cursor-pointer">
                          <Checkbox
                            checked={groupPerms.has(p.id)}
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
                Members of this group get these permissions on top of their base role. The org owner and admins already have everything.
              </p>
            </div>
          </div>
          {editorForm.error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{editorForm.error}</p>}
        </Modal>
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          title="Delete Group"
          itemName={deleteTarget.name}
          loading={del.loading}
          onConfirm={handleDeleteGroup}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </DashboardLayout>
  );
}
