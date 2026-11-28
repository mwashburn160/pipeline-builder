// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import { formatError } from '@/lib/constants';
import { PIPELINE_RUNNERS_HREF, RUNNERS_UNAVAILABLE_COPY, runnerErrorCopy } from '@/lib/pipeline-runners';
import type { PipelineDeployment, RegisterRunnersDto, RunnerLinkDto, RunnerLinkStatus } from '@/lib/api/domains/pipelines';
import type { Pipeline } from '@/types';

/** The pipeline fields the register form needs — the page drains the rest. */
export type PipelineConfig = Pick<Pipeline, 'pipelineName' | 'project' | 'organization' | 'id'>;

export type RegisterRunner = RegisterRunnersDto['runners'][number];

/** How often, and how many times, the dialog reads the link probe's outcome. */
export const LINK_POLL_MS = 2000;
export const LINK_POLL_TRIES = 30;

/** A runner's name as the dialog shows it (a parent org's shared runner names that org). */
export function runnerName(r: Pick<RegisterRunner, 'label' | 'isOwn' | 'ownerOrgName'>): string {
  return !r.isOwn && r.ownerOrgName ? `${r.label} (shared by ${r.ownerOrgName})` : r.label;
}

/** What the dialog says once the registration landed and the link probe settled (or was given up on). */
interface LinkOutcome { variant: 'success' | 'warning' | 'info'; title: string; body?: string }

/** The registered state: the row, and the runner the link probe asked (null: every eligible one). */
interface Registered { row: PipelineDeployment; runnerLink: RunnerLinkStatus | null; picked: RegisterRunner | null }

/**
 * The sentence for a settled link probe. A picked runner that missed while the
 * pipeline stays linked to another one says so — the server keeps that link.
 */
export function linkOutcome(link: Pick<RunnerLinkDto, 'status' | 'runner' | 'detail'>, picked: Pick<RegisterRunner, 'id' | 'label'> | null): LinkOutcome {
  const pickedName = picked?.label ?? 'No pipeline runner';
  if (link.status === 'linked' && link.runner) {
    if (picked && link.runner.id !== picked.id) {
      return {
        variant: 'warning',
        title: `${picked.label} did not find this pipeline in its AWS account.`,
        body: `It stays linked to ${link.runner.label}, which runs still go through.`,
      };
    }
    return { variant: 'success', title: `Registered and linked to ${link.runner.label}.`, body: 'Runs started here go straight to it.' };
  }
  const code = link.detail?.errorCode;
  if (link.status === 'ambiguous') {
    const c = runnerErrorCopy(code ?? 'AMBIGUOUS_RUNNER');
    return { variant: 'warning', title: `Registered, but not linked: ${c.title}`, body: c.body };
  }
  if (code && code !== 'PIPELINE_NOT_FOUND' && code !== 'NO_RUNNER') {
    const c = runnerErrorCopy(code);
    return { variant: 'warning', title: `Registered, but not linked: ${c.title}`, body: c.body };
  }
  return {
    variant: 'warning',
    title: `Registered, but ${pickedName} did not find this pipeline in its AWS account.`,
    body: 'Its reports start with its first pipeline event. Check that it was deployed into that runner\'s account; Run looks for its runner again on the next run.',
  };
}

/**
 * Modal to register (upsert) a deployment for one of the org's pipelines, with
 * the pipeline runner to link it through:
 *  - exactly one runner (e.g. only `default`) → asks to register with it;
 *  - several → lists them and asks which one (an unreachable one can't be picked);
 *  - none, runners paused, or the list can't be read → says which, and
 *    registers without one (a runner links it when it finds the pipeline).
 * A never-deployed pipeline is steered to Deploy: registering it would make the
 * dashboard treat it as deployed. After registering, the dialog follows the
 * link probe and says whether the runner found the pipeline.
 */
