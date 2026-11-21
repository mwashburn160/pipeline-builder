// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Download, PackageOpen } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SectionCard } from '@/components/ui/SectionCard';
import api from '@/lib/api';
import { continueAfterStepUp, stepUpReplayFailed } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/download';

/**
 * The organization's own data export (`GET /organization/:id/export`, the
 * GDPR-portability dump). The endpoint was reachable only from the sysadmin's
 * org detail page and a team's card — an org's own admin had no way to take
 * their data with them. Step-up gated server-side (a bulk read of every row the
 * org owns, which a stolen session must not take), so the button opens the
 * step-up dialog and the download replays its token. It is a read, so it works
 * during a read-only session.
 */
export function OrgDataExport({ orgId, orgName }: { orgId: string; orgName?: string }) {
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const save = (json: string) => {
    const slug = (orgName ?? orgId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || orgId;
    triggerBlobDownload(new Blob([json], { type: 'application/json' }), `org-${slug}-export.json`);
    setDone(true);
  };

  const run = async (stepUpToken: string) => {
    setAsking(false);
    setError(null);
    setDone(false);
    setPending(true);
    try {
      save(await api.exportOrganization(orgId, stepUpToken));
    } catch (err) {
      // A refused-again token hands the replay to the global dialog; the file
      // is saved when that replay answers. A replay that fails is reported; a
      // dismissed dialog is the person's choice and says nothing.
      if (continueAfterStepUp<string>(err, save, (reason) => {
        if (stepUpReplayFailed(reason)) setError(formatError(reason, 'Could not export the organization\'s data'));
      })) return;
      setError(formatError(err, 'Could not export the organization\'s data'));
    } finally {
      setPending(false);
    }
  };

  return (
    <SectionCard
      icon={PackageOpen}
      title="Export organization data"
      description="Download what the platform holds for this organization — its profile, members, roles, pipelines, plugins, settings and recent audit events — as one JSON file, for your records or to move elsewhere."
    >
      <div className="space-y-3">
        <ErrorAlert message={error} onDismiss={() => setError(null)} />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => setAsking(true)} loading={pending} className="gap-1">
            <Download className="h-4 w-4" aria-hidden /> Download export
          </Button>
          {done && <span className="text-xs text-fg-muted" role="status">Export downloaded.</span>}
        </div>
      </div>
      {asking && (
        <StepUpModal
          title={`Export ${orgName ?? 'this organization'}'s data?`}
          action={`Download a copy of ${orgName ?? 'this organization'}'s data`}
          details={<p>The file contains the organization&apos;s members, settings and audit events — store it somewhere safe.</p>}
          onConfirmed={run}
          onClose={() => setAsking(false)}
        />
      )}
    </SectionCard>
  );
}
