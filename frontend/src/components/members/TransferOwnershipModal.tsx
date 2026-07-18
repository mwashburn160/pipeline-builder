// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import type { OrganizationMember } from '@/types';

interface TransferOwnershipModalProps {
  target: OrganizationMember | null;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Transfer ownership — confirm step. Click-through mirrors the delete-org flow:
 * confirm here, then a step-up modal before the PATCH runs.
 */
export function TransferOwnershipModal({ target, onConfirm, onClose }: TransferOwnershipModalProps) {
  if (!target) return null;
  return (
    <Modal
      title="Transfer Ownership"
      onClose={onClose}
      maxWidth="max-w-md"
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onConfirm}
          confirmLabel="Transfer ownership"
        />
      }
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Make <strong className="text-gray-900 dark:text-gray-100">{target.username}</strong> the
        owner of this organization?
      </p>
      <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
        You will be demoted to admin and lose owner-only controls. You&apos;ll re-enter your
        password to confirm.
      </p>
    </Modal>
  );
}
