// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';
import { caseStatusLabel, responseTargetLabel } from '@/components/message/MessageList';
import type { SupportCaseSummary } from '@/types';

/**
 * Statuses a TENANT may set, with the wording written from their side.
 *
 * Deliberately not the full set — `awaiting_support` and `resolved` are ours to
 * declare, and the server refuses them for a tenant. Offering them here would
 * produce a control that always fails.
 *
 * "Closed" rather than "resolved" for the tenant's own action is the same
 * distinction: a customer saying "this is sorted" is not us claiming we fixed it.
 */
const TENANT_STATUSES: readonly { value: string; label: string }[] = [
  { value: 'open', label: 'Open — waiting on us' },
  { value: 'awaiting_customer', label: 'Waiting on me' },
  { value: 'closed', label: 'Closed' },
];

/**
 * Statuses a tenant cannot move OUT of.
 *
 * Reopening a closed case is staff only, so once closed the whole control is
 * read-only rather than offering transitions the server refuses. `resolved` is
 * not terminal here: moving `resolved` → `open` is the customer saying "that
 * did not fix it", which is the feedback loop that makes `resolved` a different
 * state from `closed` in the first place.
 */
const TENANT_TERMINAL_STATUSES: readonly string[] = ['closed'];

interface SupportCasePanelProps {
  /** The case for this thread. */
  supportCase: SupportCaseSummary;
  /** Live designated contacts of THIS org — the transfer candidates. */
  contacts: { userId: string }[];
  /** Called after a successful change so the caller can refresh its copy. */
  onChanged?: () => void;
}

/**
 * The tenant's controls on one support case: its status, and who owns it.
 *
 * Shown only for a thread that HAS a case. Support correspondence raised before
 * cases existed has none — deliberately, since backfilling would have put
 * months-old "open" cases into the staff queue — and those threads simply get
 * no panel rather than an empty one.
 */
export function SupportCasePanel({ supportCase, contacts, onChanged }: SupportCasePanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = responseTargetLabel(supportCase.level);
  // Closed is terminal for the tenant: only staff may reopen. Shown as disabled
  // rather than hidden so the status is still legible — and with a line saying
  // who can undo it, since "my control stopped working" is otherwise the only
  // information the customer gets.
  const closedToTenant = TENANT_TERMINAL_STATUSES.includes(supportCase.status);

  /** Run one mutation, surfacing the server's own refusal rather than a generic one. */
  // `message`, not `error`: the API's failure shape has no `error` field, so
  // reading one typechecks and always yields undefined.
  const run = async (fn: () => Promise<{ success: boolean; message?: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      // The server's message is the useful one — it names which statuses a
      // tenant may set, or why a transfer target was rejected. A generic
      // "something went wrong" would hide exactly the part worth reading.
      if (!res.success) setError(res.message ?? 'That change was not applied');
      else onChanged?.();
    } catch {
      setError('That change could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded border border-border bg-surface-muted p-3 text-xs"
      aria-label={`Support case ${supportCase.displayNumber}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <LifeBuoy className="w-3.5 h-3.5 text-fg-muted" aria-hidden="true" />
        <span className="font-semibold">Case #{supportCase.displayNumber}</span>
        <span className="text-fg-muted">{caseStatusLabel(supportCase.status)}</span>
        {/* The commitment belongs next to the case, not only on a pricing page —
            and it comes from the level FROZEN at open, so it stays truthful
            after a downgrade. Omitted entirely for an unrecognised level rather
            than borrowing another level's promise. */}
        {target && <span className="text-fg-muted">· target {target}</span>}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Status</span>
          <Select
            aria-label="Case status"
            value={TENANT_STATUSES.some((s) => s.value === supportCase.status) ? supportCase.status : 'open'}
            disabled={busy || closedToTenant}
            onChange={(e) => run(() => api.setSupportCaseStatus(supportCase.threadId, e.target.value))}
            className="text-xs"
          >
            {TENANT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </label>

        {/* Handover is offered only when there IS somebody to hand to. A picker
            listing just the current owner is a control that cannot do anything. */}
        {contacts.filter((c) => c.userId !== supportCase.tenantContact).length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-fg-muted">Hand over to</span>
            <Select
              aria-label="Hand over to another support contact"
              defaultValue=""
              disabled={busy}
              onChange={(e) => e.target.value && run(() => api.transferSupportCase(supportCase.threadId, e.target.value))}
              className="text-xs"
            >
              <option value="">Choose a contact…</option>
              {contacts
                .filter((c) => c.userId !== supportCase.tenantContact)
                .map((c) => <option key={c.userId} value={c.userId}>{c.userId}</option>)}
            </Select>
          </label>
        )}

        {!closedToTenant && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => run(() => api.setSupportCaseStatus(supportCase.threadId, 'closed'))}
          >
            Close case
          </Button>
        )}
      </div>

      {closedToTenant && (
        <p className="mt-2 text-fg-muted">
          This case is closed. Ask the support team to reopen it, or raise a new case.
        </p>
      )}

      {error && <p className="mt-2 text-danger" role="alert">{error}</p>}
    </section>
  );
}
