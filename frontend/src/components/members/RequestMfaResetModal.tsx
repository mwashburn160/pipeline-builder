// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { FormField } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { MfaRequiredError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import type { OrganizationMember } from '@/types';

/** Shortest reason the server accepts — enough to say what happened. */
export const MIN_RESET_REASON = 10;

/**
 * "Reset MFA…" on a member row — the FIRST half of the two-person reset.
 *
 * Filing the request changes nothing yet: ANOTHER owner/admin of this
 * organization (or of a parent organization), or a platform administrator, has
 * to approve it within 24 hours. Only then are the member's passkeys,
 * authenticator app and recovery codes removed, every session of theirs ended,
 * and a short enrolment grace granted so they can sign in and set up a new
 * factor — without the organization's two-factor policy changing for anyone
 * else.
 *
 * The server demands a session opened with a second factor plus a step-up; a
 * single-factor session is answered with 401 `MFA_REQUIRED`, which the shell
 * turns into the enrol / sign-in-again dialog, so it is not repeated here.
 */
export function RequestMfaResetModal({
  orgId,
  member,
  onClose,
  onRequested,
}: {
  orgId: string;
  member: OrganizationMember;
  onClose: () => void;
  onRequested: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();

  const submit = async (stepUpToken: string) => {
    setConfirming(false);
    try {
      const res = await api.requestMfaReset(orgId, { userId: member.id, reason: trimmed }, stepUpToken);
      if (res.success) {
        toast.success(res.message || 'Reset requested — another admin must approve it');
        onRequested();
        onClose();
      } else {
        setError(res.message || 'Could not request the reset');
      }
    } catch (err) {
      if (err instanceof MfaRequiredError) { onClose(); return; }
      setError(formatError(err, 'Could not request the reset'));
    }
  };

  return (
    <>
      <Modal title={`Reset two-factor authentication for ${member.username}?`} titleIcon={<KeyRound className="h-5 w-5 shrink-0" />} onClose={onClose}>
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            Use this when <strong>{member.email}</strong> has lost every passkey, their authenticator app and
            their recovery codes. Nothing happens until <strong>another</strong> owner or admin approves the
            request (within 24 hours). Approval removes all of their second factors and signs them out
            everywhere; they then have a few days to sign in with their password and set up a new one. Your
            organization&apos;s two-factor policy does not change for anyone else.
          </p>
          <Callout variant="warning">
            Confirm who is asking first — through a channel you already trust. Resetting a factor for
            someone impersonating a colleague hands them the account.
          </Callout>
          {error && <Callout variant="danger">{error}</Callout>}
          <FormField label="Reason" hint={`Recorded in the audit log and shown to the approver (at least ${MIN_RESET_REASON} characters).`}>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
              className="w-full rounded-lg border border-default bg-surface p-2 text-sm"
              placeholder="e.g. Phone stolen on 18 Sep; identity confirmed on a video call"
              aria-label="Reason for the reset"
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="button" disabled={trimmed.length < MIN_RESET_REASON} onClick={() => setConfirming(true)}>
              Request reset
            </Button>
          </div>
        </div>
      </Modal>
      {confirming && (
        <StepUpModal
          title="Request a two-factor reset?"
          action={`Request a two-factor reset for ${member.username}`}
          details={<p>Another admin will be asked to approve it.</p>}
          onConfirmed={submit}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
