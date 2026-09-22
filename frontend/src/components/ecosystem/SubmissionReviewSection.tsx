// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from 'react';
import { AlertTriangle, Download, UserX } from 'lucide-react';
import { SubmissionGateList, HeuristicFindingsList } from '@/components/plugin-submissions/SubmissionChecks';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { CopyButton } from '@/components/ui/CopyButton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/download';
import { normalizeSubmissionModeration } from '@/lib/plugin-submissions/moderation';
import { SUBMISSION_STATUS_COLORS, SUBMISSION_STATUS_LABELS } from '@/lib/plugin-submissions/status';
import type { EcosystemRequestDetail } from '@/types/ecosystem';

const count = (n: number | null) => (n == null ? '—' : String(n));

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h4 className="text-sm font-semibold text-fg">{title}</h4>
      {children}
    </section>
  );
}

function DownloadButton({ path, label, fallbackName }: { path: string; label: string; fallbackName: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const { blob, filename } = await api.downloadEcosystemArtifact(path, fallbackName);
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(formatError(err, `${label} download failed`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="xs" onClick={download} loading={busy}>
      <Download className="mr-1 h-3.5 w-3.5" aria-hidden />{label}
    </Button>
  );
}

/**
 * The extra review material for a `submission` request: an
 * anonymous submitter has no history, so moderators get the full gate report,
 * EVERY heuristics finding (including the medium ones the submitter never
 * sees), the quarantine image, and its SBOM and scan report. The diff against
 * the previous approved version is the normal review diff below it.
 */
export function SubmissionReviewSection({ submission: raw }: { submission: EcosystemRequestDetail['submission'] }) {
  const submission = normalizeSubmissionModeration(raw);
  if (!submission) {
    return (
      <Callout variant="warning" title="Submission details unavailable">
        The quarantined submission could not be loaded. Don&apos;t approve it until the gate report and scans are visible.
      </Callout>
    );
  }
  const high = submission.heuristics.filter((f) => f.severity === 'high');
  const failed = submission.gates.filter((g) => !g.ok);
  return (
    <div className="space-y-4 rounded-lg border border-default p-3" data-testid="submission-review-section">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-fg">Anonymous submission</h4>
          <Badge color={SUBMISSION_STATUS_COLORS[submission.status]}>{SUBMISSION_STATUS_LABELS[submission.status]}</Badge>
          <Badge color={submission.newListing ? 'purple' : 'gray'}>{submission.newListing ? 'New listing' : 'Update to an existing listing'}</Badge>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
          <UserX className="h-3.5 w-3.5" aria-hidden />
          <span>No account: the submitter confirmed an email address only (never shown).</span>
          <span>Submitted <RelativeTime value={submission.submittedAt} /></span>
          {submission.verifiedAt && <span>· confirmed <RelativeTime value={submission.verifiedAt} /></span>}
          <span className="font-mono">· {submission.id}</span>
        </p>
      </div>

      {(failed.length > 0 || high.length > 0) && (
        <Callout variant="danger" icon={AlertTriangle} title="Failed checks on a queued submission">
          A submission reaches the queue only when every gate passed. Reject it unless you know why this one did not.
        </Callout>
      )}

      <Section title="Gate report" testId="submission-gate-report">
        <SubmissionGateList gates={submission.gates} testId="submission-console-gates" />
      </Section>

      <Section title={`Heuristics findings (${submission.heuristics.length})`} testId="submission-heuristics">
        <p className="text-xs text-fg-muted">Medium and low findings don&apos;t fail the gate and are shown only here. Read each one.</p>
        <HeuristicFindingsList findings={submission.heuristics} />
      </Section>

      <Section title="Quarantine image and scans" testId="submission-artifacts">
        {submission.quarantineImage ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-surface-muted px-2 py-1 text-xs">{submission.quarantineImage}</code>
            <CopyButton text={submission.quarantineImage} />
          </div>
        ) : (
          <p className="text-xs text-fg-muted">No quarantine image recorded.</p>
        )}
        {submission.vuln ? (
          <p className="text-xs" data-testid="submission-vuln">
            Vulnerabilities: {count(submission.vuln.critical)} critical, {count(submission.vuln.high)} high,{' '}
            {count(submission.vuln.medium)} medium, {count(submission.vuln.low)} low.
            {submission.vuln.scannedAt ? <> Scanned <RelativeTime value={submission.vuln.scannedAt} />.</> : ' Not scanned.'}
          </p>
        ) : (
          <p className="text-xs text-warning-strong">No scan result recorded.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {submission.sbomUrl
            ? <DownloadButton path={submission.sbomUrl} label="SBOM" fallbackName={`submission-${submission.id}.spdx.json`} />
            : <span className="text-xs text-fg-muted">No SBOM.</span>}
          {submission.scanUrl
            ? <DownloadButton path={submission.scanUrl} label="Vulnerability scan" fallbackName={`submission-${submission.id}-scan.json`} />
            : <span className="text-xs text-fg-muted">No scan report.</span>}
        </div>
      </Section>
    </div>
  );
}

/** A `claim` on a community listing: does the claimer own the submitting email? */
export function ClaimEmailMatchNotice({ match }: { match: boolean | null | undefined }) {
  if (match == null) return null;
  return match ? (
    <Callout variant="success" title="Email matches the submitter">
      The claimer&apos;s verified email is the one that submitted this community listing.
    </Callout>
  ) : (
    <Callout variant="warning" icon={AlertTriangle} title="Email does not match submitter">
      The claimer&apos;s verified email is not the one that submitted this community listing. Approve only with a justification.
    </Callout>
  );
}