export function RegisterDeploymentModal({
  configs, onClose, onRegistered, initialPipelineId, lockPipeline = false, onDeployInstead, onLinked,
}: {
  configs: PipelineConfig[];
  onClose: () => void;
  /** Called once the registration landed (the dialog stays open to show the link outcome). */
  onRegistered: (row: PipelineDeployment) => void;
  /** The pipeline the form opens on (the pipeline page's Register deployment link). */
  initialPipelineId?: string;
  /** Show the pipeline as text, not a picker (opened from that pipeline's page). */
  lockPipeline?: boolean;
  /** "Deploy it instead" for a never-deployed pipeline; default: a link to its page. */
  onDeployInstead?: () => void;
  /**
   * Register and run (Run pipeline on an unregistered pipeline): called once the
   * registration linked the pipeline to the chosen runner — the caller starts
   * the run. Not called when no runner linked it; the dialog says why.
   */
  onLinked?: () => void;
}) {
  const uid = useId();
  const [pipelineId, setPipelineId] = useState(initialPipelineId ?? '');
  const [region, setRegion] = useState('');
  const [regionTouched, setRegionTouched] = useState(false);
  const [stackName, setStackName] = useState('');
  const [pickedRunner, setPickedRunner] = useState<string | null>(null);
  const [deployedElsewhere, setDeployedElsewhere] = useState(false);
  const [registered, setRegistered] = useState<Registered | null>(null);

  const selected = configs.find((c) => c.id === pipelineId);

  const info = useFetch(
    async (signal) => (await api.getRegisterRunners(pipelineId, { signal })).data ?? null,
    [pipelineId],
    { enabled: !!pipelineId },
  );
  const facts = info.data;
  const loadingFacts = !!pipelineId && info.loading && !facts;
  const neverDeployed = !!facts && !facts.registered && !facts.hasEvents;
  const runners: RegisterRunner[] = facts?.available ? facts.runners : [];
  const usable = runners.filter((r) => r.health === 'healthy');
  const linked = usable.find((r) => r.id === facts?.linkedRunnerId) ?? null;
  // The pick, else the runner it is linked to now, else the only one that can answer.
  const runner = usable.find((r) => r.id === pickedRunner) ?? linked ?? (usable.length === 1 ? usable[0] : null);
  const needsPick = usable.length > 1 && !runner;
  const blockedNeverDeployed = neverDeployed && !deployedElsewhere;
  const effectiveRegion = regionTouched ? region : (runner?.regions.length === 1 ? runner.regions[0] : region);

  const register = useMutation({
    fn: async (config: PipelineConfig, picked: RegisterRunner | null) => {
      const res = await api.registerPipelineDeployment({
        pipelineId: config.id,
        pipelineName: config.pipelineName || config.id,
        ...(effectiveRegion.trim() ? { region: effectiveRegion.trim() } : {}),
        ...(config.project ? { project: config.project } : {}),
        ...(config.organization ? { organization: config.organization } : {}),
        ...(stackName.trim() ? { stackName: stackName.trim() } : {}),
        ...(picked ? { runnerId: picked.id } : {}),
      });
      if (!res.success || !res.data) throw new Error(res.message || 'Failed to register deployment');
      return { row: res.data.registry, runnerLink: res.data.runnerLink ?? null, picked };
    },
    errorFallback: 'Failed to register deployment',
    onSuccess: (r) => { setRegistered(r); onRegistered(r.row); },
  });
  const { pending: submitting, error: err, setError: setErr } = register;

  const handleSubmit = async () => {
    setErr(null);
    if (!pipelineId) {
      setErr('Select a pipeline to register.');
      return;
    }
    if (!selected) {
      setErr('Selected pipeline is no longer available. Refresh and try again.');
      return;
    }
    if (blockedNeverDeployed) {
      setErr('This pipeline is not deployed yet. Deploy it instead, or confirm it was deployed another way.');
      return;
    }
    if (needsPick) {
      setErr('Choose the pipeline runner to register this pipeline with.');
      return;
    }
    await register.run(selected, runner);
  };

  if (registered) {
    return <RegisteredStep pipelineId={pipelineId} registered={registered} onClose={onClose} onLinked={onLinked} />;
  }

  const andRun = onLinked ? ' and run' : '';
  const submitLabel = submitting ? 'Registering…' : runner ? `Register with ${runner.label}${andRun}` : `Register${andRun}`;
  const pipelineLabel = selected?.pipelineName || pipelineId;

  return (
    <Modal
      title={onLinked ? 'Register and run' : 'Register deployment'}
      onClose={() => submitting ? undefined : onClose()}
      maxWidth="max-w-lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting || !pipelineId || loadingFacts || needsPick || blockedNeverDeployed}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        {onLinked && (
          <p className="text-fg-muted">
            This pipeline isn&apos;t registered, so its runs aren&apos;t recorded. Register it with a pipeline runner; it runs once that runner finds it.
          </p>
        )}
        {lockPipeline && selected ? (
          <p className="text-fg">Pipeline: <strong>{pipelineLabel}</strong></p>
        ) : (
          <div>
            <label className="label" htmlFor={`${uid}-pipeline`}>Pipeline</label>
            <Select
              id={`${uid}-pipeline`}
              value={pipelineId}
              onChange={(e) => { setPipelineId(e.target.value); setPickedRunner(null); setDeployedElsewhere(false); setErr(null); }}
              disabled={submitting}
            >
              <option value="">Select a pipeline…</option>
              {configs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.pipelineName || c.id}{c.project ? ` — ${c.project}` : ''}
                </option>
              ))}
            </Select>
            {configs.length === 0 && (
              <p className="text-xs text-fg-muted mt-1">
                No pipeline configurations found. Create a pipeline first.
              </p>
            )}
          </div>
        )}

        {pipelineId && neverDeployed && (
          <Callout variant="warning" title="This pipeline is not deployed yet.">
            <p>
              Registering does not deploy it, and once it is registered the dashboard treats it as deployed: it can no
              longer be deployed through a pipeline runner from here. Register it only if it was deployed another way
              (CDK, CI).
            </p>
            <p className="mt-2">
              {onDeployInstead
                ? <Button type="button" size="sm" variant="secondary" onClick={onDeployInstead}>Deploy it instead</Button>
                : <Link href={`/dashboard/pipelines/${encodeURIComponent(pipelineId)}`} className="action-link">Deploy it instead</Link>}
            </p>
            <label className="mt-2 flex items-center gap-2">
              <Checkbox checked={deployedElsewhere} onChange={(e) => { setDeployedElsewhere(e.target.checked); setErr(null); }} disabled={submitting} />
              It was deployed another way (CDK, CI)
            </label>
          </Callout>
        )}

        {pipelineId && (
          <div data-testid="register-runner">
            <RunnerChoice
              mode="register"
              uid={uid}
              loading={loadingFacts}
              error={info.error && !facts ? formatError(info.error, 'Could not load the pipeline runners') : null}
              onRetry={info.refetch}
              facts={facts}
              runners={runners}
              usable={usable}
              runner={runner}
              pipelineLabel={pipelineLabel}
              onPick={(id) => { setPickedRunner(id); setErr(null); }}
              disabled={submitting}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor={`${uid}-region-optional`}>Region <span className="text-fg-subtle">(optional)</span></label>
            <Input
              id={`${uid}-region-optional`}
              type="text"
              value={effectiveRegion}
              onChange={(e) => { setRegion(e.target.value); setRegionTouched(true); }}
              placeholder="us-east-1"
              className="text-sm"
              list={runner && runner.regions.length > 1 ? `${uid}-regions` : undefined}
              disabled={submitting}
            />
            {runner && runner.regions.length > 1 && (
              <datalist id={`${uid}-regions`}>
                {runner.regions.map((r) => <option key={r} value={r} />)}
              </datalist>
            )}
          </div>
          <div>
            <label className="label" htmlFor={`${uid}-stack-name-optional`}>Stack name <span className="text-fg-subtle">(optional)</span></label>
            <Input
              id={`${uid}-stack-name-optional`}
              type="text"
              value={stackName}
              onChange={(e) => setStackName(e.target.value)}
              placeholder="my-pipeline-stack"
              className="text-sm"
              disabled={submitting}
            />
          </div>
        </div>
        <p className="text-xs text-fg-muted">
          Registering maps this pipeline&apos;s stable id to its deployment so execution events report against it, and links it to the chosen runner once that runner finds it in its AWS account. Re-registering the same pipeline updates the existing record.
        </p>
        {err && (
          <ErrorAlert message={err} />
        )}
      </div>
    </Modal>
  );
}

