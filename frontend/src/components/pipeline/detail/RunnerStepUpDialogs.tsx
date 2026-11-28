// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline detail page's step-up dialogs for its runner: find this
 * pipeline's runner again, and send the runner a test request.
 */

import type { ReactNode } from 'react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useToast } from '@/components/ui/Toast';
import type { useRunnerLink } from '@/components/pipeline/RunnerLinkStatus';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { runnerTestFailureCopy } from '@/lib/pipeline-runners';

interface RunnerStepUpDialogsProps {
  open: 'find' | 'test' | null;
  runnerLink: ReturnType<typeof useRunnerLink>;
  reportActionError: (e: unknown, message: string) => void;
  setActionError: (error: ReactNode) => void;
  onClose: () => void;
}

export function RunnerStepUpDialogs({ open, runnerLink, reportActionError, setActionError, onClose }: RunnerStepUpDialogsProps) {
  const toast = useToast();
  return (
    <>
      {open === 'find' && (
        <StepUpModal
          title="Find this pipeline's runner again?"
          action="Look for this pipeline's runner again"
          details={(
            <p>
              The platform asks your organization&apos;s runners which one holds this pipeline (by its pb.pipeline-id tag).
              A single match replaces the link; anything else keeps the current link and records what was found.
            </p>
          )}
          onConfirmed={async (stepUpToken) => {
            try {
              await runnerLink.refresh(stepUpToken);
            } catch (e) {
              reportActionError(e, formatError(e, 'Could not look for the runner again'));
            }
          }}
          onClose={onClose}
        />
      )}

      {open === 'test' && runnerLink.link?.runner && (
        <StepUpModal
          title={`Test ${runnerLink.link.runner.label}?`}
          action={`Send a test request to the pipeline runner ${runnerLink.link.runner.label}`}
          details={<p>The platform sends the runner a signed ping now. If it answers, paused deliveries resume.</p>}
          onConfirmed={async (stepUpToken) => {
            const runner = runnerLink.link?.runner;
            if (!runner) return;
            try {
              const r = await api.testPipelineRunner(runner.id, stepUpToken);
              if (r.data?.ok) toast.success(`${runner.label} answered`);
              else setActionError(`Test failed: ${runnerTestFailureCopy(r.data?.errorCode)}`);
              void runnerLink.refetch();
            } catch (e) {
              reportActionError(e, formatError(e, 'Could not test the runner'));
            }
          }}
          onClose={onClose}
        />
      )}
    </>
  );
}
