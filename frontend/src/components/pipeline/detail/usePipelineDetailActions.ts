// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline detail page's write actions: run (through the pipeline's
 * runner, registering it first when it is not registered), cancel a run, and
 * delete the pipeline — with the shared action-error banner and the dialogs
 * those flows open.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import { useToast } from '@/components/ui/Toast';
import type { useAuthGuard } from '@/hooks/useAuthGuard';
import { runnerErrorBanner, runnerErrorMessage } from '@/components/pipeline/RunnerError';
import type { useRunnerLink } from '@/components/pipeline/RunnerLinkStatus';
import { useRunRequestTracker, type RunRequestOutcome } from '@/hooks/useRunRequestTracker';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { MfaRequiredError } from '@/lib/api/errors';
import type { PipelineWithRegistration } from './pipeline-detail-model';

/** How long after a write the execution list is re-read (see below). */
const REFETCH_DELAY_MS = 2500;

interface Options {
  id: string;
  pipeline: PipelineWithRegistration | null | undefined;
  runnerLink: ReturnType<typeof useRunnerLink>;
  can: ReturnType<typeof useAuthGuard>['can'];
  loadExecutions: () => unknown;
}

export function usePipelineDetailActions({ id, pipeline, runnerLink, can, loadExecutions }: Options) {
  const router = useRouter();
  const toast = useToast();

  // Write actions (AWS CodePipeline trigger / cancel). Ingestion of the new
  // event is asynchronous, so we refetch after a short delay to let the
  // pipeline-events Lambda persist the run before we re-query.
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);

  // Each action reports into the page's shared `actionError` banner, and is
  // bound to the pipeline it started for: an id switch mid-flight drops it.
  // A refusal with a pipeline-runner error code (NO_RUNNER, RUNNER_UNREACHABLE,
  // …) gets specific copy and the way to fix it, not the bare server sentence.
  // An MFA refusal is the shell's (its enrol / sign-in-again dialog): no second error here.
  const reportActionError = (e: unknown, message: string) => {
    if (e instanceof MfaRequiredError) return;
    setActionError(runnerErrorMessage(e) ?? message);
  };

  // Every run goes through the pipeline's runner: the write answers 202
  // `{ requestId, status: 'queued', runnerLabel }` and the page follows the
  // request until it starts / stops / fails / expires. The polls stop when the
  // page unmounts.
  const onRunRequestSettled = useCallback((o: RunRequestOutcome) => {
    if (o.kind === 'failed') {
      setActionError(runnerErrorBanner(o.errorCode, { runnerLabel: o.request.runnerLabel }));
      return;
    }
    if (o.kind === 'lost') {
      // The page could not READ the request any more — its outcome is unknown.
      const what = o.request.action === 'start' ? 'Re-run' : 'Stop';
      setActionError(`Could not follow the ${what} request: ${formatError(o.error, 'its status could not be read')}. It may still go ahead — check the Runs tab before trying again.`);
      setTimeout(loadExecutions, REFETCH_DELAY_MS);
      return;
    }
    if (o.kind === 'finished') {
      const what = o.executionId ? `Execution ${o.executionId}` : 'Execution';
      const st = o.executionStatus.toLowerCase();
      if (st === 'succeeded') toast.success(`${what} succeeded`);
      else toast.warning(`${what} ${st}`);
      setTimeout(loadExecutions, REFETCH_DELAY_MS);
      return;
    }
    toast.success(o.kind === 'started'
      ? `Started execution ${o.executionId ?? ''}`.trim()
      : 'Execution canceled');
    setTimeout(loadExecutions, REFETCH_DELAY_MS);
  }, [toast, loadExecutions]);
  const runRequests = useRunRequestTracker(id, onRunRequestSettled);
  const { track: trackRunRequest } = runRequests;
  const startQueued = runRequests.active.some((r) => r.action === 'start' && r.phase === 'queued');

  const trigger = useMutation({
    fn: async (pipelineId: string, runnerId?: string | null) => {
      const res = runnerId ? await api.triggerPipelineExecution(pipelineId, { runnerId }) : await api.triggerPipelineExecution(pipelineId);
      if (!res.success) throw new Error(res.message || 'Failed to trigger execution');
      return res.data;
    },
    scopeKey: id,
    errorFallback: 'Failed to trigger execution',
    onSuccess: (data) => {
      if (data) trackRunRequest(data, 'start');
    },
    onError: reportActionError,
  });
  const triggering = trigger.pending || startQueued;
  const { run: runTrigger } = trigger;
  /**
   * Run pipeline, by where the pipeline stands:
   *  - registered and linked to a runner (or a link check running) → run;
   *  - not registered → Register and run: register it with a runner, then run
   *    once that runner finds it;
   *  - registered, no runner linked → choose the runner to run it with.
   * When the registration or the link can't be read, it just runs (the server
   * finds the runner).
   */
  const registration = pipeline?.registration;
  const link = runnerLink.link;
  const handleTrigger = useCallback(async () => {
    if (!id) return;
    setActionError(null);
    if (registration && !registration.registered && can('pipeline_registry:write')) {
      setRunAfterRegister(true);
      setShowRegister(true);
      return;
    }
    if (registration?.registered && link && link.status !== 'checking' && !(link.status === 'linked' && link.runner)) {
      setShowRunWith(true);
      return;
    }
    await runTrigger(id);
  }, [id, runTrigger, registration, link, can]);
  const runWith = useCallback(async (runnerId: string | null) => {
    if (!id) return;
    setShowRunWith(false);
    await runTrigger(id, runnerId);
    void runnerLink.refetch();
  }, [id, runTrigger, runnerLink]);

  const cancelExecution = useMutation({
    fn: async (pipelineId: string, executionId: string) => {
      const res = await api.stopPipelineExecution(pipelineId, executionId, { reason: 'Canceled from dashboard' });
      if (!res.success) throw new Error(res.message || 'Failed to cancel execution');
      return res.data;
    },
    scopeKey: id,
    errorFallback: 'Failed to cancel execution',
    onSuccess: (data) => {
      if (data) trackRunRequest(data, 'stop');
    },
    onError: reportActionError,
  });
  const canceling = cancelExecution.pending;
  const { run: runCancel } = cancelExecution;
  const confirmCancel = useCallback(async () => {
    if (!id || !cancelTarget) return;
    setActionError(null);
    await runCancel(id, cancelTarget);
    setCancelTarget(null);
  }, [id, cancelTarget, runCancel]);

  const [showDelete, setShowDelete] = useState(false);
  // Register deployment opens here (not on the Deployments page) for a pipeline with no registration.
  const [showRegister, setShowRegister] = useState(false);
  // Run pipeline on an unregistered pipeline: register it with a runner, then run.
  const [runAfterRegister, setRunAfterRegister] = useState(false);
  // Run pipeline on a registered pipeline no runner is linked to: choose the runner to run with.
  const [showRunWith, setShowRunWith] = useState(false);
  const [actionError, setActionError] = useState<ReactNode>(null);

  const deletion = useMutation({
    fn: async (pipelineId: string) => {
      const res = await api.deletePipeline(pipelineId);
      if (!res.success) throw new Error(res.message || 'Delete failed');
    },
    scopeKey: id,
    // Every cached pipeline list still holds the deleted row — drop them
    // before landing on the list page.
    invalidates: ['pipelines'],
    errorFallback: 'Failed to delete pipeline',
    onSuccess: () => {
      toast.success('Pipeline deleted');
      void router.push('/dashboard/pipelines');
    },
    onError: reportActionError,
  });
  const deleting = deletion.pending;
  const { run: runDelete } = deletion;
  const confirmDelete = useCallback(async () => {
    if (!pipeline) return;
    await runDelete(pipeline.id);
    setShowDelete(false);
  }, [pipeline, runDelete]);

  return {
    actionError,
    setActionError,
    reportActionError,
    runRequests,
    trigger,
    triggering,
    runTrigger,
    handleTrigger,
    runWith,
    cancelTarget,
    setCancelTarget,
    canceling,
    confirmCancel,
    showDelete,
    setShowDelete,
    deleting,
    confirmDelete,
    showRegister,
    setShowRegister,
    runAfterRegister,
    setRunAfterRegister,
    showRunWith,
    setShowRunWith,
  };
}
