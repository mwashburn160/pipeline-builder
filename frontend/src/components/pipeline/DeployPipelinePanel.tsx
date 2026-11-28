// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, CircleDot, Rocket, XCircle } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { FormField } from '@/components/ui/FormField';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { Select } from '@/components/ui/Select';
import { TAP_TARGET } from '@/components/ui/responsive';
import { useFetch } from '@/hooks/useFetch';
import { useDeployRequestTracker } from '@/hooks/useDeployRequestTracker';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import type { DeployRequestDto, DeployTargetsDto, QueuedDeployDto } from '@/lib/api/domains/pipelines';
import { ApiError, MfaRequiredError, stepUpReplayFailed } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import {
  DEPLOY_SETUP_COMMAND, DEPLOY_STATUS_LABEL, DEPLOY_TARGET_REASON_COPY, deployFailureCopy, deployStageSteps,
  deployTargetLabel, isActiveDeployStatus, logHintGuidance,
} from '@/lib/pipeline-deploys';
import { isRunnerError, PIPELINE_RUNNERS_HREF, RUNNERS_UNAVAILABLE_COPY, runnerErrorCopy } from '@/lib/pipeline-runners';

type TargetRunner = DeployTargetsDto['runners'][number];

/** What the step-up dialog will send. */
interface DeployChoice { runnerId: string; region: string; label: string }

/**
 * The sentence a refused deploy write shows: a runner / deploy catalog code
 * reads its copy; any other refusal (compliance, validation, a toolchain
 * error) reads the server's own message.
 */
function deployWriteErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof MfaRequiredError) return ''; // The shell shows its own dialog.
  if (isRunnerError(e)) {
    const c = runnerErrorCopy(e.code, e.details?.reason);
    return `${c.title} ${c.body}`;
  }
  return formatError(e, fallback);
}
const startErrorMessage = (e: unknown) => deployWriteErrorMessage(e, 'Could not start the deploy');
const cancelErrorMessage = (e: unknown) => deployWriteErrorMessage(e, 'Could not cancel the deploy');

/** Why the page stopped following a deploy: past its deadline, or a refused read of its progress. */
function lostMessage(lost: unknown): string {
  if (lost instanceof ApiError) return `Could not read this deploy's progress: ${lost.message.replace(/\.?$/, '.')} Reload the page to see its result.`;
  return 'It is taking longer than its deadline. Reload the page to see its result.';
}

