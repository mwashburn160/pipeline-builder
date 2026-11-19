// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { InfoAlert } from '@/components/ui/InfoAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import type { TrackedRunRequest } from '@/hooks/useRunRequestTracker';

/**
 * One Re-run / Stop the pipeline page is following through a pipeline runner:
 * "Queued for runner Production…" until it is delivered, then (a started run)
 * the execution's own state until it finishes. A polite live region
 * (`InfoAlert` is `role="status"`), so each change is announced.
 */
export function RunRequestStatus({ request: r }: { request: TrackedRunRequest }) {
  return (
    <div data-testid="run-request-status" className="mb-4">
      <InfoAlert
        message={(
          <span className="inline-flex items-center gap-2">
            <LoadingSpinner size="sm" label={null} />
            {r.phase === 'running' ? (
              <span>
                Execution {r.executionId ? <code className="text-xs">{r.executionId}</code> : null} (via runner <strong>{r.runnerLabel}</strong>):{' '}
                <span data-testid="run-request-execution-status">{r.executionStatus}</span>
              </span>
            ) : (
              <span>
                {r.action === 'start' ? 'Re-run' : 'Stop'}: Queued for runner <strong>{r.runnerLabel}</strong>
                {r.status === 'delivering' ? ' — delivering to the runner…' : '…'}
              </span>
            )}
          </span>
        )}
      />
    </div>
  );
}
