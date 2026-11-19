// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from 'react';
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
  PIPELINE_RUNNERS_ANCHOR,
  RUNNER_UPDATE_COPY,
  asCidr,
  runnerBadge,
  runnerTestFailureCopy,
  setupRunnerCommand,
} from '@/lib/pipeline-runners';
import { DEFAULT_SETUP_REGION, isAwsRegion } from '@/lib/setup-guide';

/** A step-up-gated write, held until the person confirms it's them. The
 *  step-up dialog IS the confirmation (one dialog per action). */
type PendingWrite =
  | { kind: 'update'; runner: PipelineRunner; body: PipelineRunnerUpdate }
  | { kind: 'test'; runner: PipelineRunner }
  | { kind: 'revoke'; runner: PipelineRunner };

/** Turning sharing ON lets every team under this org run pipelines through the
 *  runner — the one write that WIDENS reach, so it needs an explicit tick. */
function pendingWidens(p: PendingWrite): boolean {
  return p.kind === 'update' && p.body.shareWithTeams === true && !p.runner.shareWithTeams;
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

/** How to install a runner: the CLI command, and the public keys the runner
 *  verifies the platform's requests with. */
function InstallInstructions({ jwksUrl, egressIps }: { jwksUrl: string; egressIps: string[] | null }) {
  const ips = (egressIps ?? []).filter((ip) => typeof ip === 'string' && ip.trim());
  const [region, setRegion] = useState(DEFAULT_SETUP_REGION);
  const [label, setLabel] = useState('');
  const regionValid = isAwsRegion(region);
  return (
    <div className="space-y-3 rounded-md bg-surface-muted p-3 text-xs" data-testid="runner-install">
      <p className="text-fg-muted">
        With AWS credentials for the account your pipelines deploy to, this deploys the runner stack there and
        registers it with this organization (you confirm it&apos;s you in your browser).
      </p>
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
      <HelpCodeBlock content={setupRunnerCommand({ region, label })} language="bash" />
      {ips.length > 0 && (
        <div className="space-y-2" data-testid="runner-egress">
          <div className="text-fg-muted">The platform pushes from these addresses — allow them with the API Gateway variant:</div>
          <CopyableId value={ips.map(asCidr).join(' ')} size="sm" label="Copy the platform egress addresses" />
          <HelpCodeBlock content={setupRunnerCommand({ region, label, allowIps: ips })} language="bash" />
        </div>
      )}
      <div>
        <div className="text-fg-muted">The runner verifies every request against the platform&apos;s public keys:</div>
        <CopyableId value={jwksUrl} size="sm" label="Copy the JWKS URL" />
      </div>
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
 * Settings → Organization → Pipeline runners.
 *
 * A runner is a Lambda in a customer AWS account that starts and stops that
 * account's pipelines with its own role, on signed requests from the platform —
 * the platform holds no AWS access and no account number. It is installed and
 * registered with the CLI (`pipeline-manager infra setup-runner`); this panel
 * lists them and renames, shares, tests and revokes them.
 *
 * Every write is step-up gated and MFA-grade server-side: each opens ONE
 * `StepUpModal` that states the consequence (it is also the confirmation —
 * revoking included), and a single-factor session's 401 `MFA_REQUIRED` is left
 * to the shell's enrol / sign-in-again dialog. Turning team sharing ON widens
 * who may use the runner, so that dialog also asks for an explicit tick.
 *
 * Runners a parent shares with this team are listed read-only, "Managed by"
 * their owner. Renders nothing when the deployment has runners off.
 */
export function PipelineRunnersSettings({ orgId, readOnly = false }: { orgId: string; readOnly?: boolean }) {
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

  const write = useMutation({
    fn: async (p: PendingWrite, stepUpToken: string) => {
      const res = await (async () => {
        switch (p.kind) {
          case 'update': return api.updatePipelineRunner(p.runner.id, p.body, stepUpToken);
          case 'test': return api.testPipelineRunner(p.runner.id, stepUpToken);
          case 'revoke': return api.revokePipelineRunner(p.runner.id, stepUpToken);
        }
      })();
      if (!res.success) throw new Error(res.message || 'The runner change was refused');
      return res.data as PipelineRunnerTestResult | { runner?: PipelineRunner } | undefined;
    },
    scopeKey: orgId,
    // The shell already shows the "two-factor authentication required" dialog.
    formatError: (e) => (e instanceof MfaRequiredError ? '' : formatError(e, 'Could not save the pipeline runner')),
    onSuccess: (data, p) => {
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
    // Runners switched off on this deployment: there is no setting to offer.
    if (read.error instanceof ApiError && read.error.code === 'RUNNERS_UNAVAILABLE') return null;
    return (
      <SectionCard icon={Server} title="Pipeline runners">
        <RetryError message={formatError(read.error, 'Could not load the pipeline runners')} onRetry={read.refetch} />
      </SectionCard>
    );
  }
  if (!dto || !dto.available) return null;

  const locked = readOnly || write.pending;
  const showInstall = installOpen ?? dto.own.length === 0;
  const widening = !!pending && pendingWidens(pending);
  const openPending = (p: PendingWrite) => { setWidenAck(false); setPending(p); };

  return (
    <div id={PIPELINE_RUNNERS_ANCHOR} tabIndex={-1} className="scroll-mt-6 outline-none">
      <SectionCard
        icon={Server}
        title="Pipeline runners"
        description="Re-run and Stop pipelines deployed to your own AWS accounts. A runner is a small Lambda in that account that starts and stops its pipelines with its own role, on requests the platform signs — the platform holds no AWS access and no account number."
        actions={(
          <Button type="button" size="sm" variant="secondary" aria-expanded={showInstall} onClick={() => setInstallOpen(!showInstall)}>
            {showInstall ? 'Hide install instructions' : 'Install a runner'}
          </Button>
        )}
      >
        {write.error && <div className="mb-3"><ErrorAlert message={write.error} onDismiss={write.reset} /></div>}

        <div className="space-y-4">
          {showInstall && <InstallInstructions jwksUrl={dto.jwksUrl} egressIps={dto.platformEgressIps ?? null} />}

          {dto.own.length === 0 && (
            <EmptyState compact title="No pipeline runners" description="Pipelines in the platform's own AWS account need none." />
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
                  <RunnerMeta runner={runner} />
                  <UpdateRequired runner={runner} />
                </div>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      {pending && (
        <StepUpModal
          title={stepUpTitle(pending)}
          action={stepUpAction(pending)}
          details={(
            <div className="space-y-3">
              {stepUpDetails(pending)}
              {widening && (
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
          confirmDisabledReason={widening && !widenAck ? 'Acknowledge the warning first.' : null}
          onConfirmed={async (stepUpToken) => { await write.run(pending, stepUpToken); }}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}

function stepUpTitle(p: PendingWrite): string {
  switch (p.kind) {
    case 'update':
      if (p.body.label !== undefined) return `Rename ${p.runner.label}?`;
      return p.body.shareWithTeams ? `Share ${p.runner.label} with teams?` : `Stop sharing ${p.runner.label} with teams?`;
    case 'test': return `Test ${p.runner.label}?`;
    case 'revoke': return `Revoke ${p.runner.label}?`;
  }
}

function stepUpAction(p: PendingWrite): string {
  switch (p.kind) {
    case 'update': return `Update the pipeline runner ${p.runner.label}`;
    case 'test': return `Send a test request to the pipeline runner ${p.runner.label}`;
    case 'revoke': return `Revoke the pipeline runner ${p.runner.label}`;
  }
}

function stepUpDetails(p: PendingWrite): ReactNode {
  switch (p.kind) {
    case 'update':
      if (p.body.label !== undefined) return <p>The runner will be called <strong>{p.body.label}</strong> everywhere it is shown, including its pipelines&apos; Deployment cards.</p>;
      return p.body.shareWithTeams
        ? <p>Teams will see this runner and use it for their pipelines in its AWS account.</p>
        : <p>Teams will no longer Re-run or Stop their pipelines through this runner; their links to it are cleared.</p>;
    case 'test':
      return <p>The platform sends the runner a signed ping now. If it answers, paused deliveries resume.</p>;
    case 'revoke':
      return (
        <p>
          Re-run and Stop will no longer reach pipelines through this runner{p.runner.shareWithTeams ? ', for this organization or its teams' : ''}.
          Pending requests expire. This cannot be undone. The runner stack stays in
          your AWS account — remove it with <code>pipeline-manager infra setup-runner --delete</code>.
        </p>
      );
  }
}
