// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useId } from 'react';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { RetryError } from '@/components/ui/RetryError';
import { WarningAlert } from '@/components/ui/WarningAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { Campaign } from '@/types';

interface EditCampaignModalProps {
  campaign: Campaign;
  onClose: () => void;
  /** Called after an edit was saved. */
  onSaved: () => void;
}

/** Cents → `$1,234.56`. */
function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** ISO instant → the `YYYY-MM-DD` an `<input type="date">` holds. */
const dateField = (iso?: string) => (iso ? iso.slice(0, 10) : '');

/**
 * Inspect and edit one campaign.
 *
 * The top half is the server's detail read: how many codes the campaign holds
 * (and how many are still live), and spend AS THE LEDGER HAS IT next to the
 * cached `spentCents` the list shows. The two are shown side by side on purpose
 * — the ledger is the authority, and a drift between them is the signal that a
 * budget release failed somewhere, so it is called out rather than averaged
 * away.
 *
 * The bottom half edits name, budget, window and the one-per-account rule in
 * place, so changing a budget no longer means ending the campaign (which
 * deactivates every code) and minting a new one. Only changed fields are sent.
 * The server refuses a budget below what is already committed; that refusal is
 * shown in its own words. Ending stays on the list's End action, because it
 * also deactivates the codes.
 */
export function EditCampaignModal({ campaign, onClose, onSaved }: EditCampaignModalProps) {
  const uid = useId();
  const detail = useFetch(async (signal) => {
    const res = await api.getCampaign(campaign.id, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Could not load the campaign');
    return res.data;
  }, [campaign.id]);

  const [name, setName] = useState(campaign.name);
  const [budget, setBudget] = useState(campaign.budgetCents != null ? String(campaign.budgetCents / 100) : '');
  const [exclusive, setExclusive] = useState(!!campaign.exclusive);
  const [startsAt, setStartsAt] = useState(dateField(campaign.startsAt));
  const [endsAt, setEndsAt] = useState(dateField(campaign.endsAt));
  const form = useFormState();

  const handleSave = async () => {
    // `null` clears a field on the server: an emptied budget box makes the
    // campaign unlimited, an emptied date opens that side of the window.
    const body: { name?: string; budgetCents?: number | null; exclusive?: boolean; startsAt?: string | null; endsAt?: string | null } = {};
    if (name.trim() && name.trim() !== campaign.name) body.name = name.trim();

    const dollars = budget.trim() ? Number(budget.trim()) : undefined;
    if (dollars !== undefined && (!Number.isFinite(dollars) || dollars <= 0)) {
      form.setError('Budget must be a positive amount.');
      return;
    }
    const cents = dollars !== undefined ? Math.round(dollars * 100) : undefined;
    if (cents === undefined && campaign.budgetCents != null) body.budgetCents = null;
    else if (cents !== undefined && cents !== campaign.budgetCents) body.budgetCents = cents;

    if (exclusive !== !!campaign.exclusive) body.exclusive = exclusive;
    if (startsAt && endsAt && new Date(startsAt).getTime() > new Date(endsAt).getTime()) {
      form.setError('The start date must be before the end date.');
      return;
    }
    if (!startsAt && campaign.startsAt) body.startsAt = null;
    else if (startsAt && startsAt !== dateField(campaign.startsAt)) body.startsAt = new Date(startsAt).toISOString();
    if (!endsAt && campaign.endsAt) body.endsAt = null;
    else if (endsAt && endsAt !== dateField(campaign.endsAt)) body.endsAt = new Date(endsAt).toISOString();

    if (Object.keys(body).length === 0) { onClose(); return; }
    await form.run(async () => {
      const res = await api.updateCampaign(campaign.id, body);
      if (!res.success) throw new Error(res.message || 'Could not save the campaign');
    }, { onSuccess: () => onSaved() });
  };

  const d = detail.data;
  const drift = d ? d.ledgerSpend.cents - d.campaign.spentCents : 0;

  return (
    <Modal
      title={`Campaign · ${campaign.name}`}
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleSave}
          confirmLabel="Save changes"
          loading={form.loading}
          confirmDisabled={!name.trim()}
        />
      }
    >
      <div className="space-y-4">
        {form.error && <ErrorAlert message={form.error} />}

        <section aria-label="Campaign detail" className="rounded-md border border-default p-3 text-sm">
          <code className="text-xs text-fg-subtle font-mono">{campaign.id}</code>
          {detail.error ? (
            <RetryError message={formatError(detail.error, 'Could not load the campaign')} onRetry={detail.refetch} />
          ) : !d ? (
            <div className="flex items-center gap-2 py-2 text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>
          ) : (
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
              <dt className="text-fg-muted">Codes</dt>
              <dd className="tabular-nums" data-testid="campaign-codes">{d.codes.active} live of {d.codes.total}</dd>
              <dt className="text-fg-muted">Spend (ledger)</dt>
              <dd className="tabular-nums" data-testid="campaign-ledger-spend">
                {money(d.ledgerSpend.cents)} · {d.ledgerSpend.grants} {d.ledgerSpend.grants === 1 ? 'grant' : 'grants'}
              </dd>
              <dt className="text-fg-muted">Spend (cached)</dt>
              <dd className="tabular-nums">{money(d.campaign.spentCents)}</dd>
            </dl>
          )}
          {d && drift !== 0 && (
            <WarningAlert
              className="mt-2"
              message={`The cached spend is ${money(Math.abs(drift))} ${drift > 0 ? 'below' : 'above'} the ledger. The ledger is the authority — a drift means a budget commit or release did not land.`}
            />
          )}
        </section>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-name`}>Name</label>
          <Input id={`${uid}-name`} type="text" value={name}
            onChange={(e) => setName(e.target.value)} className="text-sm" disabled={form.loading} />
        </div>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-budget`}>Budget</label>
          <Input id={`${uid}-budget`} type="number" min="0" step="0.01" placeholder="Unlimited"
            value={budget} onChange={(e) => setBudget(e.target.value)} className="text-sm" disabled={form.loading} />
          <p className="text-xs text-fg-subtle">
            Dollars across every code in the campaign. It cannot go below what is already committed.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-starts`}>Starts</label>
            <Input id={`${uid}-starts`} type="date" value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)} className="text-sm" disabled={form.loading} />
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-ends`}>Ends</label>
            <Input id={`${uid}-ends`} type="date" value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)} className="text-sm" disabled={form.loading} />
          </div>
        </div>

        <div className="flex gap-2">
          <Checkbox
            id={`${uid}-exclusive`}
            checked={exclusive}
            onChange={(e) => setExclusive(e.target.checked)}
            disabled={form.loading}
            className="mt-0.5"
          />
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-exclusive`}>
            One redemption per account
          </label>
        </div>
      </div>
    </Modal>
  );
}