/** The deploy's stages as an ordered list: done, current, pending (or the one it failed in). */
function StageSteps({ deploy }: { deploy: DeployRequestDto }) {
  const steps = deployStageSteps(deploy.stage, deploy.status);
  return (
    <ol className="space-y-1 text-sm" data-testid="deploy-stage-steps" aria-label="Deploy steps">
      {steps.map((s) => (
        <li key={s.stage} className="flex items-center gap-2" aria-current={s.state === 'current' ? 'step' : undefined}>
          {s.state === 'done' && <CheckCircle2 className="w-4 h-4 text-success" aria-hidden="true" />}
          {s.state === 'current' && <CircleDot className="w-4 h-4 text-brand" aria-hidden="true" />}
          {s.state === 'pending' && <Circle className="w-4 h-4 text-fg-subtle" aria-hidden="true" />}
          {s.state === 'failed' && <XCircle className="w-4 h-4 text-danger" aria-hidden="true" />}
          <span className={s.state === 'pending' ? 'text-fg-subtle' : 'text-fg'}>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** Why no eligible runner can deploy, the setup command, and where runners are managed. */
function NoDeployableRunner({ targets }: { targets: DeployTargetsDto }) {
  // The setup command only helps a runner that has deploys off or is outdated
  // (or when there is none). For e.g. a prefix mismatch, deploys are already on:
  // offering `--enable-deploy` again sent operators to re-run a setup that
  // changes nothing — each runner's reason line says what to do instead.
  const setupHelps = targets.runners.length === 0
    || targets.runners.some((r) => !r.reason || r.reason === 'deploy_not_enabled' || r.reason === 'update_required');
  return (
    <Callout variant="warning" title="No pipeline runner can deploy this pipeline.">
      {targets.runners.length === 0 ? (
        <p>Your organization has no pipeline runner that serves this pipeline. A runner in your AWS account deploys pipelines into that account once deploys are enabled on it.</p>
      ) : (
        <ul className="list-disc ml-5 space-y-0.5" data-testid="deploy-no-runner-reasons">
          {targets.runners.map((r) => (
            <li key={r.id}>
              <strong>{r.label}</strong>{!r.isOwn && r.ownerOrgName ? ` (shared by ${r.ownerOrgName})` : ''}: {r.reason ? DEPLOY_TARGET_REASON_COPY[r.reason] : 'It cannot deploy this pipeline'}.
            </li>
          ))}
        </ul>
      )}
      {setupHelps && (
        <>
          <p className="mt-2">Turn deploys on for a runner by re-running its setup in the runner&apos;s AWS account:</p>
          <CodeBlock code={targets.setupCommand || DEPLOY_SETUP_COMMAND} language="bash" />
        </>
      )}
      <p className="mt-1"><Link href={PIPELINE_RUNNERS_HREF} className="action-link">Manage pipeline runners</Link></p>
    </Callout>
  );
}

/**
 * Deploy a never-deployed pipeline through a pipeline runner: the runner's
 * CodeBuild deploy job deploys it into the runner's AWS account and registers
 * it. Runner states:
 *  - none deployable → why (each eligible runner's reason) + the setup command;
 *  - exactly one → pre-selected, one "Deploy to <label> (<region>)" button;
 *  - several → a dropdown (non-deployable ones disabled with their reason).
 * A region select appears when the chosen runner allows several. Every start
 * goes through ONE StepUpModal (the route is step-up gated and MFA-grade).
 * The deploy is then followed (stage steps, Cancel), and a failure reads its
 * code's copy, next steps and where the build log is, with Retry / Change
 * runner when it is retryable. The latest deploy is resumed on mount.
 */
export function DeployPipelinePanel({ pipelineId, onDeployed, className = '' }: {
  pipelineId: string;
  /** Called once when a deploy followed here finishes deployed. */
  onDeployed?: () => void;
  className?: string;
}) {
  const targets = useFetch(
    async (signal) => (await api.getDeployTargets(pipelineId, { signal })).data ?? null,
    [pipelineId],
  );
  const onDeployedRef = useRef(onDeployed);
  useEffect(() => { onDeployedRef.current = onDeployed; });
  const tracker = useDeployRequestTracker(pipelineId, {
    onSettled: (d) => { if (d.status === 'deployed') onDeployedRef.current?.(); },
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedRegion, setPickedRegion] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DeployChoice | null>(null);
  // The deploy a cancel was accepted for (a running one keeps running until its build stops).
  const [cancelRequested, setCancelRequested] = useState<string | null>(null);

  const t = targets.data;
  const { deploy, follow } = tracker;

  // The targets name an active deploy the latest read did not (a race with another tab): follow it —
  // ONCE per id. The targets are a snapshot: after that deploy ends, Change runner / Retry must not
  // send the panel back to it.
  const activeId = t?.activeRequestId ?? null;
  const autoFollowed = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId || !tracker.resumed || autoFollowed.current === activeId) return;
    autoFollowed.current = activeId;
    if (deploy?.requestId !== activeId) follow(activeId);
  }, [activeId, tracker.resumed, deploy?.requestId, follow]);

  const deployable = useMemo(() => (t?.runners ?? []).filter((r) => r.deployable), [t]);
  const runnerId = picked ?? (deployable.length === 1 ? deployable[0].id : null);
  const selected: TargetRunner | null = deployable.find((r) => r.id === runnerId) ?? null;
  const region = selected ? (pickedRegion && selected.regions.includes(pickedRegion) ? pickedRegion : selected.regions[0] ?? null) : null;

  // A refusal of the start that names the deploy already running: follow it instead. True when handled.
  const followRunning = (e: unknown): boolean => {
    if (!(e instanceof ApiError) || e.code !== 'DEPLOY_IN_PROGRESS' || typeof e.details?.requestId !== 'string') return false;
    startDeploy.reset();
    follow(e.details.requestId);
    return true;
  };

  const startDeploy = useMutation({
    fn: async (choice: DeployChoice, stepUpToken: string) => {
      const res = await api.startPipelineDeploy(pipelineId, { runnerId: choice.runnerId, region: choice.region }, stepUpToken);
      if (!res.success || !res.data) throw new Error(res.message || 'The deploy was refused');
      return res.data;
    },
    scopeKey: pipelineId,
    formatError: startErrorMessage,
    onSuccess: (queued, choice) => { cancelDeploy.reset(); tracker.track(queued, choice.runnerId); },
    onStepUpResumed: (replay, choice) => {
      const queued = (replay as { data?: QueuedDeployDto } | undefined)?.data;
      if (queued) { cancelDeploy.reset(); tracker.track(queued, choice.runnerId); }
    },
    onError: (e) => {
      if (followRunning(e)) return;
      if (e instanceof ApiError && (e.code === 'DEPLOY_RUNNER_REQUIRED' || e.code === 'RUNNER_NOT_DEPLOYABLE')) void targets.refetch();
    },
    // The global dialog toasts a failed replay; one that names the running deploy is followed too.
    onStepUpAbandoned: (reason) => { if (stepUpReplayFailed(reason)) followRunning(reason); },
  });
  const startError = startDeploy.error || null;

  const cancelDeploy = useMutation({
    fn: async (d: DeployRequestDto) => {
      const res = await api.cancelPipelineDeploy(pipelineId, d.requestId);
      if (!res.success) throw new Error(res.message || 'The cancel was refused');
      return res.data;
    },
    scopeKey: pipelineId,
    formatError: cancelErrorMessage,
    // The answer is the deploy as it is now: a queued one is already cancelled, a running one
    // stops once its build has. Show it at once rather than at the next read.
    onSuccess: (d) => {
      if (!d || typeof d.requestId !== 'string') return;
      setCancelRequested(d.requestId);
      follow(d.requestId, d);
    },
  });
  const cancelError = cancelDeploy.error || null;

  const changeRunner = () => { tracker.clear(); setPicked(null); startDeploy.reset(); cancelDeploy.reset(); void targets.refetch(); };

  let body: ReactNode;
  if (targets.error && !t) {
    body = <RetryError message={formatError(targets.error, 'Could not load the pipeline runners that can deploy this pipeline')} onRetry={targets.refetch} />;
  } else if (!t || !tracker.resumed || (!deploy && tracker.following)) {
    // The latest deploy, or one the server named, is still being read.
    body = <LoadingSpinner size="sm" />;
  } else if (deploy && isActiveDeployStatus(deploy.status)) {
    const cancelAccepted = cancelRequested === deploy.requestId;
    body = (
      <div className="space-y-3" data-testid="deploy-progress">
        <p className="text-sm text-fg flex flex-wrap items-center gap-x-2 gap-y-1 break-words" role="status">
          <LoadingSpinner size="sm" label={null} />
          {DEPLOY_STATUS_LABEL[deploy.status]}: <strong>{deployTargetLabel({ label: deploy.runnerLabel, isOwn: true, ownerOrgName: null }, deploy.region)}</strong>
        </p>
        <StageSteps deploy={deploy} />
        {tracker.lost != null && (
          <Callout variant="warning">{lostMessage(tracker.lost)}</Callout>
        )}
        {cancelError && <Callout variant="danger">{cancelError}</Callout>}
        {cancelAccepted && <p className="text-sm text-fg-muted" role="status">Cancel requested: the runner is stopping the build.</p>}
        <Button type="button" size="sm" variant="danger-outline" className={`max-sm:w-full ${TAP_TARGET}`} disabled={cancelDeploy.pending || cancelAccepted} onClick={() => void cancelDeploy.run(deploy)}>
          Cancel deploy
        </Button>
      </div>
    );
  } else if (deploy && deploy.status === 'deployed') {
    body = (
      <Callout variant="success" title={`Deployed to ${deploy.runnerLabel} (${deploy.region}).`}>
        The pipeline is deployed and registered: its runs, reports and DORA metrics start from its first execution.
      </Callout>
    );
  } else if (deploy && (deploy.status === 'failed' || deploy.status === 'expired' || deploy.status === 'cancelled')) {
    const copy = deployFailureCopy(deploy.errorCode, deploy.failureClass);
    const retryable = deploy.retryable || deploy.status === 'cancelled' || deploy.status === 'expired';
    const retryRunner = deployable.find((r) => r.id === deploy.runnerId);
    body = (
      <div className="space-y-3" data-testid="deploy-failure">
        <Callout variant={deploy.status === 'cancelled' ? 'neutral' : 'danger'} title={copy.title}>
          <p>{copy.body}</p>
          <ul className="list-disc ml-5 mt-1">
            {copy.nextSteps.map((s) => <li key={s}>{s}</li>)}
          </ul>
          {copy.link === 'runners' && <p className="mt-1"><Link href={PIPELINE_RUNNERS_HREF} className="action-link">Pipeline runners settings</Link></p>}
          {deploy.logHint && (
            <p className="mt-2 text-xs" data-testid="deploy-log-hint">{logHintGuidance(deploy.logHint)}</p>
          )}
        </Callout>
        <StageSteps deploy={deploy} />
        {startError && <Callout variant="danger">{startError}</Callout>}
        <div className="flex flex-wrap gap-2">
          {retryable && retryRunner && (
            <Button type="button" size="sm" className={`max-sm:flex-1 ${TAP_TARGET}`} onClick={() => setConfirm({ runnerId: retryRunner.id, region: deploy.region, label: deployTargetLabel(retryRunner, deploy.region) })}>
              Retry on {deploy.runnerLabel}
            </Button>
          )}
          <Button type="button" size="sm" variant="secondary" className={`max-sm:flex-1 ${TAP_TARGET}`} onClick={changeRunner}>
            {retryable ? 'Change runner' : 'Deploy again once fixed'}
          </Button>
        </div>
      </div>
    );
  } else if (!t.available) {
    const c = RUNNERS_UNAVAILABLE_COPY[t.unavailableReason ?? 'paused'];
    body = <Callout variant="warning" title={c.title}>{c.body}</Callout>;
  } else if (t.alreadyDeployed) {
    body = <Callout variant="info">This pipeline is already deployed.</Callout>;
  } else if (deployable.length === 0) {
    body = <NoDeployableRunner targets={t} />;
  } else {
    // The button names the runner and region; the dialog also names a sharing org.
    const label = selected && region ? `${selected.label} (${region})` : null;
    body = (
      <div className="space-y-3">
        <p className="text-sm text-fg-muted">
          A pipeline runner deploys the pipeline into its own AWS account with that account&apos;s CDK bootstrap roles, then registers it.
        </p>
        {deployable.length > 1 && (
          <FormField label="Pipeline runner">
            <Select className="max-sm:text-base" value={runnerId ?? ''} onChange={(e) => { setPicked(e.target.value || null); setPickedRegion(null); }}>
              <option value="">Choose a runner…</option>
              {t.runners.map((r) => (
                <option key={r.id} value={r.id} disabled={!r.deployable}>
                  {r.label}{!r.isOwn && r.ownerOrgName ? ` (shared by ${r.ownerOrgName})` : ''}
                  {!r.deployable && r.reason ? ` — ${DEPLOY_TARGET_REASON_COPY[r.reason]}` : ''}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        {selected && selected.regions.length > 1 && (
          <FormField label="Region">
            <Select className="max-sm:text-base" value={region ?? ''} onChange={(e) => setPickedRegion(e.target.value)}>
              {selected.regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </FormField>
        )}
        {deployable.length === 1 && t.runners.length > 1 && (
          <p className="text-xs text-fg-subtle">
            {t.runners.filter((r) => !r.deployable).map((r) => `${r.label}: ${r.reason ? DEPLOY_TARGET_REASON_COPY[r.reason] : 'cannot deploy it'}`).join('; ')}.
          </p>
        )}
        {startError && <Callout variant="danger">{startError}</Callout>}
        {selected && region && label && (
          <Button type="button" size="sm" className={`max-sm:w-full ${TAP_TARGET}`} onClick={() => setConfirm({ runnerId: selected.id, region, label: deployTargetLabel(selected, region) })}>
            <Rocket className="w-4 h-4 mr-1 shrink-0" aria-hidden="true" />
            Deploy to {label}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={['space-y-2', className].filter(Boolean).join(' ')} data-testid="deploy-pipeline-panel">
      <h4 className="text-sm font-semibold text-fg">Deploy through a pipeline runner</h4>
      {/* A followed deploy that could not be read even once: there is nothing else to show it on. */}
      {!deploy && tracker.lost != null && <Callout variant="warning">{lostMessage(tracker.lost)}</Callout>}
      {body}
      {confirm && (
        <StepUpModal
          title={`Deploy to ${confirm.label}?`}
          action={`Deploy this pipeline through the pipeline runner ${confirm.label}`}
          details={(
            <p>
              The runner&apos;s deploy job synthesizes this pipeline and deploys it into the runner&apos;s AWS account
              ({confirm.region}) with that account&apos;s CDK bootstrap roles, then registers it here.
            </p>
          )}
          onConfirmed={async (stepUpToken) => { await startDeploy.run(confirm, stepUpToken); }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
