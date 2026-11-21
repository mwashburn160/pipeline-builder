// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Download, FileJson } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SectionCard } from '@/components/ui/SectionCard';
import api from '@/lib/api';
import { continueAfterStepUp, stepUpReplayFailed } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/download';
import { localDay } from '@/lib/local-day';

/** The file name the platform also suggests (`Content-Disposition`). */
export function personalExportFilename(now = new Date()): string {
  return `pipeline-builder-account-${localDay(now)}.json`;
}

/**
 * "Download my data" — the caller's OWN data (`GET /user/export`): account,
 * memberships, access-key and passkey metadata, sessions, preferences, join
 * requests and the audit events naming them, as one JSON file. Step-up gated
 * server-side (a bulk read of personal data a stolen session must not take), so
 * the button opens the step-up dialog and the download replays its token.
 * A read, so it stays available during a read-only session.
 */
export function PersonalDataExport() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const save = (json: string) => {
    triggerBlobDownload(new Blob([json], { type: 'application/json' }), personalExportFilename());
    setDone(true);
  };

  const run = async (stepUpToken: string) => {
    setError(null);
    setDone(false);
    try {
      save(await api.exportOwnData(stepUpToken));
    } catch (err) {
      // A refused-again token hands the replay to the global dialog; the file
      // is saved when that replay answers. A failed replay is shown; a
      // dismissed dialog says nothing.
      if (continueAfterStepUp<string>(err, save, (reason) => {
        if (stepUpReplayFailed(reason)) setError(formatError(reason, 'Could not export your data'));
      })) return;
      setError(formatError(err, 'Could not export your data'));
    }
  };

  return (
    <SectionCard
      icon={FileJson}
      title="Download my data"
      description="A copy of what the platform holds about you — your account, memberships, sessions, access-key and passkey details, preferences and the audit events that name you — as one JSON file."
    >
      <div className="space-y-3">
        <ErrorAlert message={error} onDismiss={() => setError(null)} />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => setPending(true)} className="gap-1">
            <Download className="h-4 w-4" aria-hidden /> Download my data
          </Button>
          {done && <span className="text-xs text-fg-muted" role="status">Your data was downloaded.</span>}
        </div>
      </div>
      {pending && (
        <StepUpModal
          title="Download your data?"
          action="Download a copy of your account data"
          details={<p>The file contains personal data — store it somewhere safe.</p>}
          onConfirmed={run}
          onClose={() => setPending(false)}
        />
      )}
    </SectionCard>
  );
}
