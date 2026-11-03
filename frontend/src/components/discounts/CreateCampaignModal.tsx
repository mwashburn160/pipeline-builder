// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useId } from 'react';
import { useFormState } from '@/hooks/useFormState';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import api from '@/lib/api';

interface CreateCampaignModalProps {
  onClose: () => void;
  onCreated: () => void;
}

/** Slug rule, mirroring the server's: letters, digits, `-`, `_`. */
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Create a campaign — the identity a set of discount codes (and promotions)
 * belongs to, carrying the one budget, window and one-per-account rule that
 * apply across the whole set.
 *
 * The slug is the campaign's id and is lower-cased by the server, so it is shown
 * normalized as the operator types: the id goes into every code that references
 * the campaign and into every ledger row, and `SUMMER26` silently becoming
 * `summer26` after the fact is the kind of surprise that makes someone think the
 * save failed.
 */
export function CreateCampaignModal({ onClose, onCreated }: CreateCampaignModalProps) {
  const uid = useId();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [exclusive, setExclusive] = useState(false);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const form = useFormState();

  const slug = id.trim().toLowerCase();

  const handleCreate = async () => {
    if (!slug || !name.trim()) return;
    if (!SLUG.test(slug)) {
      form.setError('The campaign id may contain only letters, digits, - or _ (max 64).');
      return;
    }
    // Dollars in the field, cents on the wire — the whole budget surface is cents.
    const dollars = budget.trim() ? Number(budget.trim()) : undefined;
    if (dollars !== undefined && (!Number.isFinite(dollars) || dollars <= 0)) {
      form.setError('Budget must be a positive amount (leave blank for unlimited).');
      return;
    }
    if (startsAt && endsAt && new Date(startsAt).getTime() > new Date(endsAt).getTime()) {
      form.setError('The start date must be before the end date.');
      return;
    }
    await form.run(() => api.createCampaign({
      id: slug,
      name: name.trim(),
      ...(dollars !== undefined && { budgetCents: Math.round(dollars * 100) }),
      ...(exclusive && { exclusive: true }),
      ...(startsAt.trim() && { startsAt: new Date(startsAt.trim()).toISOString() }),
      ...(endsAt.trim() && { endsAt: new Date(endsAt.trim()).toISOString() }),
    }), { onSuccess: () => onCreated() });
  };

  return (
    <Modal
      title="Create campaign"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleCreate}
          confirmLabel="Create Campaign"
          loading={form.loading}
          confirmDisabled={!slug || !name.trim()}
        />
      }
    >
      <div className="space-y-4">
        {form.error && <ErrorAlert message={form.error} />}
        <p className="text-sm text-fg-muted">
          A campaign groups discount codes (and promotions) under one budget, one
          redemption window and — optionally — one redemption per account across
          the whole set. Codes reference it by id.
        </p>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-name`}>Name</label>
          <Input id={`${uid}-name`} type="text" placeholder="Summer 2026" value={name}
            onChange={(e) => setName(e.target.value)} className="text-sm" disabled={form.loading} />
        </div>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-id`}>Campaign id</label>
          <Input id={`${uid}-id`} type="text" placeholder="summer-2026" value={id}
            onChange={(e) => setId(e.target.value)} className="text-sm font-mono" disabled={form.loading} />
          <p className="text-xs text-fg-subtle">
            {slug && slug !== id.trim()
              ? <>Stored as <code className="font-mono">{slug}</code> — campaign ids are lower-cased.</>
              : 'Lower-cased, and permanent: codes and ledger rows reference it.'}
          </p>
        </div>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-budget`}>
            Budget <span className="text-fg-subtle">(optional)</span>
          </label>
          <Input id={`${uid}-budget`} type="number" min="0" step="0.01" placeholder="Unlimited"
            value={budget} onChange={(e) => setBudget(e.target.value)} className="text-sm" disabled={form.loading} />
          <p className="text-xs text-fg-subtle">
            Total dollars every code in this campaign may give away, together.
            Committed as codes are redeemed, so concurrent redemptions cannot
            overshoot it. Blank = unlimited.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-starts`}>
              Starts <span className="text-fg-subtle">(optional)</span>
            </label>
            <Input id={`${uid}-starts`} type="date" value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)} className="text-sm" disabled={form.loading} />
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-ends`}>
              Ends <span className="text-fg-subtle">(optional)</span>
            </label>
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
          <div>
            <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-exclusive`}>
              One redemption per account
            </label>
            <p className="text-xs text-fg-subtle">
              An account that redeems any code in this campaign is refused the
              rest. Set on the campaign, so it covers every code and does not
              depend on which one is redeemed first.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
