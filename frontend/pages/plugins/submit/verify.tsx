// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/plugins/submit/verify?token=…` — where the confirmation email (N1) links.
 *
 * The token is consumed ONLY by an explicit button press (a POST), never on
 * page load: mail scanners and link previewers fetch every link in an email,
 * and a GET that confirmed would let them confirm (or burn) it. On success the
 * page shows the submission's status and its bookmarkable status link.
 */
import { useState } from 'react';
import Link from 'next/link';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { MailCheck } from 'lucide-react';
import { PublicLayout } from '@/components/public-directory/PublicLayout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { CopyButton } from '@/components/ui/CopyButton';
import { ApiError } from '@/lib/api/errors';
import { verifySubmission } from '@/lib/api/domains/plugin-submissions';
import {
  SUBMISSION_STATUS_COLORS, SUBMISSION_STATUS_LABELS, SUBMISSION_STATUS_NEXT, submissionStatusPath, tokenFromQuery,
} from '@/lib/plugin-submissions/status';
import type { SubmissionVerified } from '@/types/plugin-submissions';

function verifyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'SUBMISSIONS_DISABLED') return 'Anonymous plugin submissions are not enabled on this instance.';
    if (err.statusCode === 429) return 'Too many attempts. Wait a minute and try again.';
    if (err.statusCode === 400 || err.statusCode === 404 || err.statusCode === 410) {
      return 'This confirmation link is invalid, already used, or older than 30 minutes. Submit the plugin again to get a new one.';
    }
    return err.message || 'Could not confirm the submission.';
  }
  return 'Could not reach the server. Check your connection and try again.';
}

export default function VerifySubmissionPage() {
  const router = useRouter();
  const token = router.isReady ? tokenFromQuery(router.query.token) : null;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmissionVerified | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await verifySubmission(token));
    } catch (err) {
      setError(verifyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const statusPath = result?.statusToken ? submissionStatusPath(result.statusToken) : null;
  const statusUrl = statusPath && typeof window !== 'undefined' ? `${window.location.origin}${statusPath}` : statusPath;

  return (
    <PublicLayout>
      <Head>
        <title>Confirm your plugin submission · Pipeline Builder</title>
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-3xl font-bold text-fg">Confirm your plugin submission</h1>

        {router.isReady && !token && (
          <Callout variant="warning" title="No confirmation token">
            Open the link from the confirmation email exactly as it was sent. <Link href="/plugins/submit" className="action-link">Submit a plugin</Link>
          </Callout>
        )}

        {token && !result && (
          <div className="card space-y-3 p-6" data-testid="verify-prompt">
            <p className="text-sm text-fg">
              Confirming starts the automated checks on your plugin: an isolated build, a vulnerability scan, a scan for
              suspicious patterns and its smoke test. A moderator then reviews it.
            </p>
            {error && <Callout variant="danger" title="Not confirmed"><span data-testid="verify-error">{error}</span></Callout>}
            <Button onClick={confirm} loading={busy}>
              <MailCheck className="mr-1.5 h-4 w-4" aria-hidden />Confirm submission
            </Button>
          </div>
        )}

        {result && (
          <div className="card space-y-3 p-6" data-testid="verify-result" role="status">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-fg">Submission confirmed</h2>
              <Badge color={SUBMISSION_STATUS_COLORS[result.status]}>{SUBMISSION_STATUS_LABELS[result.status]}</Badge>
            </div>
            <p className="text-sm text-fg-muted">{SUBMISSION_STATUS_NEXT[result.status]}</p>
            {statusPath && statusUrl ? (
              <div className="space-y-2">
                <p className="text-sm text-fg">
                  Bookmark your status link. It is the only way to check on the submission without waiting for email, and we
                  won&apos;t show it again (it is also in the emails we send you).
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all rounded bg-surface-muted px-2 py-1 text-xs" data-testid="status-link">{statusUrl}</code>
                  <CopyButton text={statusUrl} />
                </div>
                <Link href={statusPath} className="action-link text-sm">Open the status page</Link>
              </div>
            ) : (
              <p className="text-sm text-fg-muted">We&apos;ll email you the outcome.</p>
            )}
          </div>
        )}
      </div>
    </PublicLayout>
  );
}