/** The wording of {@link RunnerChoice} for registering, or for running with a runner. */
const CHOICE_COPY = {
  register: {
    verb: 'Register',
    choose: 'Choose the pipeline runner to register this pipeline with.',
    readFailed: 'You can still register it without a runner; one links it when it finds the pipeline.',
    unavailable: 'No pipeline runner can link it right now, so it registers without one; a runner links it once runners are back.',
    none: 'Your organization has no pipeline runner, so it registers without one.',
    onlyDown: (label: string) => `It registers without a runner; ${label} links it once it answers again.`,
    allDown: 'Every runner is unreachable: it registers without one, and a runner links it once it answers again.',
  },
  run: {
    verb: 'Run',
    choose: 'No pipeline runner is linked to this pipeline. Choose the one to run it with; it is linked once it finds the pipeline.',
    readFailed: 'You can still run it: every pipeline runner is asked to find it.',
    unavailable: 'Runs are paused until runners are back.',
    none: 'Your organization has no pipeline runner to run it with.',
    onlyDown: (label: string) => `Runs through ${label} are paused until it answers again.`,
    allDown: 'Every runner is unreachable: runs are paused until one answers again.',
  },
} as const;

/** Whether {@link RunnerChoice} leaves nothing to run with (runners paused, none, or none reachable). */
export function noRunnerToRun(facts: RegisterRunnersDto | null): boolean {
  if (!facts) return false;
  return !facts.available || !facts.runners.some((r) => r.health === 'healthy');
}

