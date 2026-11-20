// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Server } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { HelpCodeBlock } from '@/components/help/HelpCodeBlock';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { CopyableId } from '@/components/ui/CopyableId';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { ToggleRow } from '@/components/ui/SettingRow';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import {
  RevokeConfirmField, RunnerSigningKeyCard, isKeyWrite, keyWriteSpec, revokeConfirmProblem, type KeyWrite,
} from '@/components/settings/RunnerSigningKeyCard';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import type {
  PipelineRunner,
  PipelineRunnersDto,
  PipelineRunnerTestResult,
  PipelineRunnerUpdate,
} from '@/lib/api/domains/pipelines';
import { ApiError, MfaRequiredError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import {
  ONE_RUNNER_PER_ACCOUNT_COPY,
  PIPELINE_RUNNERS_ANCHOR,
  RUNNER_UPDATE_COPY,
  asCidr,
  isLiveRunner,
  isRunnerError,
  runnerBadge,
  runnerErrorCopy,
  runnerTestFailureCopy,
  setupRunnerCommand,
} from '@/lib/pipeline-runners';
import { DEFAULT_SETUP_REGION, isAwsRegion } from '@/lib/setup-guide';

/** A step-up-gated write, held until the person confirms it's them. The
 *  step-up dialog IS the confirmation (one dialog per action). */
type RunnerWrite =
  | { kind: 'update'; runner: PipelineRunner; body: PipelineRunnerUpdate }
  | { kind: 'test'; runner: PipelineRunner }
  | { kind: 'revoke'; runner: PipelineRunner };
/** A runner write, or one to the org's signing key (the Signing key card). */
type PendingWrite = RunnerWrite | KeyWrite;

/** Turning sharing ON lets every team under this org run pipelines through the
 *  runner — the one write that WIDENS reach, so it needs an explicit tick. */
function pendingWidens(p: PendingWrite): boolean {
  return p.kind === 'update' && p.body.shareWithTeams === true && !p.runner.shareWithTeams;
}

type WriteKind = RunnerWrite['kind'];
type WriteOf<K extends WriteKind> = Extract<RunnerWrite, { kind: K }>;

/** Everything one kind of pending write needs: the call, and the step-up
 *  dialog's title, action line and consequence. */
interface WriteSpec<K extends WriteKind> {
  send: (p: WriteOf<K>, stepUpToken: string) => Promise<{ success: boolean; message?: string; data?: unknown }>;
  title: (p: WriteOf<K>) => string;
  action: (p: WriteOf<K>) => string;
  details: (p: WriteOf<K>) => ReactNode;
}

/** The runner-write catalog, keyed by `kind` — one entry per write (the key
 *  writes are the Signing key card's `KEY_WRITES`). */
const PENDING_WRITES: { [K in WriteKind]: WriteSpec<K> } = {
  update: {
    send: (p, stepUpToken) => api.updatePipelineRunner(p.runner.id, p.body, stepUpToken),
    title: (p) => {
      if (p.body.label !== undefined) return `Rename ${p.runner.label}?`;
      return p.body.shareWithTeams ? `Share ${p.runner.label} with teams?` : `Stop sharing ${p.runner.label} with teams?`;
    },
    action: (p) => `Update the pipeline runner ${p.runner.label}`,
    details: (p) => {
      if (p.body.label !== undefined) return <p>The runner will be called <strong>{p.body.label}</strong> everywhere it is shown, including its pipelines&apos; Deployment cards.</p>;
      return p.body.shareWithTeams
        ? <p>Teams will see this runner and use it for their pipelines in its AWS account.</p>
        : <p>Teams will no longer Re-run or Stop their pipelines through this runner; their links to it are cleared.</p>;
    },
  },
  test: {
    send: (p, stepUpToken) => api.testPipelineRunner(p.runner.id, stepUpToken),
    title: (p) => `Test ${p.runner.label}?`,
    action: (p) => `Send a test request to the pipeline runner ${p.runner.label}`,
    details: () => <p>The platform sends the runner a signed ping now. If it answers, paused deliveries resume.</p>,
  },
  revoke: {
    send: (p, stepUpToken) => api.revokePipelineRunner(p.runner.id, stepUpToken),
    title: (p) => `Revoke ${p.runner.label}?`,
    action: (p) => `Revoke the pipeline runner ${p.runner.label}`,
    details: (p) => (
      <p>
        Re-run and Stop will no longer reach pipelines through this runner{p.runner.shareWithTeams ? ', for this organization or its teams' : ''}.
        {p.runner.pipelineCount > 0 && <> <strong data-testid="runner-revoke-affected">{pipelinesCount(p.runner.pipelineCount)} linked to it will need another runner.</strong></>}
        {' '}Pending requests expire. This cannot be undone. The runner stack stays in
        your AWS account — remove it with <code>pipeline-manager infra setup-runner --delete</code>.
      </p>
    ),
  },
};

/** What the panel's one step-up dialog shows and sends for `p`. (The casts are
 *  TypeScript's correlated-union limit: indexing by `p.kind` loses the link
 *  between the key and `p`.) */
interface DialogSpec {
  send: (stepUpToken: string) => Promise<{ success: boolean; message?: string; data?: unknown }>;
  title: string;
  action: string;
  details: ReactNode;
}
function writeSpec(p: PendingWrite, parentOrgName?: string): DialogSpec {
  if (isKeyWrite(p)) {
    const spec = keyWriteSpec(p);
    return { send: (t) => spec.send(p, t), title: spec.title(p), action: spec.action, details: spec.details(p, parentOrgName) };
  }
  const spec = PENDING_WRITES[p.kind] as unknown as WriteSpec<WriteKind>;
  return { send: (t) => spec.send(p, t), title: spec.title(p), action: spec.action(p), details: spec.details(p) };
}

/** "1 pipeline" / "12 pipelines". */
function pipelinesCount(n: number): string {
  return `${n} ${n === 1 ? 'pipeline' : 'pipelines'}`;
}

/** What a key write refused by the per-org limit (5 an hour) says. */
export const KEY_WRITE_RATE_LIMIT_COPY = 'Signing key changes are limited to 5 an hour for each organization. Try again later.';

/** The error line for a refused write: a runner code's copy, the key-write limit, or the server's sentence. */
function writeErrorMessage(e: unknown, keyWrite: boolean): string {
  if (e instanceof MfaRequiredError) return ''; // The shell already shows the "two-factor authentication required" dialog.
  if (keyWrite && e instanceof ApiError && e.statusCode === 429) return KEY_WRITE_RATE_LIMIT_COPY;
  if (isRunnerError(e)) {
    const c = runnerErrorCopy(e.code, e.details?.reason);
    return `${c.title} ${c.body}`;
  }
  return formatError(e, keyWrite ? 'Could not change the signing key' : 'Could not save the pipeline runner');
}

function RunnerHealthBadge({ runner }: { runner: Pick<PipelineRunner, 'health' | 'status' | 'updateRequired'> }) {
  const b = runnerBadge(runner);
  return (
    <>
      <Badge color={b.color}>{b.label}</Badge>
      {runner.updateRequired && runner.status !== 'revoked' && <Badge color="yellow">Update required</Badge>}
    </>
  );
}

/** What an "Update required" runner's admin should do. */
function UpdateRequired({ runner }: { runner: PipelineRunner }) {
  if (!runner.updateRequired || runner.status === 'revoked') return null;
  return <p className="text-xs text-warning-strong mt-1" data-testid={`runner-update-${runner.id}`}>{RUNNER_UPDATE_COPY}.</p>;
}

/** Version · regions · last delivery. */
function RunnerMeta({ runner }: { runner: PipelineRunner }) {
  return (
    <div className="text-xs text-fg-muted mt-0.5 space-x-1" data-testid={`runner-meta-${runner.id}`}>
      <span>{runner.version ? `Version ${runner.version}` : 'Version unknown'}</span>
      <span>·</span>
      <span>{runner.regions.length > 0 ? `Regions ${runner.regions.join(', ')}` : 'No regions reported'}</span>
      <span>·</span>
      <span>
        Last delivery{' '}
        {runner.lastDeliveryAt ? <RelativeTime value={runner.lastDeliveryAt} /> : 'never'}
      </span>
    </div>
  );
}

/** How to install a runner: the one-runner-per-account rule and the CLI
 *  command. (Each runner's own JWKS URL is on its card once it is registered.) */
function InstallInstructions({ egressIps }: { egressIps: string[] | null }) {
  const ips = (egressIps ?? []).filter((ip) => typeof ip === 'string' && ip.trim());
  const [region, setRegion] = useState(DEFAULT_SETUP_REGION);
  const [label, setLabel] = useState('');
  const regionValid = isAwsRegion(region);
  // The command is copied into a shell, so only a real region code goes into it;
  // anything else shows the `<region>` placeholder beside the field's error.
  const commandRegion = regionValid ? region : '';
  return (
    <div className="space-y-3 rounded-md bg-surface-muted p-3 text-xs" data-testid="runner-install">
      <p className="text-fg-muted">
        With AWS credentials for the account your pipelines deploy to, this deploys the runner stack there and
        registers it with this organization (you confirm it&apos;s you in your browser). Every pipeline run goes
        through a runner, so a pipeline cannot run until its account has one.
      </p>
      <p className="font-medium" data-testid="runner-install-one-per-account">{ONE_RUNNER_PER_ACCOUNT_COPY}</p>
      <div className="flex flex-wrap gap-2">
        <FormField
          label="AWS region"
          error={regionValid ? undefined : `"${region}" is not an AWS region code (for example us-east-1).`}
        >
          <Input value={region} onChange={(e) => setRegion(e.target.value.trim())} className="max-w-[12rem] font-mono" spellCheck={false} />
        </FormField>
        <FormField label="Runner label (optional)">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} placeholder="Production" />
        </FormField>
      </div>
      <p className="text-fg-muted">
        The platform sends each signed request to the runner&apos;s Function URL. Add{' '}
        <code>--api-gateway --allow-ip &lt;cidr&gt;</code> to put it behind an IP allowlist instead.
      </p>
      <HelpCodeBlock content={setupRunnerCommand({ region: commandRegion, label })} language="bash" />
      {ips.length > 0 && (
        <div className="space-y-2" data-testid="runner-egress">
          <div className="text-fg-muted">The platform pushes from these addresses — allow them with the API Gateway variant:</div>
          <CopyableId value={ips.map(asCidr).join(' ')} size="sm" label="Copy the platform egress addresses" />
          <HelpCodeBlock content={setupRunnerCommand({ region: commandRegion, label, allowIps: ips })} language="bash" />
        </div>
      )}
      <p className="text-fg-muted">
        The runner verifies every request against this organization&apos;s public signing keys, at a URL built from its own
        runner id — nothing else is configured in your AWS account.
      </p>
    </div>
  );
}

