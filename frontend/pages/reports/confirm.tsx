// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/reports/confirm?token=…` — where the confirmation email for a stakeholder
 * report recipient links. No sign-in: the manager a report is for usually has no
 * account here at all, which is the whole reason the add-on has a delivery list
 * rather than relying on platform membership.
 *
 * The token is consumed ONLY by the explicit Confirm button (a POST), never on
 * page load: mail scanners and link previewers fetch every link in an email, and
 * a GET that confirmed would let them burn it — the person would then be told the
 * link was already used, with no way to tell why.
 */
import { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { MailCheck } from 'lucide-react';
import { PublicLayout } from '@/components/public-directory/PublicLayout';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { confirmReportRecipientEmail } from '@/lib/api/domains/stakeholder-reports-public';
import { ApiError } from '@/lib/api/errors';
import { tokenFromQuery } from '@/lib/plugin-submissions/status';

/**
 * One message for every way a token can fail.
 *
 * The backend deliberately answers the same way for expired, already-used and
 * never-existed, because distinguishing them would make this an oracle for which
 * addresses are on an organization's distribution list. The copy matches: it says
 * what to do rather than guessing which case it was.
 */
function confirmErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.statusCode === 429) return 'Too many attempts. Wait a minute and try again.';
    if (err.statusCode === 400 || err.statusCode === 404 || err.statusCode === 410) {
      return 'This confirmation link is no longer valid. Ask whoever added you to send a new one.';
    }
    return err.message || 'Could not confirm the address.';
  }
  return 'Could not reach the server. Check your connection and try again.';
}

export default function ConfirmReportRecipientPage() {
  const router = useRouter();
  const token = router.isReady ? tokenFromQuery(router.query.token) : null;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await confirmReportRecipientEmail(token);
      setDone(true);
    } catch (err) {
      setError(confirmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicLayout>
      <Head>
        <title>Confirm report delivery · Pipeline Builder</title>
        {/* The token is in the URL, so keep it out of search engines and out of
            the referrer header of whatever the reader clicks next. */}
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-3xl font-bold text-fg">Confirm this address for delivery reports</h1>

        {router.isReady && !token && (
          <Callout variant="warning" title="No confirmation token">
            Open the link from the confirmation email exactly as it was sent.
          </Callout>
        )}

        {token && !done && (
          <Card className="space-y-3 p-6" data-testid="confirm-prompt">
            <p className="text-sm text-fg">
              An engineering team on Pipeline Builder asked to send you their delivery reports: a regular summary of
              what shipped, what broke and how that compares with the period before, written up by their lead.
              Confirm only if you expected this. If you didn&apos;t, ignore the email and nothing will be sent.
            </p>
            {error && <Callout variant="danger" title="Not confirmed"><span data-testid="confirm-error">{error}</span></Callout>}
            <Button onClick={confirm} loading={busy}>
              <MailCheck className="mr-1.5 h-4 w-4" aria-hidden />Confirm address
            </Button>
          </Card>
        )}

        {done && (
          <Callout variant="success" title="Address confirmed">
            <span data-testid="confirm-done">
              You will receive this team&apos;s reports from the next one onward. Every email carries an unsubscribe
              link, and it applies to every report from this organization — not just the one you clicked it in.
            </span>
          </Callout>
        )}
      </div>
    </PublicLayout>
  );
}
