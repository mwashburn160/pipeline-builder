// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/reports/unsubscribe?token=…` — the page behind the unsubscribe link in a report
 * email, for a person who followed it in a browser rather than pressing their mail
 * client's own unsubscribe button.
 *
 * The POST happens on page load here, and that is the opposite of the confirmation
 * page's rule — deliberately. A confirmation token is single-use and consuming it by
 * accident LOSES something (the person is told the link was already used); an
 * unsubscribe is idempotent and consuming it by accident is the outcome they asked
 * for. Making them press a second button to stop email they already said they did not
 * want is how an unsubscribe flow earns a spam complaint instead of an unsubscribe.
 *
 * The mail GATEWAY case is handled elsewhere: this page is a browser GET, and the API
 * itself only accepts POST, so a scanner prefetching the link reaches this page and
 * changes nothing until a browser actually runs it.
 */
import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { MailX } from 'lucide-react';
import { PublicLayout } from '@/components/public-directory/PublicLayout';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { unsubscribeFromReports } from '@/lib/api/domains/stakeholder-reports-public';
import { ApiError } from '@/lib/api/errors';
import { tokenFromQuery } from '@/lib/plugin-submissions/status';

function unsubscribeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.statusCode === 429) return 'Too many attempts. Wait a minute and reload this page.';
    return 'We could not process the unsubscribe. Reply to the report email and ask to be removed.';
  }
  return 'Could not reach the server. Reload this page, or reply to the report email and ask to be removed.';
}

export default function UnsubscribeFromReportsPage() {
  const router = useRouter();
  const token = router.isReady ? tokenFromQuery(router.query.token) : null;
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!router.isReady || !token) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        await unsubscribeFromReports(token, { signal: controller.signal });
        if (!cancelled) setState('done');
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(unsubscribeErrorMessage(err));
        setState('error');
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [router.isReady, token]);

  return (
    <PublicLayout>
      <Head>
        <title>Unsubscribe from reports · Pipeline Builder</title>
        {/* The token is in the URL, so keep it out of search engines and out of the
            referrer header of whatever the reader clicks next. */}
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-3xl font-bold text-fg">Unsubscribe from delivery reports</h1>

        {router.isReady && !token && (
          <Callout variant="warning" title="No unsubscribe token">
            Open the unsubscribe link from the report email exactly as it was sent.
          </Callout>
        )}

        {token && state === 'working' && (
          <Card className="p-6" data-testid="unsubscribe-working">
            <p className="text-sm text-fg-muted">Removing your address…</p>
          </Card>
        )}

        {state === 'done' && (
          <Callout variant="success" title="You have been unsubscribed">
            <span data-testid="unsubscribe-done">
              <MailX className="mr-1.5 inline h-4 w-4" aria-hidden />
              You will not receive any further delivery reports from this organization. This applies to every
              report they send, not just the one you clicked this link in. If you change your mind, ask the
              team&apos;s lead to add you again — you will get a fresh confirmation email.
            </span>
          </Callout>
        )}

        {state === 'error' && (
          <Callout variant="danger" title="Not unsubscribed">
            <span data-testid="unsubscribe-error">{error}</span>
          </Callout>
        )}
      </div>
    </PublicLayout>
  );
}
