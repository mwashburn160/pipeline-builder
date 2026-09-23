// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { Armchair } from 'lucide-react';
import api from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useFormState } from '@/hooks/useFormState';
import type { OrganizationDetail } from '@/lib/api/domains/organizations';

/**
 * Pooled account seat usage plus the sysadmin seat-limit override.
 *
 * `seats` is platform-owned (not a quota type); -1 = unlimited. The PUT is
 * sysadmin/service only with no step-up (it is billing's entitlement sync, so a
 * human MFA gate would block the sync), hence no StepUpModal here.
 *
 * Seats POOL AT THE ROOT. When the org on screen is a team, the numbers (and
 * the write) belong to its parent's account, so this card sends the operator
 * there instead of offering an editor that silently retargets — and the
 * hierarchy is read off the org being viewed, never off the acting sysadmin's
 * own org or inferred from an empty read.
 */
export function OrgSeatsCard({
  org,
  seatUsage,
  onChanged,
}: {
  /** The org being viewed (NOT the viewer's own) — its `parentOrgId` decides
   *  whether this account's seats live here or at the parent. */
  org: OrganizationDetail;
  /** Null when the seat read failed (fail-soft). */
  seatUsage: { limit: number; used: number } | null;
  onChanged: () => void;
}) {
  const orgId = org.id;
  const isTeam = !!org.parentOrgId;
  const form = useFormState();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [unlimited, setUnlimited] = useState(false);

  const openEditor = () => {
    const current = seatUsage?.limit ?? 0;
    setUnlimited(current === -1);
    setInput(current === -1 ? '' : String(current));
    form.reset();
    setOpen(true);
  };

  const save = async () => {
    let seats = -1;
    if (!unlimited) {
      const n = Number(input);
      if (!Number.isInteger(n) || n < 0) {
        form.setError('Enter a whole number of seats (0 or more), or check Unlimited.');
        return;
      }
      seats = n;
    }
    await form.run(() => api.setOrganizationSeatLimit(orgId, seats), {
      onSuccess: () => {
        setOpen(false);
        onChanged();
      },
    });
  };

  return (
    <Card>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Armchair className="w-5 h-5 text-fg-muted" />
          <h3 className="text-base font-semibold text-fg">Seats</h3>
        </div>
        {!isTeam && (
          <button type="button" onClick={openEditor} className="action-link text-sm">Set limit</button>
        )}
      </div>
      {seatUsage ? (
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between">
            <dt className="text-fg-muted">Used</dt>
            <dd className="font-mono text-xs">
              {seatUsage.used} / {seatUsage.limit === -1 ? '∞' : seatUsage.limit}
            </dd>
          </div>
          <p className="text-xs text-fg-muted pt-1">
            Pooled across the whole account (active members + pending invites).
            {seatUsage.limit === -1 ? ' Seats are unlimited.' : ''}
          </p>
        </dl>
      ) : (
        <p className="text-sm text-fg-muted">
          Seat usage unavailable — the seat service didn&apos;t respond.
        </p>
      )}
      {isTeam && (
        <p className="text-xs text-fg-muted pt-2">
          This is a team: its seats are its account&apos;s, and the cap is set on{' '}
          <Link href={`/dashboard/admin/orgs/${org.parentOrgId}`} className="action-link">
            {org.parentOrgName ?? 'the parent organization'}
          </Link>.
        </p>
      )}

      {open && (
        <Modal
          title="Set seat limit"
          onClose={() => setOpen(false)}
          maxWidth="max-w-md"
          footer={<ModalFooter onCancel={() => setOpen(false)} onConfirm={save} confirmLabel="Save" loading={form.loading} />}
        >
          <div className="space-y-4">
            <ErrorAlert message={form.error} />
            <p className="text-sm text-fg-muted">
              Sets the pooled seat cap for the whole account (applied to the root org).
              Seats count active members plus pending invites across every team.
            </p>
            <div>
              <label htmlFor="seat-limit" className="label">Seats</label>
              <Input
                id="seat-limit"
                type="number"
                min={0}
                step={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={form.loading || unlimited}
                placeholder="e.g. 25"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              <Checkbox checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} disabled={form.loading} />
              Unlimited seats
            </label>
          </div>
        </Modal>
      )}
    </Card>
  );
}
