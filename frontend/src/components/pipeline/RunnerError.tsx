// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import Link from 'next/link';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { PIPELINE_RUNNERS_HREF, isRunnerError, runnerErrorCopy } from '@/lib/pipeline-runners';

/** What the banner may add beyond the code: the runner's label and its last
 *  successful delivery, and (discovery) the labels of the runners that were asked. */
export interface RunnerErrorContext {
  runnerLabel?: string | null;
  lastDeliveryAt?: string | null;
  runnersChecked?: string[] | null;
  /** RUNNERS_UNAVAILABLE's `details.reason` (the pause, the key service unreachable, …). */
  reason?: string | null;
}

const LINK_TEXT = {
  install: 'Install a pipeline runner in Settings → Pipeline runners',
  test: 'Test the runner in Settings → Pipeline runners',
  runners: 'Settings → Pipeline runners',
} as const;

/**
 * The Re-run / Stop banner for a runner error code — a refusal of the request
 * itself, or the `errorCode` of a queued request that failed. Names the runner
 * by LABEL only (the platform holds nothing else about the account).
 */
export function runnerErrorBanner(code: string | null | undefined, ctx: RunnerErrorContext = {}): ReactNode {
  const copy = runnerErrorCopy(code, ctx.reason);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const label = str(ctx.runnerLabel);
  const when = code === 'RUNNER_UNREACHABLE' ? str(ctx.lastDeliveryAt) : null;
  const checked = Array.isArray(ctx.runnersChecked) ? ctx.runnersChecked.filter((l) => typeof l === 'string' && l) : [];
  return (
    <span data-testid="runner-error" data-code={code ?? ''}>
      <strong>{copy.title}</strong>{' '}
      {label && <>Runner: <strong>{label}</strong>{when && <> (last delivered <RelativeTime value={when} />)</>}. </>}
      {checked.length > 0 && <>Runners checked: {checked.join(', ')}. </>}
      {copy.body}
      {copy.link && (
        <>
          {' '}
          <Link href={PIPELINE_RUNNERS_HREF} className="underline">{LINK_TEXT[copy.link]}</Link>.
        </>
      )}
      {code && <span className="ml-1 text-xs">({code})</span>}
    </span>
  );
}

/** The banner for a Re-run / Stop refusal carrying a runner error code, or
 *  `null` for any other error (the caller shows its usual message). */
export function runnerErrorMessage(err: unknown): ReactNode | null {
  if (!isRunnerError(err)) return null;
  const d = err.details ?? {};
  return runnerErrorBanner(err.code, {
    runnerLabel: typeof d.runnerLabel === 'string' ? d.runnerLabel : null,
    lastDeliveryAt: typeof d.lastDeliveryAt === 'string' ? d.lastDeliveryAt : null,
    runnersChecked: Array.isArray(d.runnersChecked) ? (d.runnersChecked as string[]) : null,
    reason: typeof d.reason === 'string' ? d.reason : null,
  });
}
