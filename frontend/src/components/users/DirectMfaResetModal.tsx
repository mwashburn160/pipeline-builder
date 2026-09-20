// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { MIN_RESET_REASON } from '@/components/members/RequestMfaResetModal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { FormField } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { MfaRequiredError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';

/**
 * A platform administrator's DIRECT MFA reset — the single-person path, for an
 * organization with no second owner/admin to approve a two-person request (the
 * members page's "Reset MFA…"). Everything else is the same reset: every
 * passkey, the authenticator app and the recovery codes are removed, every
 * session ends, and the person gets a 72-hour enrolment grace.
 *
 * Because no second person approves it, the server asks for more of the one who
 * does: a session opened with a second factor, a step-up earned with one, and a
 * reason — and the audit event records it as a direct reset.
 */
export function DirectMfaResetModal({
  target,
  onClose,
  onDone,
}: {
  target: { id: string; email: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();

  const submit = async (stepUpToken: string) => {
    setConfirming(false);
    try {
      const res = await api.resetUserMfa(target.id, { reason: trimmed }, stepUpToken);
      if (res.success) {
        toast.success(res.message || `Two-factor authentication reset for ${target.email}`);
        onDone();
        onClose();
      } else {
        setError(res.message || 'Could not reset two-factor authentication');
      }
    } catch (err) {
      if (err instanceof MfaRequiredError) { onClose(); return; }
      setError(formatError(err, 'Could not reset two-factor authentication'));
    }
  };

  return (
    <>
      <Modal title={`Reset two-factor authentication for ${target.email}?`} titleIcon={<KeyRound className="h-5 w-5 shrink-0" />} onClose={onClose}>
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            Removes every passkey, the authenticator app and the recovery codes, and signs them out everywhere.
            They then have 72 hours to sign in with their password and set up a new factor.
          </p>
          <Callout variant="warning">
            Prefer the two-person reset on the organization&apos;s Members page whenever the organization has a
            second owner or admin. Use this only when it doesn&apos;t — it is recorded as a direct reset.
          </Callout>
          {error && <Callout variant="danger">{error}</Callout>}
          <FormField label="Reason" hint={`Recorded in the audit log (at least ${MIN_RESET_REASON} characters).`}>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full rounded-lg border border-default bg-surface p-2 text-sm"
              placeholder="e.g. Sole admin of a one-person org; identity confirmed via support ticket #1234"
              aria-label="Reason for the reset"
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="button" variant="danger" disabled={trimmed.length < MIN_RESET_REASON} onClick={() => setConfirming(true)}>
              Reset two-factor
            </Button>
          </div>
        </div>
      </Modal>
      {confirming && (
        <StepUpModal
          title="Reset two-factor authentication?"
          action={`Reset two-factor authentication for ${target.email}`}
          requireStrongFactor
          onConfirmed={submit}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
