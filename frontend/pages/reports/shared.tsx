// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/reports/shared?token=…` — where a share link lands.
 *
 * THE AUDIENCE HAS NO ACCOUNT. That is the entire premise of share links: the managers a
 * delivery report is written for will not be provisioned into the platform to read a weekly
 * summary. So this page signs nobody in, renders inside the public layout, and reads one
 * frozen snapshot through the token in its URL.
 *
 * READ-ONLY, AND STRUCTURALLY SO. There is no control here that writes anything — no
 * publish, no notes, no regenerate — because the person holding the link is not a member and
 * nothing on this page should imply they could act. The snapshot is already frozen server
 * side; this just renders it.
 *
 * ONE MESSAGE FOR EVERY FAILURE. The API answers an identical 404 for an unknown, revoked,
 * expired, unpublished or deleted report, so this page cannot and must not guess which. A
 * page that said "this link was revoked" would tell whoever found it that the report exists
 * and somebody withdrew it.
 *
 * `noindex` + `no-referrer` because the URL IS the credential: without them, a search engine
 * indexes the report and the next site the reader clicks is handed the token in a header.
 */
import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { CalendarDays, FileText, Lock } from 'lucide-react';
import { PublicLayout } from '@/components/public-directory/PublicLayout';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { SectionCard } from '@/components/reports/stakeholder/ReportReview';
import type { ComposedSection } from '@/lib/api/domains/stakeholder-reports';
import { getSharedReport, type SharedReport } from '@/lib/api/domains/stakeholder-reports-public';
import { tokenFromQuery } from '@/lib/plugin-submissions/status';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; report: SharedReport; expiresAt: string }
  | { kind: 'gone' }
  | { kind: 'error' };

export default function SharedReportPage() {
  const router = useRouter();
  const token = router.isReady ? tokenFromQuery(router.query.token) : null;
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    if (!router.isReady) return;
    if (!token) { setState({ kind: 'gone' }); return; }
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const res = await getSharedReport(token, { signal: controller.signal });
        if (cancelled) return;
        if (res.success && res.data) setState({ kind: 'ready', report: res.data.report, expiresAt: res.data.expiresAt });
        // A non-2xx is the server's single indistinguishable refusal. It is not an error to
        // report as a fault — the link simply does not work any more.
        else setState({ kind: 'gone' });
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        // A TRANSPORT failure is different from a refused link, and conflating them would
        // tell somebody with a perfectly good link to go and ask for a new one.
        setState({ kind: (err as { statusCode?: number }).statusCode ? 'gone' : 'error' });
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [router.isReady, token]);

  return (
    <PublicLayout>
      <Head>
        <title>Delivery report · Pipeline Builder</title>
        {/* The URL is the credential: keep it out of search results and out of the
            referrer header of whatever the reader opens next. */}
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="no-referrer" />
      </Head>

      <div className="mx-auto max-w-3xl space-y-4">
        {state.kind === 'loading' && (
          <p className="text-sm text-fg-muted" role="status" data-testid="shared-report-loading">
            Loading the report…
          </p>
        )}

        {state.kind === 'gone' && (
          <Callout variant="warning" title="This link no longer works">
            <span data-testid="shared-report-gone">
              Delivery-report links expire, and can be withdrawn by the team that sent them.
              Ask whoever shared it for a new one.
            </span>
          </Callout>
        )}

        {state.kind === 'error' && (
          <Callout variant="danger" title="Could not load the report">
            <span data-testid="shared-report-error">
              The server could not be reached. Reload this page — the link itself is probably fine.
            </span>
          </Callout>
        )}

        {state.kind === 'ready' && <ReadOnlyReport report={state.report} expiresAt={state.expiresAt} />}
      </div>
    </PublicLayout>
  );
}

function ReadOnlyReport({ report, expiresAt }: { report: SharedReport; expiresAt: string }) {
  const sections = (report.snapshot?.sections ?? []) as unknown as ComposedSection[];
  return (
    <>
      <header className="space-y-1">
        <h1 className="text-3xl font-bold text-fg">
          <FileText className="mr-2 inline h-6 w-6 text-fg-subtle" aria-hidden="true" />
          Delivery report
        </h1>
        <p className="text-sm text-fg-muted">
          <CalendarDays className="mr-1.5 inline h-4 w-4" aria-hidden="true" />
          {report.periodLabel}
          {report.version > 1 && <> · revision {report.version}</>}
          {report.publishedAt && <> · published {new Date(report.publishedAt).toLocaleDateString()}</>}
        </p>
      </header>

      {/* The lead's own words come FIRST, above the numbers. They are the context the data
          cannot supply, and a reader who meets the tables first has already formed a view. */}
      {report.leadNotes && (
        <Card className="space-y-1">
          <h2 className="h3">Summary</h2>
          <p className="whitespace-pre-line text-sm text-fg" data-testid="shared-report-notes">{report.leadNotes}</p>
        </Card>
      )}

      <section aria-label="Report sections" className="space-y-2">
        {sections.map((s) => <SectionCard key={s.id} section={s} />)}
      </section>

      {report.namesRedacted && (
        <p className="text-xs text-fg-muted" data-testid="shared-report-redacted">
          <Lock className="mr-1 inline h-3 w-3" aria-hidden="true" />
          Project and pipeline names have been replaced in this view.
        </p>
      )}

      {report.snapshot?.methodology && (
        <p className="text-xs text-fg-muted" data-testid="shared-report-methodology">
          {report.snapshot.methodology}
        </p>
      )}

      {/* Said plainly, because a reader who bookmarks this will otherwise find it broken
          later and assume something went wrong. */}
      <p className="text-xs text-fg-muted">
        This link expires on {new Date(expiresAt).toLocaleDateString()}. The numbers above are
        frozen for the period shown and will not change.
      </p>
    </>
  );
}