/** The runner part of a form: ask about the only runner, list several, or say why there is none. */
export function RunnerChoice({ mode, uid, loading, error, onRetry, facts, runners, usable, runner, pipelineLabel, onPick, disabled }: {
  mode: keyof typeof CHOICE_COPY;
  uid: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  facts: RegisterRunnersDto | null;
  runners: RegisterRunner[];
  usable: RegisterRunner[];
  runner: RegisterRunner | null;
  pipelineLabel: string;
  onPick: (id: string) => void;
  disabled: boolean;
}): ReactNode {
  const copy = CHOICE_COPY[mode];
  if (loading) {
    return <p className="flex items-center gap-2 text-fg-muted"><LoadingSpinner size="sm" label={null} /> Finding pipeline runners…</p>;
  }
  if (error) {
    return (
      <div className="space-y-1">
        <RetryError message={error} onRetry={onRetry} />
        <p className="text-xs text-fg-muted">{copy.readFailed}</p>
      </div>
    );
  }
  if (!facts) return null;
  if (!facts.available) {
    const c = RUNNERS_UNAVAILABLE_COPY[facts.unavailableReason ?? 'paused'];
    return (
      <Callout variant="warning" title={c.title}>
        <p>{copy.unavailable}</p>
      </Callout>
    );
  }
  if (runners.length === 0) {
    return (
      <p className="text-xs text-fg-muted">
        {copy.none}{' '}
        <Link href={PIPELINE_RUNNERS_HREF} className="action-link">Set up a pipeline runner</Link>
      </p>
    );
  }
  if (runners.length === 1) {
    const only = runners[0];
    if (only.health !== 'healthy') {
      return (
        <Callout variant="warning" title={`The pipeline runner ${runnerName(only)} is unreachable.`}>
          <p>{copy.onlyDown(only.label)}</p>
        </Callout>
      );
    }
    return (
      <p className="text-fg">
        {copy.verb} <strong>{pipelineLabel}</strong> with the pipeline runner <strong>{runnerName(only)}</strong>?
      </p>
    );
  }
  return (
    <fieldset className="space-y-2">
      <legend className="label">Pipeline runner</legend>
      <p className="text-xs text-fg-muted">{copy.choose}</p>
      {runners.map((r) => {
        const down = r.health !== 'healthy';
        return (
          <label key={r.id} className={`flex items-center gap-2${down ? ' text-fg-subtle' : ''}`}>
            <input
              type="radio"
              name={`${uid}-runner`}
              value={r.id}
              checked={runner?.id === r.id}
              onChange={() => onPick(r.id)}
              disabled={disabled || down}
            />
            {runnerName(r)}{down ? ' — unreachable' : ''}{r.id === facts.linkedRunnerId ? ' — linked now' : ''}
          </label>
        );
      })}
      {usable.length === 0 && (
        <p className="text-xs text-warning">{copy.allDown}</p>
      )}
    </fieldset>
  );
}