/** "Used by 12 pipelines", and (opened) the list of them, read a page at a time. */
function RunnerPipelines({ runner }: { runner: PipelineRunner }) {
  const [open, setOpen] = useState(false);
  const list = useFetch(
    async (signal) => (await api.getRunnerPipelines(runner.id, { limit: 50 }, { signal })).data ?? null,
    [runner.id],
    { enabled: open },
  );
  if (runner.pipelineCount <= 0) {
    return <p className="text-xs text-fg-muted mt-1" data-testid={`runner-pipelines-${runner.id}`}>No pipelines linked yet</p>;
  }
  return (
    <div className="text-xs mt-1" data-testid={`runner-pipelines-${runner.id}`}>
      <button type="button" className="action-link" aria-expanded={open} onClick={() => setOpen(!open)}>
        Used by {pipelinesCount(runner.pipelineCount)}
      </button>
      {open && (
        <div className="mt-1" data-testid={`runner-pipelines-list-${runner.id}`}>
          {list.error && <RetryError message={formatError(list.error, 'Could not load the pipelines')} onRetry={list.refetch} />}
          {list.data && (
            <ul className="list-disc pl-5 space-y-0.5">
              {list.data.pipelines.map((pl) => (
                <li key={pl.id}><Link href={`/dashboard/pipelines/${encodeURIComponent(pl.id)}`} className="action-link">{pl.name || pl.id}</Link></li>
              ))}
              {list.data.pagination.hasMore && <li className="text-fg-muted">and {list.data.pagination.total - list.data.pipelines.length} more</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The runner's own JWKS URL: the public keys it verifies requests with. */
function RunnerJwks({ runner }: { runner: PipelineRunner }) {
  if (!runner.jwksUrl) return null;
  return (
    <div className="text-xs mt-1" data-testid={`runner-jwks-${runner.id}`}>
      <span className="text-fg-muted">JWKS URL: </span>
      <CopyableId value={runner.jwksUrl} size="sm" label={`Copy the JWKS URL of ${runner.label}`} />
    </div>
  );
}

/** An active runner that stopped answering: when it last did, and what it affects. */
function UnhealthyBanner({ runner, readOnly, locked, onTest }: { runner: PipelineRunner; readOnly: boolean; locked: boolean; onTest?: () => void }) {
  if (runner.status !== 'active' || runner.health !== 'unreachable') return null;
  return (
    <div className="mt-2" data-testid={`runner-unhealthy-${runner.id}`}>
      <Callout variant="danger" title={`${runner.label} is not answering`}>
        <p>
          Last successful contact: {runner.lastDeliveryAt ? <RelativeTime value={runner.lastDeliveryAt} /> : 'never'}.
          {runner.pipelineCount > 0 ? ` ${pipelinesCount(runner.pipelineCount)} cannot run until it answers again.` : ''}
          {' '}Check the runner stack in your AWS account, then test it.
        </p>
        {onTest && (
          <Button type="button" size="xs" variant="secondary" className="mt-2" readOnly={readOnly} disabled={locked} onClick={onTest}>
            Test
          </Button>
        )}
      </Callout>
    </div>
  );
}

/** One of this org's own runners: its badges and details, and (active or
 *  pending) its controls. Every write goes through `onWrite`, i.e. the panel's
 *  one step-up dialog. */
function OwnRunnerCard({ runner, readOnly, locked, saving, testResult: result, renameLabel, onRenameLabel, onWrite }: {
  runner: PipelineRunner;
  readOnly: boolean;
  /** Read-only, or a write in flight. */
  locked: boolean;
  saving: boolean;
  testResult: PipelineRunnerTestResult | undefined;
  /** The rename draft, while this runner's rename form is open. */
  renameLabel: string | null;
  /** A new draft, or `null` to close the form. */
  onRenameLabel: (label: string | null) => void;
  onWrite: (p: PendingWrite) => void;
}) {
  const active = runner.status === 'active';
  // A runner whose setup has not finished can be renamed, shared or
  // revoked, but not tested (it has never answered a ping).
  const manageable = active || runner.status === 'pending';
  return (
    <div className="rounded-lg border border-default p-3" data-testid={`runner-${runner.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{runner.label}</span>
            <RunnerHealthBadge runner={runner} />
          </div>
          <RunnerMeta runner={runner} />
          <UpdateRequired runner={runner} />
          <RunnerPipelines runner={runner} />
          <RunnerJwks runner={runner} />
          {runner.functionUrl && (
            <div className="text-xs mt-1" data-testid={`runner-url-${runner.id}`}>
              <span className="text-fg-muted">Function URL (keep private): </span>
              <CopyableId value={runner.functionUrl} size="sm" label={`Copy the Function URL of ${runner.label}`} />
            </div>
          )}
        </div>
        {manageable && (
          <div className="flex flex-wrap items-center gap-1">
            {active && (
              <Button type="button" size="xs" variant="secondary" readOnly={readOnly} disabled={locked}
                onClick={() => onWrite({ kind: 'test', runner })}>
                Test
              </Button>
            )}
            <Button type="button" size="xs" variant="ghost" readOnly={readOnly} disabled={locked}
              onClick={() => onRenameLabel(runner.label)}>
              Rename
            </Button>
            <Button type="button" size="xs" variant="danger-outline" readOnly={readOnly} disabled={locked}
              onClick={() => onWrite({ kind: 'revoke', runner })}>
              Revoke
            </Button>
          </div>
        )}
      </div>

      <UnhealthyBanner runner={runner} readOnly={readOnly} locked={locked} onTest={() => onWrite({ kind: 'test', runner })} />

      {manageable && (
        <ToggleRow
          className="mt-2"
          label="Share with teams"
          description="Teams under this organization may Re-run and Stop their pipelines through this runner. They see it, but cannot change it."
          checked={runner.shareWithTeams}
          disabled={locked}
          onChange={(v) => onWrite({ kind: 'update', runner, body: { shareWithTeams: v } })}
        />
      )}

      {result && (
        <div className="mt-2" data-testid={`runner-test-result-${runner.id}`}>
          {result.ok
            ? <Callout variant="success">The runner answered{result.outcome ? ` (${result.outcome})` : ''}; delivery is running.</Callout>
            : <Callout variant="danger">Test failed: {runnerTestFailureCopy(result.errorCode)}</Callout>}
        </div>
      )}

      {renameLabel !== null && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          aria-label={`Rename ${runner.label}`}
          onSubmit={(e) => {
            e.preventDefault();
            const label = renameLabel.trim();
            if (!label || label === runner.label) { onRenameLabel(null); return; }
            onWrite({ kind: 'update', runner, body: { label } });
          }}
        >
          <FormField label="Label">
            <Input value={renameLabel} onChange={(e) => onRenameLabel(e.target.value)} maxLength={100} />
          </FormField>
          <Button type="button" variant="ghost" size="sm" onClick={() => onRenameLabel(null)}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving || !renameLabel.trim()}>Save</Button>
        </form>
      )}
    </div>
  );
}

/**
 * Settings → Organization → Pipeline runners. Always shown to org admins:
 * runners are the only way a pipeline is started or stopped.
 *
 * A runner is a Lambda in a customer AWS account that starts and stops that
 * account's pipelines with its own role, on requests signed with this
 * organization's own key — the platform holds no AWS access and no account
 * number. It is installed and registered with the CLI
 * (`pipeline-manager infra setup-runner`); this panel lists them and renames,
 * shares, tests and revokes them, and (the Signing key card) generates,
 * rotates and revokes the key they verify requests with.
 *
 * Every write is step-up gated and MFA-grade server-side: each opens ONE
 * `StepUpModal` that states the consequence (it is also the confirmation —
 * revoking included; revoking the KEY also needs its id's last characters
 * typed), and a single-factor session's 401 `MFA_REQUIRED` is left to the
 * shell's enrol / sign-in-again dialog. Turning team sharing ON widens who may
 * use the runner, so that dialog also asks for an explicit tick.
 *
 * Runners a parent shares with this team are listed read-only, "Managed by"
 * their owner, and are signed with the owner's key. Renders nothing only while
 * runners are unavailable (paused, or secret encryption not set up).
 */
export function PipelineRunnersSettings({ orgId, readOnly = false, parentOrgName }: {
  orgId: string;
  readOnly?: boolean;
  /** The parent's name, for a team's "Inherit from …" (own mode). */
  parentOrgName?: string;
}) {
  const toast = useToast();
  const read = useFetch(
    async (signal): Promise<PipelineRunnersDto | null> => (await api.getPipelineRunners({ signal })).data ?? null,
    [orgId],
  );
  const dto = read.data;

  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [widenAck, setWidenAck] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [results, setResults] = useState<Record<string, PipelineRunnerTestResult>>({});
  const [installOpen, setInstallOpen] = useState<boolean | null>(null);
  // Whether the write in flight is a key write (its error copy differs).
  const keyWriteInFlight = useRef(false);

  const write = useMutation({
    fn: async (p: PendingWrite, stepUpToken: string) => {
      keyWriteInFlight.current = isKeyWrite(p);
      const res = await writeSpec(p, parentOrgName).send(stepUpToken);
      if (!res.success) throw new Error(res.message || (isKeyWrite(p) ? 'The signing key change was refused' : 'The runner change was refused'));
      return res.data as PipelineRunnerTestResult | { runner?: PipelineRunner } | undefined;
    },
    scopeKey: orgId,
    formatError: (e) => writeErrorMessage(e, keyWriteInFlight.current),
    onSuccess: (data, p) => {
      if (isKeyWrite(p)) {
        toast.success(keyWriteSpec(p).toast(p, parentOrgName));
        void read.refetch();
        return;
      }
      switch (p.kind) {
        case 'update':
          toast.success(p.body.label !== undefined
            ? `Runner renamed to ${p.body.label}`
            : p.body.shareWithTeams ? `${p.runner.label} is now shared with teams` : `${p.runner.label} is no longer shared with teams`);
          setRenaming(null);
          break;
        case 'test': {
          const result = data as PipelineRunnerTestResult | undefined;
          if (result) {
            setResults((r) => ({ ...r, [p.runner.id]: result }));
            if (result.ok) toast.success(`${p.runner.label} answered`);
          }
          break;
        }
        case 'revoke':
          toast.success(`${p.runner.label} revoked`);
          break;
      }
      void read.refetch();
    },
    onStepUpResumed: () => { void read.refetch(); },
  });

  if (read.error && !dto) {
    // Runners unavailable on this deployment right now: there is nothing to offer.
    if (read.error instanceof ApiError && read.error.code === 'RUNNERS_UNAVAILABLE') return null;
    return (
      <SectionCard icon={Server} title="Pipeline runners">
        <RetryError message={formatError(read.error, 'Could not load the pipeline runners')} onRetry={read.refetch} />
      </SectionCard>
    );
  }
  if (!dto || !dto.available) return null;

  const locked = readOnly || write.pending;
  // A revoked runner stays listed but reaches nothing: it does not count as installed.
  const liveOwn = dto.own.filter(isLiveRunner).length;
  const showInstall = installOpen ?? liveOwn === 0;
  const widening = !!pending && pendingWidens(pending);
  const openPending = (p: PendingWrite) => { setWidenAck(false); setPending(p); };
  const unhealthy = [...dto.own, ...dto.inherited].filter((r) => r.status === 'active' && r.health === 'unreachable');
  const spec = pending ? writeSpec(pending, parentOrgName) : null;

  return (
    <div id={PIPELINE_RUNNERS_ANCHOR} tabIndex={-1} className="scroll-mt-6 outline-none">
      <SectionCard
        icon={Server}
        title="Pipeline runners"
        description="Every pipeline run goes through a runner: a small Lambda in the pipeline's AWS account that starts and stops its pipelines with its own role, on requests signed with this organization's own key. The platform holds no AWS access and no account number."
        actions={(
          <Button type="button" size="sm" variant="secondary" aria-expanded={showInstall} onClick={() => setInstallOpen(!showInstall)}>
            {showInstall ? 'Hide install instructions' : 'Install a runner'}
          </Button>
        )}
      >
        {write.error && <div className="mb-3"><ErrorAlert message={write.error} onDismiss={write.reset} /></div>}

        <div className="space-y-4">
          {unhealthy.length > 0 && (
            <Callout variant="danger" title={unhealthy.length === 1 ? 'A runner is not answering' : `${unhealthy.length} runners are not answering`}>
              <p data-testid="runners-unhealthy-banner">
                {unhealthy.map((r) => r.label).join(', ')}: pipelines that run through {unhealthy.length === 1 ? 'it' : 'them'} cannot be
                started or stopped until {unhealthy.length === 1 ? 'it answers' : 'they answer'} again. Test {unhealthy.length === 1 ? 'it' : 'each'} below once fixed.
              </p>
            </Callout>
          )}

          {dto.signingKey && (
            <RunnerSigningKeyCard
              signingKey={dto.signingKey}
              readOnly={readOnly}
              locked={locked}
              hasRunners={liveOwn > 0}
              parentOrgName={parentOrgName}
              onWrite={openPending}
              onRefetch={read.refetch}
            />
          )}

          {showInstall && <InstallInstructions egressIps={dto.platformEgressIps ?? null} />}

          {liveOwn === 0 && (
            <EmptyState
              compact
              title="No pipeline runners"
              description={dto.inherited.length > 0
                ? 'This team runs its pipelines through the runners shared with it below, or install its own.'
                : 'Pipelines cannot run until a runner is installed in their AWS account.'}
            />
          )}

          {dto.own.map((runner) => (
            <OwnRunnerCard
              key={runner.id}
              runner={runner}
              readOnly={readOnly}
              locked={locked}
              saving={write.pending}
              testResult={results[runner.id]}
              renameLabel={renaming?.id === runner.id ? renaming.label : null}
              onRenameLabel={(label) => setRenaming(label === null ? null : { id: runner.id, label })}
              onWrite={openPending}
            />
          ))}

          {dto.inherited.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-semibold">Shared with this team</div>
              {dto.inherited.map((runner) => (
                <div key={runner.id} className="rounded-lg border border-default p-3" data-testid={`runner-inherited-${runner.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">{runner.label}</span>
                    <RunnerHealthBadge runner={runner} />
                  </div>
                  <p className="text-xs text-fg-muted mt-0.5">Managed by {runner.fromOrgName}</p>
                  <p className="text-xs text-fg-muted" data-testid={`runner-inherited-key-${runner.id}`}>
                    Uses {runner.fromOrgName}&apos;s signing key, whatever this team&apos;s key setting.
                  </p>
                  <RunnerMeta runner={runner} />
                  <UpdateRequired runner={runner} />
                  <RunnerJwks runner={runner} />
                  <UnhealthyBanner runner={runner} readOnly={readOnly} locked={locked} />
                </div>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      {pending && spec && (
        <StepUpModal
          title={spec.title}
          action={spec.action}
          details={(
            <div className="space-y-3">
              {spec.details}
              {pending.kind === 'key-revoke' && (
                <RevokeConfirmField write={pending} onChange={(confirm) => setPending({ ...pending, confirm })} />
              )}
              {widening && pending.kind === 'update' && (
                <>
                  <Callout variant="warning" title="This widens who may use this runner">
                    <p><strong>Every team</strong> under this organization will be able to Re-run and Stop its pipelines in this AWS account through {pending.runner.label}.</p>
                  </Callout>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <Checkbox checked={widenAck} onChange={(e) => setWidenAck(e.target.checked)} />
                    <span>I understand, and want to share this runner with every team.</span>
                  </label>
                </>
              )}
            </div>
          )}
          confirmDisabledReason={widening && !widenAck ? 'Acknowledge the warning first.' : (isKeyWrite(pending) ? revokeConfirmProblem(pending) : null)}
          onConfirmed={async (stepUpToken) => { await write.run(pending, stepUpToken); }}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}
