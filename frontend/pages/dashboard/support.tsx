// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { LifeBuoy } from 'lucide-react';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { RetryError } from '@/components/ui/RetryError';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { FeatureLock } from '@/components/ui/FeatureLock';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { caseStatusLabel, responseTargetLabel } from '@/components/message/MessageList';
import { SupportCaseRating } from '@/components/message/SupportCaseRating';
import type { SupportCaseSummary } from '@/types';

/**
 * The tenant's own support cases.
 *
 * A SEPARATE PAGE from Messages rather than a tab on it, for two reasons the
 * plan settles: tenant and staff surfaces need different gates and a `NavItem`
 * declares one gate for one route, and nobody searching for a support ticket
 * types "messages".
 *
 * ENTITLEMENT-LOCKED, NOT HIDDEN. The nav row stays visible for an org with no
 * support add-on, routes here, and gets the upsell in place. That is the point
 * of the lock refusing to hide itself: a paywalled support product that is
 * invisible to non-buyers sells nothing. Messages stays ungated beside it, so
 * B3's carve-out holds — security reports, billing disputes and account
 * lockouts still reach us from an org holding nothing.
 *
 * The lock is checked against ANY of the three levels, because they are
 * mutually exclusive: naming one would lock the page for a customer who bought
 * another. `nav.ts` reports `support_standard` as the missing flag, which is the
 * cheapest route in and the right thing to put in front of somebody with none.
 */
export default function SupportPage() {
  const { isReady, accessDenied } = useAuthGuard();
  // Each level checked separately: `useFeatureGate` answers one flag, and the
  // levels are exclusive. Entitled on ANY; the upsell names the cheapest.
  const standard = useFeatureGate('support_standard');
  const priority = useFeatureGate('support_priority');
  const premium = useFeatureGate('support_premium');
  const loaded = standard.isLoaded && priority.isLoaded && premium.isLoaded;
  const entitled = standard.entitled || priority.entitled || premium.entitled;

  const cases = useFetch(async () => {
    const res = await api.getSupportCases();
    return res.data?.cases ?? [];
  }, []);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady) return <LoadingPage />;

  const rows: SupportCaseSummary[] = cases.data ?? [];

  return (
    <DashboardLayout title="Support">
      <div className="space-y-4">
        {!loaded ? (
          <LoadingPage />
        ) : !entitled ? (
          <>
            {/* Named as the cheapest way in. The three levels are exclusive, so
                an upsell for all three at once would be a choice nobody can
                make from here. */}
            <FeatureLock flag="support_standard" />
            {/* The carve-out, said out loud. Somebody who lands on a locked
                page needs to know that a security report or a lockout still
                reaches us — otherwise the lock reads as "we will not talk to
                you", which is both wrong and alarming. */}
            <Callout variant="info">
              Security reports, billing disputes and account lockouts always reach us, with or without a
              support add-on — send those from{' '}
              <Link href="/dashboard/messages" className="underline">Messages</Link>.
            </Callout>
          </>
        ) : (
          <>
            {cases.error && (
              <RetryError message="Your support cases could not be loaded" onRetry={cases.refetch} />
            )}

            {/* The ledger as a file. A plain link, not a scripted download:
                the artifact sandbox aside, a same-origin GET that the browser
                saves is the simplest thing that works and needs no blob
                handling. Shown only when there is something to export. */}
            {rows.length > 0 && (
              <div className="flex justify-end">
                <a
                  href={api.supportCasesExportUrl()}
                  className="text-sm text-info underline"
                  download
                >
                  Export cases (CSV)
                </a>
              </div>
            )}

            {!cases.error && rows.length === 0 && (
              <EmptyState
                icon={LifeBuoy}
                title="No support cases yet"
                description="Cases appear here as soon as one of your designated support contacts raises one from Messages."
              />
            )}

            {rows.map((c) => (
              <Card key={c.threadId}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                  <span className="font-semibold">#{c.displayNumber}</span>
                  <span className="text-fg-muted">{caseStatusLabel(c.status)}</span>
                  {/* The target comes from the level FROZEN on the case, so it
                      stays truthful after a plan change — and an unrecognised
                      level omits the phrase rather than borrowing another
                      level's promise. */}
                  {responseTargetLabel(c.level) && (
                    <span className="text-fg-muted">
                      first response within {responseTargetLabel(c.level)}
                    </span>
                  )}
                  <Link
                    href={`/dashboard/messages?thread=${encodeURIComponent(c.threadId)}`}
                    className="ml-auto text-info underline"
                  >
                    Open conversation
                  </Link>
                </div>

                {/* Only on a finished case, because rating one still being
                    worked would be judging an answer nobody has given. Offered
                    again after a rating, not locked: somebody who rated in
                    frustration and came back calmer should be able to change
                    it, and freezing the first number would make the metric
                    measure how people felt at their worst moment. */}
                {(c.status === 'closed' || c.status === 'resolved') && (
                  <SupportCaseRating
                    threadId={c.threadId}
                    caseNumber={c.displayNumber}
                    current={c.satisfaction ?? null}
                    onRated={cases.refetch}
                  />
                )}
              </Card>
            ))}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
