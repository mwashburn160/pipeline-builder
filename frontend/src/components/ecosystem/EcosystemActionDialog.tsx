// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId, useState, type ReactNode } from 'react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Textarea } from '@/components/ui/Textarea';
import { formatError } from '@/lib/constants';

interface EcosystemActionDialogProps {
  title: string;
  /** Short statement of the action ("Suspend publisher acme"). */
  action: string;
  /** What the action does / costs. */
  details?: ReactNode;
  /** Label of the free-text field; omit for an action that takes none. */
  reasonLabel?: string;
  reasonRequired?: boolean;
  reasonHint?: string;
  initialReason?: string;
  /** The route is step-up gated: the step-up dialog IS the confirmation. */
  stepUp: boolean;
  confirmLabel?: string;
  tone?: 'primary' | 'danger';
  /** Throws to keep the dialog open with the error shown. */
  onSubmit: (reason: string, stepUpToken?: string) => Promise<void>;
  onClose: () => void;
}

/**
 * One dialog per ecosystem action: the reason (when the action takes one) and
 * the confirmation in the same place.
 *
 * For a step-up-gated route it renders `StepUpModal` with the reason field in
 * its `details` — that dialog is the confirmation too (the one-dialog rule, see
 * `StepUpModal`). Otherwise a plain modal with a confirm button.
 */
export function EcosystemActionDialog({
  title, action, details, reasonLabel, reasonRequired = false, reasonHint, initialReason = '',
  stepUp, confirmLabel = 'Confirm', tone = 'primary', onSubmit, onClose,
}: EcosystemActionDialogProps) {
  const [reason, setReason] = useState(initialReason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const missingReason = reasonRequired && !reason.trim();

  const reasonField = reasonLabel ? (
    <FormField label={reasonLabel} id={fieldId} hint={reasonHint} required={reasonRequired}>
      <Textarea id={fieldId} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
    </FormField>
  ) : null;

  if (stepUp) {
    return (
      <StepUpModal
        title={title}
        action={action}
        details={<>{details}{reasonField}</>}
        onConfirmed={async (token) => {
          if (missingReason) throw new Error(`Enter ${reasonLabel?.toLowerCase() ?? 'a reason'} first.`);
          await onSubmit(reason.trim(), token);
        }}
        onClose={onClose}
      />
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      onClose();
    } catch (err) {
      setError(formatError(err, 'The action failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={() => { if (!busy) onClose(); }}
      maxWidth="max-w-lg"
      footer={(
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => void submit()}
          confirmLabel={confirmLabel}
          confirmVariant={tone === 'danger' ? 'danger' : 'primary'}
          loading={busy}
          confirmDisabled={missingReason}
        />
      )}
    >
      <div className="space-y-3 text-sm">
        <p className="text-fg-muted">{action}</p>
        {details && <div className="space-y-2 text-fg-muted">{details}</div>}
        {reasonField}
        <ErrorAlert message={error} onDismiss={() => setError(null)} />
      </div>
    </Modal>
  );
}
