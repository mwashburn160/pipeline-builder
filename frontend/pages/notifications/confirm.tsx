// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/notifications/confirm?token=…` — where the confirmation email for an org's
 * external plugin-security address links. No sign-in: the address's owner may
 * not have an account at all.
 *
 * The token is consumed ONLY by the explicit Confirm button (a POST), never on
 * page load: mail scanners and link previewers fetch every link in an email,
 * and a GET that confirmed would let them confirm (or burn) it.
 */
import { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { MailCheck } from 'lucide-react';
import { PublicLayout } from '@/components/public-directory/PublicLayout';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ApiError } from '@/lib/api/errors';
import { confirmPluginSecurityEmail } from '@/lib/api/domains/plugin-security';
import { tokenFromQuery } from '@/lib/plugin-submissions/status';

function confirmErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.statusCode === 429) return 'Too many attempts. Wait a minute and try again.';
    if (err.statusCode === 400 || err.statusCode === 404 || err.statusCode === 410) {
      return 'This confirmation link is invalid, already used, or more than 24 hours old. Ask the organization\'s administrator to send a new one.';
    }
    return err.message || 'Could not confirm the address.';
  }
  return 'Could not reach the server. Check your connection and try again.';
}

export default function ConfirmNotificationAddressPage() {
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
      await confirmPluginSecurityEmail(token);
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
        <title>Confirm notification address · Pipeline Builder</title>
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-3xl font-bold text-fg">Confirm this address for security notices</h1>

        {router.isReady && !token && (
          <Callout variant="warning" title="No confirmation token">
            Open the link from the confirmation email exactly as it was sent.
          </Callout>
        )}

        {token && !done && (
          <div className="card space-y-3 p-6" data-testid="confirm-prompt">
            <p className="text-sm text-fg">
              An organization on Pipeline Builder asked to send plugin security notices to this address: plugin versions
              blocked for vulnerabilities, and new Critical or High findings in plugins it uses. Confirm only if you
              expected this. If you didn&apos;t, ignore the email and nothing will be sent.
            </p>
            {error && <Callout variant="danger" title="Not confirmed"><span data-testid="confirm-error">{error}</span></Callout>}
            <Button onClick={confirm} loading={busy}>
              <MailCheck className="mr-1.5 h-4 w-4" aria-hidden />Confirm address
            </Button>
          </div>
        )}

        {done && (
          <Callout variant="success" title="Address confirmed">
            <span data-testid="confirm-done">
              This address now receives the organization&apos;s plugin security notices. Its administrators can remove it
              at any time.
            </span>
          </Callout>
        )}
      </div>
    </PublicLayout>
  );
}
