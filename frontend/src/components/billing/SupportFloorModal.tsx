// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Handshake } from 'lucide-react';
import api from '@/lib/api';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { useMutation } from '@/hooks/useMutation';
import { MfaRequiredError } from '@/lib/api/errors';
import type { SupportFloorUpdate } from '@/lib/api/domains/billing';
import { formatError } from '@/lib/constants';
import { formatCents } from '@/lib/format';
import type { Subscription } from '@/types';

/** What the route keeps of a note. */
const NOTE_MAX = 500;
/** The route's ceilings (api/billing admin-subscriptions MAX_NEGOTIATED_FLOOR_SEATS / _CENTS),
 *  checked here so an out-of-range value never spends a step-up on a certain 400. */
const MAX_SEATS = 10_000_000;
const MAX_FLOOR_CENTS = 1_000_000_000;

interface Props {
  subscription: Subscription;
  onClose: () => void;
  /** After a set or clear landed. */
  onSaved: () => void;
}

/**
 * A subscription's NEGOTIATED support floor, replacing the computed ramp:
 * the monthly price agreed and the seat count it was agreed AT (an account
 * that grows past it is reported stale rather than silently under-billed).
 * Clear drops the agreement and returns the account to the ramp.
 *
 * System org + `subscriptions:manage` + step-up; the billing admin page offers
 * it only to a holder. The admin subscription read carries the agreement on
 * file (`supportFloorOverride`), which the form shows and starts from; a save
 * replaces it.
 */
export function SupportFloorModal({ subscription, onClose, onSaved }: Props) {
  const toast = useToast();
  const current = subscription.supportFloorOverride ?? null;
  const [seats, setSeats] = useState(current ? String(current.seats) : '');
  const [floor, setFloor] = useState(current ? (current.floorCents / 100).toFixed(2) : '');
  const [note, setNote] = useState(current?.note ?? '');
  const [seatsError, setSeatsError] = useState<string | null>(null);
  const [floorError, setFloorError] = useState<string | null>(null);
  const [pending, setPending] = useState<SupportFloorUpdate | null>(null);
  const currency = subscription.currency || 'usd';

  const save = useMutation({
    fn: async (body: SupportFloorUpdate, stepUpToken: string) => {
      const res = await api.setSupportFloor(subscription.id, body, stepUpToken);
      if (!res.success) throw new Error(res.message || 'The support floor change was refused');
      return res.data?.supportFloorOverride ?? null;
    },
    scopeKey: subscription.id,
    formatError: (e) => (e instanceof MfaRequiredError ? '' : formatError(e, 'Could not change the support floor')),
    onSuccess: (agreement) => {
      toast.success(agreement
        ? `Support floor set to ${formatCents(agreement.floorCents, currency)} a month, agreed at ${agreement.seats.toLocaleString('en-US')} seats`
        : 'Support floor cleared. The account is back on the computed ramp.');
      onSaved();
      onClose();
    },
  });

  const submit = () => {
    save.reset();
    const s = seats.trim() === '' ? NaN : Number(seats);
    const f = floor.trim() === '' ? NaN : Number(floor);
    const badSeats = !Number.isInteger(s) || s < 0 || s > MAX_SEATS;
    const badFloor = !Number.isFinite(f) || f < 0 || Math.round(f * 100) > MAX_FLOOR_CENTS;
    setSeatsError(badSeats ? `Enter the seat count this price was agreed at (a whole number from 0 to ${MAX_SEATS.toLocaleString('en-US')}).` : null);
    setFloorError(badFloor ? `Enter a monthly floor of 0 or more, up to ${formatCents(MAX_FLOOR_CENTS, currency)}.` : null);
    if (badSeats || badFloor) return;
    const trimmed = note.trim();
    setPending({ seats: s, floorCents: Math.round(f * 100), ...(trimmed ? { note: trimmed } : {}) });
  };

  const clear = () => {
    save.reset();
    setPending({ floorCents: null });
  };

  const clearing = pending?.floorCents === null;

  return (
    <>
      {!pending && (
        <Modal
          title="Support floor"
          titleIcon={<Handshake className="w-5 h-5 shrink-0" />}
          onClose={onClose}
          footer={(
            <div className="flex items-center justify-between gap-2">
              <Button variant="danger-outline" onClick={clear} disabled={save.pending || !current}
                title={current ? undefined : 'No agreement on file to clear'}>
                Clear floor
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={onClose} disabled={save.pending}>Cancel</Button>
                <Button onClick={submit} loading={save.pending}>Save floor</Button>
              </div>
            </div>
          )}
        >
          <p className="text-sm text-fg-muted mb-4">
            A negotiated support floor for <span className="font-mono text-xs text-fg-muted">{subscription.orgId}</span>,
            replacing the computed ramp. Saving replaces any agreement on file; Clear returns the account to the ramp.
          </p>
          <div className="mb-4 rounded-lg bg-surface-muted px-3 py-2 text-sm">
            {current ? (
              <>
                <span className="font-medium text-fg">Current agreement:</span>{' '}
                <span className="text-fg-muted">
                  {formatCents(current.floorCents, currency)} a month at {current.seats.toLocaleString('en-US')} seats,
                  set <RelativeTime value={current.agreedAt} /> by <span className="font-mono text-xs">{current.agreedBy}</span>
                  {current.note ? <> · {current.note}</> : null}
                </span>
              </>
            ) : (
              <span className="text-fg-muted">No agreement on file. The account is on the computed ramp.</span>
            )}
          </div>
          <ErrorAlert message={save.error} onDismiss={save.reset} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Agreed seats" error={seatsError ?? undefined} hint="The seat count this price was agreed at">
              <Input type="number" min={0} step={1} inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} />
            </FormField>
            <FormField label={`Monthly floor (${currency.toUpperCase()})`} error={floorError ?? undefined}>
              <Input type="number" min={0} step="0.01" inputMode="decimal" value={floor} onChange={(e) => setFloor(e.target.value)} />
            </FormField>
          </div>
          <div className="mt-3">
            <FormField label="Note (optional, kept with the agreement)">
              <Input value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder="Contract or order reference" />
            </FormField>
          </div>
        </Modal>
      )}

      {pending && (
        <StepUpModal
          title={clearing ? 'Clear the support floor?' : 'Set the support floor?'}
          action={clearing
            ? `Clear the negotiated support floor for ${subscription.orgId}`
            : `Set the support floor for ${subscription.orgId} to ${formatCents((pending as { floorCents: number }).floorCents, currency)} a month at ${(pending as { seats: number }).seats.toLocaleString('en-US')} seats`}
          details={<p>This sets what the account pays for support.</p>}
          onConfirmed={async (stepUpToken) => { await save.run(pending, stepUpToken); }}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}
