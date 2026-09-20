// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { FormField } from '@/components/ui/FormField';
import { Textarea } from '@/components/ui/Textarea';
import { Callout } from '@/components/ui/Callout';

/** Mirrors the server's minimum; the server enforces it regardless. */
export const BREAKGLASS_JUSTIFICATION_MIN = 20;

interface BreakglassModalProps {
  /** Shown so the operator is sure whose account they're about to open. */
  targetLabel: string;
  onContinue: (justification: string) => void;
  onClose: () => void;
}

/**
 * Collects the written justification for EMERGENCY access, and says plainly what
 * using it costs before the operator commits.
 *
 * Break-glass is deliberately expensive rather than blocked: the justification is
 * shown to the organization, every org admin is notified at once, and it may
 * need a second administrator. Saying all of that up front is what keeps it from
 * becoming a routine shortcut around the approval flow.
 */
export function BreakglassModal({ targetLabel, onContinue, onClose }: BreakglassModalProps) {
  const [justification, setJustification] = useState('');
  const trimmed = justification.trim();
  const remaining = BREAKGLASS_JUSTIFICATION_MIN - trimmed.length;

  return (
    <Modal
      title="Emergency access"
      titleIcon={<ShieldAlert className="w-5 h-5 text-danger" />}
      onClose={onClose}
      maxWidth="max-w-lg"
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => onContinue(trimmed)}
          confirmLabel="Continue"
          confirmVariant="danger"
          confirmDisabled={remaining > 0}
        />
      }
    >
      <div className="space-y-4 text-sm">
        <p>
          Emergency access opens a read-only view of <strong>{targetLabel}</strong>&apos;s account
          without waiting for the organization to approve. Use it only when they can&apos;t or
          shouldn&apos;t be asked, such as during an incident.
        </p>

        <Callout variant="warning">
          <ul className="list-disc space-y-1 pl-4">
            <li>Your justification is shown to the organization.</li>
            <li>Every admin of that organization is notified immediately.</li>
            <li>It may require approval from a second platform administrator.</li>
            <li>Your use of emergency access is counted and visible to the organization.</li>
          </ul>
        </Callout>

        <FormField
          label="Justification"
          id="breakglass-justification"
          required
          hint={remaining > 0
            ? `At least ${remaining} more character${remaining === 1 ? '' : 's'}.`
            : 'Be specific. For example, an incident number and what you need to check.'}
        >
          <Textarea
            id="breakglass-justification"
            rows={4}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="INC-1234: customer pipelines failing since 09:10, need to see their dashboard"
          />
        </FormField>
      </div>
    </Modal>
  );
}
