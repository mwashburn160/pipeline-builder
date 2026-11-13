// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { OrgPicker } from '@/components/ui/OrgPicker';
import { RetryError } from '@/components/ui/RetryError';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { gateLines, sameThresholds } from '@/lib/toolchain-console';
import type { ToolchainCanaryMember, ToolchainConsoleRelease, ToolchainGateThresholds } from '@/types/toolchain';
import { SetPlatformDefaultFlow } from './SetPlatformDefaultFlow';

const NO_EFFECT = 'has its own default — canary has no effect';

type Pending = { kind: 'add'; orgId: string } | { kind: 'remove'; member: ToolchainCanaryMember };

interface Props {
  release: ToolchainConsoleRelease;
  canWrite: boolean;
  onChanged: () => Promise<unknown> | void;
}

/**
 * Canary (§6, §11): the orgs trying a release before it is promoted, and the
 * gate that keeps "Promote" disabled until the canary has enough runs across
 * enough orgs with a failure rate close to the default's. An org with its own
 * default is flagged: the canary does not reach its pipelines. Promoting past
 * a closed gate takes a written reason.
 */
export function ToolchainCanaryPanel({ release, canWrite, onChanged }: Props) {
  const toast = useToast();
  const v = release.releaseVersion;
  const [pick, setPick] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [promote, setPromote] = useState<{ override: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Thresholds the gate is judged with (null = the server's defaults), and the inputs' draft. */
  const [applied, setApplied] = useState<ToolchainGateThresholds | null>(null);
  const [draft, setDraft] = useState<ToolchainGateThresholds | null>(null);

  const read = useFetch(
    async (signal) => (await api.getToolchainCanary(v, { signal, thresholds: applied ?? undefined })).data ?? null,
    [v, applied],
    { onSuccess: (d) => { if (d) setDraft(d.gate.thresholds); } },
  );
  const data = read.data;

  if (!data) {
    return read.error
      ? <RetryError message={formatError(read.error, 'Could not load the canary')} onRetry={read.refetch} />
      : <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>;
  }

  const { members, gate } = data;
  const th = draft ?? gate.thresholds;
  const dirty = !sameThresholds(th, gate.thresholds);
  const passes = gate.passes;
  const isDefault = release.status === 'default';
  const live = release.status !== 'yanked' && release.status !== 'deprecated';

  const run = async (p: Pending, token: string) => {
    setError(null);
    const ids = members.map((m) => m.orgId);
    const next = p.kind === 'add' ? [...new Set([...ids, p.orgId])] : ids.filter((id) => id !== p.member.orgId);
    try {
      const res = await api.setToolchainRollout(v, next, token);
      if (p.kind === 'add') {
        const added = res.data?.members.find((m) => m.orgId === p.orgId);
        toast.success(`${added?.orgName ?? p.orgId} added to the ${v} canary`);
        if (added?.hasOrgDefault) toast.warning(`${added.orgName} ${NO_EFFECT}.`);
        const moved = res.data?.moved?.find((m) => m.orgId === p.orgId);
        if (moved) toast.info(`${added?.orgName ?? p.orgId} moved here from the ${moved.fromReleaseVersion} canary (one canary per org).`);
        setPick('');
      } else {
        toast.success(`${p.member.orgName} removed from the ${v} canary`);
      }
      await read.refetch();
      await onChanged();
    } catch (err) {
      setError(formatError(err, 'Could not change the canary'));
    } finally {
      setPending(null);
    }
  };

  const setTh = (key: keyof ToolchainGateThresholds, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    setDraft({ ...th, [key]: key === 't' ? n : Math.floor(n) });
  };

  return (
    <div className="space-y-5" data-testid="toolchain-canary">
      {error && <ErrorAlert message={error} />}

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-fg">Canary orgs</h3>
        {members.length === 0 ? (
          <p className="text-sm text-fg-muted">No canary orgs. Unpinned pipelines in a canary org without its own default resolve this release on their next run.</p>
        ) : (
          <ul className="divide-y divide-default text-sm" data-testid="toolchain-canary-members">
            {members.map((m) => (
              <li key={m.orgId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  {m.orgName} <span className="font-mono text-xs text-fg-muted">{m.orgId}</span>
                  {m.hasOrgDefault && <> <Badge color="yellow">{NO_EFFECT}</Badge></>}
                </span>
                <Button
                  type="button" size="xs" variant="secondary" readOnly={!canWrite}
                  aria-label={`Remove ${m.orgName}`}
                  onClick={() => setPending({ kind: 'remove', member: m })}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {!isDefault && live && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <OrgPicker value={pick} onChange={setPick} aria-label="Add canary org" disabled={!canWrite} />
            </div>
            <Button
              type="button" size="sm" readOnly={!canWrite}
              disabled={!pick || members.some((m) => m.orgId === pick)}
              onClick={() => setPending({ kind: 'add', orgId: pick })}
            >
              Add to canary
            </Button>
          </div>
        )}
        <p className="text-xs text-fg-muted">An org with its own toolchain default is unaffected by the canary; it is flagged once added.</p>
      </section>

      <section className="space-y-2" data-testid="toolchain-gate">
        <h3 className="flex items-center gap-2 text-sm font-medium text-fg">
          Canary gate
          <Badge color={passes ? 'green' : 'yellow'}>{passes ? 'Passed' : 'Not passed'}</Badge>
          {applied && <span className="text-xs font-normal text-fg-muted">(with your thresholds)</span>}
        </h3>
        <ul className="list-disc pl-5 text-sm" data-testid="toolchain-gate-numbers">
          {gateLines(gate).map((l) => <li key={l}>{l}</li>)}
        </ul>
        <div className="flex flex-wrap gap-3">
          <FormField label="N (synth runs)"><Input type="number" min={1} value={th.n} onChange={(e) => setTh('n', e.target.value)} aria-label="Minimum synth runs" className="w-24" /></FormField>
          <FormField label="M (orgs)"><Input type="number" min={1} value={th.m} onChange={(e) => setTh('m', e.target.value)} aria-label="Minimum orgs" className="w-24" /></FormField>
          <FormField label="T (points)"><Input type="number" min={0} step="0.5" value={th.t} onChange={(e) => setTh('t', e.target.value)} aria-label="Maximum points over the default" className="w-24" /></FormField>
          <div className="flex items-end gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={!dirty} onClick={() => setApplied(th)}>Apply thresholds</Button>
            {applied && <Button type="button" size="sm" variant="ghost" onClick={() => setApplied(null)}>Reset to defaults</Button>}
          </div>
        </div>
        <p className="text-xs text-fg-muted">
          Each org counts for at most ceil(N / M) runs. Outcomes are customer-reported, so the gate informs the decision; it is not a security boundary.
        </p>
      </section>

      {!isDefault && live && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" readOnly={!canWrite} disabled={!passes} onClick={() => setPromote({ override: false })}>
            Promote to platform default
          </Button>
          {!passes && (
            <Button type="button" variant="secondary" readOnly={!canWrite} onClick={() => setPromote({ override: true })}>
              Override and promote…
            </Button>
          )}
        </div>
      )}
      {isDefault && <Callout variant="success">{v} is the platform default.</Callout>}

      {pending && (
        <StepUpModal
          action={pending.kind === 'add'
            ? `Add an org to the ${v} canary`
            : `Remove ${pending.member.orgName} from the ${v} canary`}
          details={(
            <p className="text-sm">
              {pending.kind === 'add'
                ? 'Its unpinned pipelines resolve this release on their next run, unless the org has its own default. The org is notified.'
                : 'Its unpinned pipelines go back to the platform default on their next run.'}
            </p>
          )}
          onConfirmed={(token) => run(pending, token)}
          onClose={() => setPending(null)}
        />
      )}

      {promote && (
        <SetPlatformDefaultFlow
          releaseVersion={v}
          override={promote.override}
          canaryGate={applied ?? undefined}
          onDone={() => { void onChanged(); }}
          onClose={() => setPromote(null)}
        />
      )}
    </div>
  );
}