/** After registering: follow the link probe until it settles, then say what it found. */
function RegisteredStep({ pipelineId, registered, onClose, onLinked }: { pipelineId: string; registered: Registered; onClose: () => void; onLinked?: () => void }) {
  const { runnerLink, picked } = registered;
  const [outcome, setOutcome] = useState<LinkOutcome | null>(() => {
    if (runnerLink === 'checking') return null;
    if (runnerLink === 'linked') return { variant: 'success', title: picked ? `Registered and linked to ${picked.label}.` : 'Registered; it was already linked to its runner.' };
    return { variant: 'info', title: 'Registered.', body: 'No pipeline runner was asked to link it now; one links it when it finds the pipeline.' };
  });

  useEffect(() => {
    if (runnerLink !== 'checking') return undefined;
    const ctrl = new AbortController();
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = () => setOutcome({ variant: 'info', title: 'Registered. The runner is still looking for it.', body: 'The pipeline page shows the outcome.' });
    const poll = async () => {
      tries += 1;
      try {
        const res = await api.getPipelineRunnerLink(pipelineId, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        const link = res.data;
        if (link && link.status !== 'checking') {
          setOutcome(linkOutcome(link, picked));
          return;
        }
      } catch {
        if (ctrl.signal.aborted) return;
        giveUp();
        return;
      }
      if (tries >= LINK_POLL_TRIES) { giveUp(); return; }
      timer = setTimeout(() => { void poll(); }, LINK_POLL_MS);
    };
    timer = setTimeout(() => { void poll(); }, LINK_POLL_MS);
    return () => { ctrl.abort(); if (timer) clearTimeout(timer); };
  }, [pipelineId, runnerLink, picked]);

  // Register and run: start the run once the chosen runner linked it (once).
  const linkedNow = outcome?.variant === 'success';
  const onLinkedRef = useRef(onLinked);
  useEffect(() => { onLinkedRef.current = onLinked; });
  const ran = useRef(false);
  useEffect(() => {
    if (!linkedNow || ran.current || !onLinkedRef.current) return;
    ran.current = true;
    onLinkedRef.current();
  }, [linkedNow]);

  return (
    <Modal
      title={onLinked ? 'Register and run' : 'Register deployment'}
      onClose={onClose}
      maxWidth="max-w-lg"
      footer={<div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>}
    >
      <div className="space-y-3 text-sm" data-testid="register-outcome">
        {outcome ? (
          <Callout variant={outcome.variant} title={outcome.title}>{outcome.body}</Callout>
        ) : (
          <p className="flex items-center gap-2 text-fg" role="status">
            <LoadingSpinner size="sm" label={null} />
            Registered. Checking whether {picked ? picked.label : 'a pipeline runner'} finds it in its AWS account…
          </p>
        )}
      </div>
    </Modal>
  );
}
