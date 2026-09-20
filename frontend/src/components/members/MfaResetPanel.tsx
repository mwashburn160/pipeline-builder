// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { MfaRequiredError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import type { MfaResetRequest } from '@/types';

const STATUS_COLOR: Record<MfaResetRequest['status'], 'yellow' | 'green' | 'red' | 'gray'> = {
  pending: 'yellow',
  approved: 'green',
  denied: 'red',
  expired: 'gray',
};

/**
 * "Pending MFA resets" — the SECOND half of the two-person reset, for the other
 * owners/admins of this organization (and of its teams).
 *
 * A request the viewer filed shows "Withdraw" only: the server refuses an
 * approval by the requester (or by the person being reset), and the panel says
 * so rather than offering a button that can only fail. Approving needs a step-up
 * earned with a passkey or an authenticator code — it removes another person's
 * factors — while denying only removes a pending action, so it needs neither.
 *
 * Recently decided requests follow the pending ones, so an admin can see what
 * happened to a request they filed without opening the audit log.
 */
export function MfaResetPanel({
  orgId,
  currentUserId,
  readOnly,
  refreshKey = 0,
}: {
  orgId: string;
  currentUserId: string | undefined;
  readOnly: boolean;
  /** Bump to re-read after a request is filed elsewhere on the page. */
  refreshKey?: number;
}) {
  const toast = useToast();
  const read = useFetch(
    async (signal): Promise<MfaResetRequest[]> => (await api.listMfaResets(orgId, { signal })).data?.requests ?? [],
    [orgId, refreshKey],
  );
  const [approving, setApproving] = useState<MfaResetRequest | null>(null);
  const [denying, setDenying] = useState<MfaResetRequest | null>(null);
  const [busy, setBusy] = useState(false);
  // Text for the always-mounted live region in the card. A decision removes the
  // row it was made on, so without this the only feedback a screen-reader user
  // gets is a list that silently got shorter.
  const [announcement, setAnnouncement] = useState('');

  const requests = read.data ?? [];
  const pending = requests.filter((r) => r.status === 'pending');
  const recent = requests.filter((r) => r.status !== 'pending').slice(0, 5);

  // Hidden until there is something to show (and while the first read is in
  // flight) — most organizations never have a reset request.
  if (!read.error && requests.length === 0) return null;

  const approve = async (request: MfaResetRequest, stepUpToken: string) => {
    setApproving(null);
    setBusy(true);
    try {
      const res = await api.approveMfaReset(orgId, request.id, {}, stepUpToken);
      const message = res.success
        ? (res.message || `Two-factor authentication reset for ${request.targetEmail}`)
        : (res.message || 'Could not approve the reset');
      (res.success ? toast.success : toast.error)(message);
      setAnnouncement(message);
    } catch (err) {
      // The shell's dialog already explains a single-factor session.
      if (!(err instanceof MfaRequiredError)) {
        const message = formatError(err, 'Could not approve the reset');
        toast.error(message);
        setAnnouncement(message);
      }
    } finally {
      setBusy(false);
      read.refetch();
    }
  };

  const deny = async (request: MfaResetRequest) => {
    setBusy(true);
    try {
      const res = await api.denyMfaReset(orgId, request.id);
      const message = res.success ? (res.message || 'Request closed') : (res.message || 'Could not close the request');
      (res.success ? toast.success : toast.error)(message);
      setAnnouncement(message);
    } catch (err) {
      const message = formatError(err, 'Could not close the request');
      toast.error(message);
      setAnnouncement(message);
    } finally {
      // The dialog stays up, showing its in-flight state, until the call
      // settles — closing on the click left Deny looking like it did nothing.
      setDenying(null);
      setBusy(false);
      read.refetch();
    }
  };

  return (
    <SectionCard
      icon={KeyRound}
      title="Pending two-factor resets"
      description="A reset removes a member's passkeys, authenticator app and recovery codes. It needs a second owner or admin to approve it."
    >
      {/* Always mounted and initially empty: a live region inserted together
          with its text is not announced. */}
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {read.error && !read.data ? (
        <RetryError message={formatError(read.error, 'Could not load reset requests')} onRetry={read.refetch} />
      ) : (
        <div className="space-y-4">
          {pending.length === 0 && <p className="text-sm text-fg-muted">Nothing waiting for approval.</p>}
          <ul className="space-y-3">
            {pending.map((r) => {
              const mine = r.requestedBy === currentUserId;
              const aboutMe = r.targetUserId === currentUserId;
              return (
                <li key={r.id} className="rounded-xl border border-default p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <p>
                        <strong>{r.targetEmail}</strong>{' '}
                        <span className="text-fg-muted">
                          — requested by {mine ? 'you' : r.requestedByEmail} <RelativeTime value={r.createdAt} />, expires{' '}
                          <RelativeTime value={r.expiresAt} />
                        </span>
                      </p>
                      <p className="text-fg-muted">&ldquo;{r.reason}&rdquo;</p>
                      {(mine || aboutMe) && (
                        <p className="text-xs text-fg-muted">
                          {mine ? 'You filed this, so a different admin has to approve it.' : 'This request is about you, so someone else has to decide it.'}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {!mine && !aboutMe && (
                        <Button size="xs" readOnly={readOnly} disabled={busy} onClick={() => setApproving(r)}>
                          Approve
                        </Button>
                      )}
                      {!aboutMe && (
                        <Button size="xs" variant="secondary" readOnly={readOnly} disabled={busy} onClick={() => setDenying(r)}>
                          {mine ? 'Withdraw' : 'Deny'}
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {recent.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Recently decided</p>
              <ul className="space-y-1 text-sm">
                {recent.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <Badge color={STATUS_COLOR[r.status]}>{r.status}</Badge>
                    <span>{r.targetEmail}</span>
                    {r.decidedByEmail && <span className="text-fg-muted">by {r.decidedByEmail}</span>}
                    {r.decidedAt && <RelativeTime value={r.decidedAt} />}
                    {r.result && (
                      <span className="text-xs text-fg-muted">
                        (enrolment grace until {new Date(r.result.graceUntil).toLocaleString()})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {approving && (
        <StepUpModal
          title="Approve this two-factor reset?"
          action={`Reset two-factor authentication for ${approving.targetEmail}`}
          requireStrongFactor
          details={(
            <p>
              Their passkeys, authenticator app and recovery codes are removed and every session of theirs
              ends. They get 72 hours to sign in with their password and set up a new factor. Requested by{' '}
              {approving.requestedByEmail}: &ldquo;{approving.reason}&rdquo;
            </p>
          )}
          onConfirmed={(token) => approve(approving, token)}
          onClose={() => setApproving(null)}
        />
      )}
      {denying && (
        <ConfirmDialog
          title={denying.requestedBy === currentUserId ? 'Withdraw this request?' : 'Deny this request?'}
          confirmLabel={denying.requestedBy === currentUserId ? 'Withdraw' : 'Deny'}
          loading={busy}
          onConfirm={() => deny(denying)}
          onCancel={() => setDenying(null)}
        >
          Nothing about <strong>{denying.targetEmail}</strong>&apos;s account changes.
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}
