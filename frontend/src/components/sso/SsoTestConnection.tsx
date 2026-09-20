// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { formatDateTime } from '@/lib/format';
import type { SsoTestReport } from '@/types';
import { awaitSsoTestResult } from './test-channel';

/** What each stable failure reason means for the admin running the test. */
const REASON_HINTS: Record<string, string> = {
  invalid_assertion: 'Check the signing certificate(s), the entity ID and that the IdP signs both the response and the assertion, with the SP entity ID as audience.',
  encryption_required: 'This connection requires encrypted assertions, but the IdP sent a plaintext one. Turn encryption on at the IdP (using the SP encryption certificate) or turn the requirement off here.',
  unexpected_encryption: 'The IdP encrypted the assertion but encrypted assertions are off here. Turn "IdP encrypts assertions" on, or turn encryption off at the IdP.',
  domain_not_verified: 'The email the IdP asserted is on a domain this organization has not verified. Verify the domain (Settings → Organization).',
  email_domain_not_allowed: 'The email\'s domain is not among the domains this connection serves.',
  no_email: 'The IdP sent no email address. Map the email attribute (SAML) or grant the email scope (OIDC).',
  invalid_id_token: 'The id_token failed validation — check the client ID and the discovery URL.',
  token_exchange_failed: 'The code exchange failed — check the client secret and that the redirect URI is registered exactly.',
  discovery_failed: 'The discovery document could not be loaded — check the discovery URL.',
  platform_admin: 'You signed in at the IdP as a platform administrator; platform administrators can never sign in through an organization\'s SSO. Test with a regular account.',
  seat_limit: 'The organization has no free seat for this person; a real sign-in would be refused.',
  idp_error: 'The identity provider refused or cancelled the sign-in.',
};

/**
 * TEST CONNECTION — a real round trip to the identity provider in a popup that
 * reports what a sign-in WOULD do (identity, groups, which role mappings apply,
 * or why it would be refused) and creates nothing: no session, no user, no
 * membership. A success is what unlocks "SSO required".
 */
export function SsoTestConnection({
  orgId,
  readOnly,
  onReport,
}: {
  orgId: string;
  readOnly?: boolean;
  /** Fired with every completed report (the page re-reads the config's `lastTest`). */
  onReport?: (report: SsoTestReport) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SsoTestReport | null>(null);
  // Text for the always-mounted live region below. A region added to the DOM
  // together with its text is NOT announced — only a change inside a region
  // that was already there is — so the outcome has to arrive as a text update.
  const [announcement, setAnnouncement] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const run = async () => {
    setError(null);
    setReport(null);
    setAnnouncement('');
    // Opened on the click, or pop-up blockers win.
    const popup = window.open('', 'pb-sso-test', 'width=520,height=720');
    if (!popup) {
      setError('Allow pop-ups for this site to run a test connection.');
      setAnnouncement('Allow pop-ups for this site to run a test connection.');
      return;
    }
    setRunning(true);
    setAnnouncement('Running the test connection. Sign in at your identity provider in the pop-up.');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const started = await api.startSsoTest(orgId);
      const { url, state } = started.data ?? { url: '', state: '' };
      if (!url || !state) throw new Error('The test could not be started.');
      popup.location.href = url;
      const result = await awaitSsoTestResult(state, controller.signal);
      const done = await api.completeSsoTest(orgId, { state, ...(result.code ? { code: result.code } : {}), ...(result.error ? { error: result.error } : {}) });
      const r = done.data?.report;
      if (!r) throw new Error('The test returned no report.');
      setReport(r);
      setAnnouncement(describeReport(r));
      onReport?.(r);
    } catch (err) {
      const message = formatError(err, 'The test connection failed to run.');
      setError(message);
      setAnnouncement(message);
      try { popup.close(); } catch { /* already closed */ }
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  return (
    <div className="space-y-3" data-testid="sso-test-connection">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" loading={running} readOnly={readOnly} onClick={() => { void run(); }}>
          <FlaskConical className="w-4 h-4 mr-2" />Test connection
        </Button>
        {running && (
          <Button type="button" variant="ghost" size="sm" onClick={() => abort.current?.abort()}>Cancel</Button>
        )}
        <span className="text-xs text-fg-muted">
          Sign in at your identity provider in the pop-up. Nothing is created — no session, account or membership.
        </span>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      {report && <SsoTestReportView report={report} />}
    </div>
  );
}

/** One sentence naming the outcome, for the live region. Uses the same prose as
 *  the report body — the raw reason enum means nothing read aloud. */
function describeReport(report: SsoTestReport): string {
  if (report.ok) return 'Test succeeded — a sign-in would work.';
  const hint = report.reason ? REASON_HINTS[report.reason] : undefined;
  return ['Test failed.', report.message, hint].filter(Boolean).join(' ');
}

/** The dry-run report. */
function SsoTestReportView({ report }: { report: SsoTestReport }) {
  return (
    <div
      className={`rounded-lg border p-3 text-sm space-y-2 ${report.ok
        ? 'border-green-200 bg-green-50 dark:border-green-900/50 dark:bg-green-900/20'
        : 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/20'}`}
      data-testid="sso-test-report"
    >
      <p className="flex items-center gap-2 font-medium">
        {report.ok
          ? <><CheckCircle2 className="w-4 h-4 text-success" />Test succeeded — a sign-in would work.</>
          : <><XCircle className="w-4 h-4 text-danger" />Test failed.</>}
      </p>
      {!report.ok && (
        <p>{report.message}{report.reason && REASON_HINTS[report.reason] ? ` ${REASON_HINTS[report.reason]}` : ''}</p>
      )}
      {report.identity && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-fg-muted">Email</dt><dd className="font-mono">{report.identity.email}</dd>
          {report.identity.name && (<><dt className="text-fg-muted">Name</dt><dd>{report.identity.name}</dd></>)}
          <dt className="text-fg-muted">Subject</dt><dd className="font-mono break-all">{report.identity.subject}</dd>
          <dt className="text-fg-muted">Groups</dt>
          <dd>{report.identity.groups.length ? report.identity.groups.join(', ') : <em>none asserted</em>}</dd>
          {report.mappings && (
            <>
              <dt className="text-fg-muted">Mapped roles</dt>
              <dd>
                {report.mappings.roles.length
                  ? `${report.mappings.roles.map((r) => r.name).join(', ')} (from ${report.mappings.matchedGroups.join(', ')})`
                  : <em>no group mapping matches — the member role only</em>}
              </dd>
            </>
          )}
        </dl>
      )}
      <p className="text-xs text-fg-muted">
        {report.protocol.toUpperCase()} · {formatDateTime(report.testedAt)}
        {report.recorded === false && ' · not recorded: the settings changed while the test ran — run it again.'}
      </p>
    </div>
  );
}
