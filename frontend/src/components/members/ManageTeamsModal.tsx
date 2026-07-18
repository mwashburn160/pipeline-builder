// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { ModalFooter } from '@/components/ui/ModalFooter';
import type { OrganizationMember, MemberTeam } from '@/types';

interface ManageTeamsModalProps {
  target: OrganizationMember | null;
  roster: MemberTeam[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  selectedTeamIds: Set<string>;
  onToggleTeam: (teamId: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function ManageTeamsModal({
  target,
  roster,
  loading,
  saving,
  error,
  selectedTeamIds,
  onToggleTeam,
  onSubmit,
  onClose,
}: ManageTeamsModalProps) {
  if (!target) return null;
  return (
    <Modal
      title={`Manage Teams: ${target.username}`}
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSubmit}
          confirmLabel="Save Teams"
          loading={saving}
          confirmDisabled={loading}
        />
      }
    >
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Select which teams <strong>{target.username}</strong> belongs to.
        A member can be on multiple teams; each membership keeps its own role.
      </p>
      {error && <p className="text-sm text-red-600 dark:text-red-400 mb-3 whitespace-pre-line">{error}</p>}
      {loading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading teams…</p>
      ) : roster.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">This organization has no teams yet.</p>
      ) : (
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {roster.map((t) => {
            const isOwner = t.role === 'owner';
            return (
              <label
                key={t.orgId}
                className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm ${isOwner ? 'opacity-60' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer'}`}
                title={isOwner ? 'Owner of this team — transfer ownership to remove' : undefined}
              >
                <input
                  type="checkbox"
                  checked={selectedTeamIds.has(t.orgId)}
                  onChange={() => onToggleTeam(t.orgId)}
                  disabled={saving || isOwner}
                  className="rounded border-gray-300"
                />
                <span className="flex-1 truncate text-gray-900 dark:text-gray-100">{t.orgName}</span>
                {t.isMember && <Badge color={isOwner ? 'purple' : 'gray'}>{t.role}</Badge>}
                {t.isMember && t.isActive === false && <Badge color="red">inactive</Badge>}
              </label>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
