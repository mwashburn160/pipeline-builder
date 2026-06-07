import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, ShieldAlert, Users, UserPlus, UserMinus, Crown, AlertTriangle } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFormState } from '@/hooks/useFormState';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
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
  const { user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin } = useAuthGuard({ requireAdmin: true });
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
    if (isAuthenticated && isAdmin && orgId) fetchGroups();
  }, [isAuthenticated, isAdmin, orgId, fetchGroups]);

  // Role-based UI: a group that grants platform admin (Superadmins) can only be
  // managed by an existing platform admin; org admins manage the rest.
  const canEditGroup = (g: OrganizationGroup) => (g.grantsRole === 'superadmin' ? isSuperAdmin : isAdmin);

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

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title="Groups"
      subtitle="Permission groups grant roles to their members"
      maxWidth="4xl"
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

      {error && (
        <div className="alert-error">
          <p>{error}</p>
          <button onClick={() => setError(null)} className="action-link-danger mt-2 underline">Dismiss</button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading groups…</p>
      ) : groups.length === 0 ? (
        <div className="card text-center py-10">
          <Users className="w-8 h-8 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
          <p className="text-sm text-gray-500 dark:text-gray-400">No permission groups in this organization yet.</p>
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
                    <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-2">
                      {isSuperGroup ? <ShieldAlert className="w-4 h-4 text-red-500" /> : <ShieldCheck className="w-4 h-4 text-gray-400" />}
                      {g.name}
                      <Badge color={ROLE_BADGE[g.grantsRole]}>{g.grantsRole}</Badge>
                    </h2>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {ROLE_LABEL[g.grantsRole]} · {g.members.length} member{g.members.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  {editable && (
                    <button onClick={() => openAdd(g)} className="btn btn-secondary btn-sm shrink-0">
                      <UserPlus className="w-3.5 h-3.5 mr-1" /> Add member
                    </button>
                  )}
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
                            <button
                              onClick={() => setRemoveTarget({ group: g, member: m })}
                              disabled={!!blockReason}
                              className="p-1.5 rounded-lg text-gray-400 enabled:hover:text-red-600 enabled:hover:bg-red-50 dark:enabled:hover:text-red-400 dark:enabled:hover:bg-red-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              title={blockReason ?? `Remove ${m.username} from ${g.name}`}
                              aria-label={`Remove ${m.username} from ${g.name}`}
                            >
                              {blockReason ? <Crown className="w-4 h-4" /> : <UserMinus className="w-4 h-4" />}
                            </button>
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
            <div className="flex justify-end gap-2">
              <button onClick={() => setAddToGroup(null)} className="btn btn-secondary" disabled={addForm.loading}>Cancel</button>
              <button onClick={handleAdd} disabled={addForm.loading || !addEmail.trim()} className="btn btn-primary">
                {addForm.loading ? 'Adding...' : 'Add Member'}
              </button>
            </div>
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
          <input
            type="email"
            placeholder="user@example.com"
            value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="input text-sm mt-1"
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
            <div className="flex justify-end gap-2">
              <button onClick={() => setRemoveTarget(null)} className="btn btn-secondary" disabled={removeLoading}>Cancel</button>
              <button onClick={handleRemove} disabled={removeLoading} className="btn btn-danger">
                {removeLoading ? 'Removing...' : 'Remove'}
              </button>
            </div>
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
    </DashboardLayout>
  );
}
