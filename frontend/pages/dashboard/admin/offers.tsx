// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { Ban, Megaphone, Play, ShieldAlert } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { BillingAdminTabs } from '@/components/billing/BillingAdminTabs';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Input } from '@/components/ui/Input';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { AdminOffer, AdminOfferSummary, OfferExclusion, OfferLiftArm } from '@/types';

/**
 * What the expansion-offers agent has been doing
 * (docs/plans/sales-agent.md F8).
 *
 * **An automated granter needs its own view.** Without this, "why did this
 * account get this?" has no answer in the UI — which is what the `Offer` record
 * was for in the first place.
 *
 * The per-reason SUPPRESSION counts are the headline rather than a footnote: a
 * feature suppressing almost everything looks exactly like a feature working
 * carefully, and the two are only distinguishable if each reason is counted
 * separately. An operator reading `incomplete_profile: 4,000` learns the rules
 * never ran; reading `negative_ev: 4,000` learns they ran and refused.
 *
 * Served by billing, not by the decision process, which exposes no
 * customer-facing or admin route of its own (D13).
 */
export default function AdminOffersPage() {
  const { accessDenied, user, isReady, isAuthenticated, can } = useAuthGuard();
  const canRead = can('subscriptions:read');
  const canManage = can('subscriptions:manage');
  const toast = useToast();

  const [summary, setSummary] = useState<AdminOfferSummary | null>(null);
  const [exclusions, setExclusions] = useState<OfferExclusion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The veto form. A reason is required by the server, so the button stays
  // disabled without one rather than letting the 400 explain it.
  const [excludeOrg, setExcludeOrg] = useState('');
  const [excludeReason, setExcludeReason] = useState('');
  const [triggerOrg, setTriggerOrg] = useState('');

  const load = useCallback(async () => {
    if (!isAuthenticated || !canRead) return;
    try {
      const [offers, list] = await Promise.all([api.listAdminOffers({ limit: 50 }), api.listOfferExclusions()]);
      setSummary(offers.data ?? null);
      setExclusions(list.data?.exclusions ?? []);
      setError(null);
    } catch (err) {
      setError(formatError(err, 'Could not load offer decisions'));
    }
  }, [isAuthenticated, canRead]);

  useEffect(() => { void load(); }, [load]);

  async function exclude() {
    setBusy(true);
    try {
      await api.setOfferExclusion(excludeOrg.trim(), excludeReason.trim());
      setExcludeOrg(''); setExcludeReason('');
      await load();
      toast.success('Account excluded from offers');
    } catch (err) {
      toast.error(formatError(err, 'Could not exclude that account'));
    } finally { setBusy(false); }
  }

  async function lift(orgId: string) {
    setBusy(true);
    try {
      await api.clearOfferExclusion(orgId);
      await load();
      toast.success('Exclusion lifted');
    } catch (err) {
      toast.error(formatError(err, 'Could not lift that exclusion'));
    } finally { setBusy(false); }
  }

  async function trigger() {
    setBusy(true);
    try {
      const res = await api.triggerOffer(triggerOrg.trim());
      const d = res.data?.decision ?? null;
      await load();
      // A suppression is a legitimate ANSWER, not a failure: the trigger runs
      // every gate the cycle runs, so saying "refused, and here is the reason"
      // is the point of having it.
      if (!d) toast.info('That account could not be evaluated yet (no plan or no usage profile).');
      else if (d.status === 'sent') toast.success(`Offer made: ${d.offerType ?? 'offer'}`);
      else toast.info(`No offer: ${d.reason ?? 'the rules refused'}`);
    } catch (err) {
      toast.error(formatError(err, 'Could not evaluate that account'));
    } finally { setBusy(false); }
  }

  const columns: Column<AdminOffer>[] = [
    { id: 'orgId', header: 'Account', render: (r) => <span className="font-mono text-xs">{r.orgId}</span> },
    {
      id: 'status',
      header: 'Outcome',
      render: (r) => (r.suppressedReason
        ? <Badge color="gray">{r.suppressedReason}</Badge>
        : <Badge color={r.status === 'redeemed' ? 'green' : r.status === 'declined' ? 'red' : 'blue'}>{r.status}</Badge>),
    },
    { id: 'offerType', header: 'Type', render: (r) => (r.suppressedReason ? '—' : r.offerType) },
    { id: 'source', header: 'Source', render: (r) => r.source },
    { id: 'holdout', header: 'Holdout', render: (r) => (r.holdout ? 'yes' : '') },
    { id: 'rationale', header: 'Signals', render: (r) => <span className="text-xs text-fg-muted">{r.rationale.join(', ') || '—'}</span> },
    { id: 'createdAt', header: 'Decided', render: (r) => new Date(r.createdAt).toLocaleString() },
  ];

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  const offersOff = summary?.enabled.offers === false || summary?.enabled.billing === false;
  return (
    <DashboardLayout
      title="Billing admin"
      subtitle="Expansion offers: what was decided, why, and who is excluded"
      titleExtra={<Badge color="red">System Admin</Badge>}
    >
      <BillingAdminTabs active="offers" />
      <ErrorAlert message={error} onRetry={() => void load()} onDismiss={() => setError(null)} />

      {offersOff && (
        <Card className="mt-4 flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-sm text-fg-muted">
            Offers are switched off on this deployment
            {summary?.enabled.billing === false ? ' (billing itself is disabled)' : ' (OFFERS_ENABLED=false)'}.
            Usage profiles keep being collected — that history cannot be backfilled — but no offer is created.
          </p>
        </Card>
      )}

      {/* The counts first. "Suppressed and why, per reason" is the measurement
          that tells an operator whether this feature is working or merely
          running, so it is not buried under the row list. */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <h3 className="text-sm font-semibold text-fg">Outcomes</h3>
          <CountList counts={summary?.counts.byStatus ?? {}} empty="No decisions recorded yet." />
          <p className="mt-3 text-xs text-fg-subtle">
            {summary?.counts.holdout ?? 0} in the measurement holdout — never offered to, so the lift
            calculation has a control group.
          </p>
        </Card>
        <Card>
          <h3 className="text-sm font-semibold text-fg">Suppressed, by reason</h3>
          <CountList
            counts={summary?.counts.bySuppressionReason ?? {}}
            empty="Nothing suppressed yet."
          />
        </Card>
      </div>

      {/* The lift. Shown beside the raw counts because the counts alone cannot
          answer the only question that matters: an account that was going to
          upgrade this month upgrades this month, and if it got an offer first
          the offer takes the credit. */}
      <Card className="mt-4">
        <h3 className="text-sm font-semibold text-fg">Offered vs holdout</h3>
        <p className="mt-1 text-xs text-fg-muted">
          Conversion rate per account in each arm. A NEGATIVE lift is a real answer — it means the
          accounts we solicited converted less than the ones we left alone.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Arm label="Offered" arm={summary?.lift.offered} />
          <Arm label="Holdout" arm={summary?.lift.holdout} />
          <div>
            <p className="text-xs uppercase tracking-wider text-fg-subtle">Lift</p>
            <p
              className={`text-xl font-semibold tabular-nums ${liftTone(summary?.lift.lift)}`}
              data-testid="offer-lift"
            >
              {summary ? `${(summary.lift.lift * 100).toFixed(1)} pts` : '—'}
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Bought SKU</h4>
            <p className="mt-1 text-xs text-fg-muted">
              An account that converts to a DIFFERENT SKU is a targeting failure wearing a conversion win.
            </p>
            <CountList counts={summary?.lift.skuMatch ?? {}} empty="No conversions yet." />
          </div>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Time to conversion</h4>
            <CountList counts={summary?.lift.timeToConversion ?? {}} empty="No conversions yet." />
          </div>
        </div>
      </Card>

      {canManage && (
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
              <Ban className="h-4 w-4" aria-hidden="true" /> Do not offer
            </h3>
            <p className="mt-1 text-xs text-fg-muted">
              The veto for an account a person is handling — a negotiation, a strategic account, a save in
              progress. A reason is required: a bare list of ids cannot tell an expired negotiation from a
              permanent exclusion.
            </p>
            <div className="mt-3 space-y-2">
              <Input placeholder="Account (root org) id" value={excludeOrg} onChange={(e) => setExcludeOrg(e.target.value)} aria-label="Account id to exclude" />
              <Input placeholder="Why" value={excludeReason} onChange={(e) => setExcludeReason(e.target.value)} aria-label="Reason for excluding" />
              <Button size="sm" variant="secondary" disabled={busy || !excludeOrg.trim() || !excludeReason.trim()} onClick={() => void exclude()}>
                Exclude account
              </Button>
            </div>
            {exclusions.length > 0 && (
              <ul className="mt-4 space-y-2">
                {exclusions.map((x) => (
                  <li key={x.orgId} className="flex items-start justify-between gap-2 text-xs">
                    <span>
                      <span className="font-mono">{x.orgId}</span>
                      <span className="text-fg-muted"> — {x.reason}</span>
                    </span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void lift(x.orgId)}>Lift</Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
              <Play className="h-4 w-4" aria-hidden="true" /> Evaluate now
            </h3>
            <p className="mt-1 text-xs text-fg-muted">
              Runs the same decision the cycle runs, every gate included — including the holdout. It can and
              often will answer &ldquo;no offer&rdquo;, with the reason. It does not force one: a trigger
              that bypassed the rules would mint an offer the rules had just refused, under the agent&apos;s name.
            </p>
            <div className="mt-3 flex gap-2">
              <Input placeholder="Account (root org) id" value={triggerOrg} onChange={(e) => setTriggerOrg(e.target.value)} aria-label="Account id to evaluate" />
              <Button size="sm" variant="secondary" disabled={busy || !triggerOrg.trim()} onClick={() => void trigger()}>
                Evaluate
              </Button>
            </div>
          </Card>
        </div>
      )}

      <Card className="mt-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <Megaphone className="h-4 w-4" aria-hidden="true" /> Decisions
        </h3>
        <p className="mt-1 text-xs text-fg-muted">
          Every outcome is a row, refusals included — that is what makes &ldquo;why did this account get
          this?&rdquo; answerable without re-running a rule set that has since changed.
        </p>
        <div className="mt-3">
          <DataTable
            columns={columns}
            data={summary?.offers ?? []}
            isLoading={summary === null && error === null}
            getRowKey={(r) => r.id}
            emptyState={{
              icon: Megaphone,
              title: 'No offer decisions yet',
              description: 'The cycle records a row for every account it considers, including every refusal.',
            }}
          />
        </div>
      </Card>
    </DashboardLayout>
  );
}

/** One arm of the comparison: how many accounts, how many converted. */
function Arm({ label, arm }: { label: string; arm?: OfferLiftArm }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-fg-subtle">{label}</p>
      <p className="text-xl font-semibold tabular-nums text-fg">
        {arm ? `${(arm.conversionRate * 100).toFixed(1)}%` : '—'}
      </p>
      <p className="text-xs text-fg-muted tabular-nums">
        {arm ? `${arm.conversions} of ${arm.accounts} accounts` : ''}
      </p>
    </div>
  );
}

/** Green for a positive lift, danger for a negative one, neutral before there is one. */
function liftTone(lift?: number): string {
  if (lift === undefined || lift === 0) return 'text-fg';
  return lift > 0 ? 'text-success' : 'text-danger';
}

/** A count list, highest first — the long tail is what an operator scans for. */
function CountList({ counts, empty }: { counts: Record<string, number>; empty: string }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className="mt-2 text-sm text-fg-muted">{empty}</p>;
  return (
    <ul className="mt-2 space-y-1">
      {rows.map(([key, n]) => (
        <li key={key} className="flex items-baseline justify-between text-sm">
          <span className="text-fg-muted">{key}</span>
          <span className="font-medium tabular-nums text-fg">{n}</span>
        </li>
      ))}
    </ul>
  );
}
