// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Send } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import type { DeliveryOutcome, ReportRun } from '@/lib/api/domains/stakeholder-reports';

/**
 * How long a `delivering` record is trusted before the attempt is presumed dead.
 * Mirrors api/reporting `DELIVERY_STALE_MS` — the server refuses a redeliver of
 * a younger in-flight attempt with 409, so offering the button earlier would only
 * produce that refusal.
 */
export const DELIVERY_STALE_MS = 15 * 60 * 1000;

/** Mirrors api/reporting `deliveryIncomplete`: did this delivery leave anyone or any channel out? */
export function deliveryIncomplete(d: DeliveryOutcome): boolean {
  return d.state === 'failed'
    || d.inApp === 0
    || d.relayFailed
    || d.email.failed > 0
    || d.destinations.failed > 0;
}

/**
 * Whether "Redeliver" can succeed for this run — the same three conditions the
 * route checks before it answers 202: the run is the current published version,
 * no attempt is still in flight, and the last attempt missed someone (or no
 * delivery was ever recorded).
 */
export function canRedeliver(run: ReportRun, now: number = Date.now()): boolean {
  if (run.status !== 'published' || run.supersededBy) return false;
  const d = run.delivery;
  if (!d) return true;
  if (d.state === 'delivering') return now - Date.parse(d.attemptedAt) >= DELIVERY_STALE_MS;
  return deliveryIncomplete(d);
}

/** "Delivered to N · M failed · K skipped" — recipients plus destinations, in one line. */
export function deliverySummary(d: DeliveryOutcome): string {
  const reached = d.email.sent + d.destinations.delivered;
  const failed = d.email.failed + d.destinations.failed;
  const parts = [`Delivered to ${reached}`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (d.email.skipped > 0) parts.push(`${d.email.skipped} skipped`);
  return parts.join(' · ');
}

/**
 * The published run's delivery line, its notes, and Redeliver.
 *
 * Shown only on a published run: before publishing nothing has been sent, and
 * the server records no delivery. Redeliver resends the SAME run to whoever the
 * record says does not have it yet — no correction, nobody gets it twice.
 */
export function DeliveryStatus({ run, canShare, readOnly = false, onChanged }: {
  run: ReportRun;
  /** `reports:publish` — the redeliver route's permission. */
  canShare: boolean;
  readOnly?: boolean;
  onChanged: () => void;
}) {
  const redeliver = useFormState();
  if (run.status !== 'published') return null;
  const d = run.delivery;

  const doRedeliver = async () => {
    await redeliver.run(
      async () => { await api.redeliverReportRun(run.id); },
      { successMessage: 'Redelivery started — the result appears here when it finishes.', onSuccess: onChanged },
    );
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Send className="w-4 h-4 text-fg-subtle" aria-hidden="true" />
          <span className="font-medium text-fg">Delivery</span>
          {!d ? (
            <span className="text-fg-muted" data-testid="delivery-line">No delivery has been recorded for this run.</span>
          ) : (
            <>
              {d.state === 'delivering'
                ? <Badge color="blue">Delivering</Badge>
                : d.state === 'failed'
                  ? <Badge color="red">Failed</Badge>
                  : <Badge color={deliveryIncomplete(d) ? 'yellow' : 'green'}>Delivered</Badge>}
              <span className="text-fg-muted" data-testid="delivery-line">
                {deliverySummary(d)}
                {d.attempts > 1 && ` · attempt ${d.attempts}`}
                {' · '}{new Date(d.attemptedAt).toLocaleString()}
              </span>
            </>
          )}
        </div>
        {canShare && canRedeliver(run) && (
          <Button size="sm" variant="secondary" onClick={doRedeliver} loading={redeliver.loading} readOnly={readOnly}>
            Redeliver
          </Button>
        )}
      </div>
      {d && !d.emailAvailable && (
        <p className="mt-2 text-xs text-fg-muted">Email is not available on this instance, so the report went in-app only.</p>
      )}
      {d && d.notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-fg-muted list-disc pl-5">
          {d.notes.map((note, i) => <li key={i}>{note}</li>)}
        </ul>
      )}
      <ErrorAlert message={redeliver.error} onDismiss={redeliver.reset} />
      {redeliver.success && <p className="mt-2 text-xs text-success-strong" role="status">{redeliver.success}</p>}
    </Card>
  );
}
