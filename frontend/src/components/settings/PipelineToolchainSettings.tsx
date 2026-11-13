// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId, useState, type ReactNode } from 'react';
import { History, Lock, Wrench } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { useOrgHierarchy } from '@/hooks/useOrgHierarchy';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import {
  RELEASE_STATUS_COLOR, RELEASE_STATUS_LABEL, RESOLVED_VIA_LABEL, isReleaseSelectable, releaseWarnings,
  scanSummaryText, toolchainErrorMessage, toolchainVersionsText, warningMessages,
} from '@/lib/toolchain';
import type {
  ToolchainEligibleView, ToolchainOrgDefaultHistoryEntry, ToolchainOrgDefaultView,
} from '@/types/toolchain';

/** `''` = no org default of its own (follow the platform default, or inherit the root org's). */
const FOLLOW = '';

interface Loaded {
  view: ToolchainOrgDefaultView;
  eligible: ToolchainEligibleView;
  history: ToolchainOrgDefaultHistoryEntry[];
}

/** A write waiting on the step-up confirmation. `releaseVersion: null` deletes the org default. */
interface PendingWrite {
  releaseVersion: string | null;
  reason?: string;
  /** What the confirmation calls it. */
  action: string;
}

/**
 * The blast radius of moving the org's unpinned pipelines to `target`, in the
 * plan's words (§11). Pinned pipelines never move with the org default.
 */
export function blastRadiusText(view: ToolchainOrgDefaultView, target: string | null): string {
  const { pipelines, pinned } = view.counts;
  const unpinned = Math.max(0, pipelines - pinned);
  if (target !== null && target === view.effective.releaseVersion) {
    return `Your pipelines stay on ${target}; nothing moves.`;
  }
  const moving = `${unpinned} of your ${pipelines} pipeline${pipelines === 1 ? '' : 's'} will move on their next run`;
  return pinned > 0 ? `${moving}; ${pinned} pinned pipeline${pinned === 1 ? '' : 's'} won't.` : `${moving}.`;
}

/** The release an unpinned pipeline would get with no org default of its own. */
function followTarget(view: ToolchainOrgDefaultView): string | null {
  // A team that inherits: the effective release IS the root's (while this team has none of its own).
  if (view.inheritedFrom && !view.orgDefault) return view.effective.releaseVersion;
  if (view.canary.member && view.canary.releaseVersion) return view.canary.releaseVersion;
  return view.platformDefault;
}

/**
 * Settings → Organization → "Pipeline toolchain".
 *
 * Which managed toolchain release (the build image and the `cdk-synth` step,
 * one release) this organization's unpinned pipelines run. "Follow platform
 * default" tracks the system org's promotions; choosing a release holds the
 * org there, ahead of any canary. A team gets the same card and, without a
 * default of its own, inherits its root organization's.
 *
 * Visible with `pipelines:read` and read-only there ("locks, not hides");
 * `canEdit` (`toolchain:manage`) adds the controls, which `readOnly` (a
 * read-only session) disables. Every write re-verifies (step-up).
 */
export function PipelineToolchainSettings({ canEdit, readOnly }: { canEdit: boolean; readOnly: boolean }) {
  const uid = useId();
  const toast = useToast();
  // A team's "no default of its own" inherits its root org's. The server names
  // the root only while it applies (`inheritedFrom`, an org id); the session's
  // org list puts a name on it and says we are a team even when the team has its own.
  const { isChildOrg, parentOrgId, parentOrgName } = useOrgHierarchy();
  const [draft, setDraft] = useState<string>(FOLLOW);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useFetch(async (signal): Promise<Loaded | null> => {
    const [viewRes, eligibleRes, historyRes] = await Promise.all([
      api.getToolchainOrgDefault({ signal }),
      api.getToolchainEligible({ signal }),
      // History is supplementary: a failure leaves the list empty, the card usable.
      api.getToolchainOrgDefaultHistory({ signal }).catch(() => null),
    ]);
    if (!viewRes.data || !eligibleRes.data) return null;
    return { view: viewRes.data, eligible: eligibleRes.data, history: historyRes?.data?.history ?? [] };
  }, [], {
    // Seed the selection in the same render as the data (re-seeded after each write's refetch).
    onSuccess: (v) => { if (v) setDraft(v.view.orgDefault?.releaseVersion ?? FOLLOW); },
  });
  const data = read.data;

  const editable = canEdit && !readOnly;

  if (read.error && !data) {
    return (
      <Card>
        <RetryError message={formatError(read.error, 'Could not load the pipeline toolchain')} onRetry={read.refetch} />
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>
      </Card>
    );
  }

  const { view, eligible, history } = data;
  const releases = eligible.releases;
  const own = view.orgDefault?.releaseVersion ?? FOLLOW;
  const dirty = draft !== own;
  const followCurrent = followTarget(view);
  const isTeam = !!view.inheritedFrom || isChildOrg;
  const rootName = (view.inheritedFrom && view.inheritedFrom !== parentOrgId ? undefined : parentOrgName) ?? 'your root organization';
  const followLabel = isTeam
    ? `Inherit from ${rootName}${view.orgDefault ? '' : ` (currently ${followCurrent ?? 'none'})`}`
    : `Follow platform default (currently ${view.platformDefault ?? 'none'})`;
  const warnings = view.orgDefault ? releaseWarnings(view.orgDefault.releaseVersion, view.platformDefault, releases) : [];

  // "Revert to previous": the newest history row that differs from what is set now.
  const ownOrNull = view.orgDefault?.releaseVersion ?? null;
  const previous = history.find((h) => h.releaseVersion !== ownOrNull);

  const run = async (write: PendingWrite, stepUpToken: string) => {
    setError(null);
    try {
      if (write.releaseVersion === null) {
        await api.clearToolchainOrgDefault(stepUpToken);
        toast.success(isTeam ? `Now inheriting from ${rootName}` : 'Now following the platform default');
      } else {
        const res = await api.setToolchainOrgDefault(
          { releaseVersion: write.releaseVersion, ...(write.reason ? { reason: write.reason } : {}) },
          stepUpToken,
        );
        toast.success(`Organization default set to ${write.releaseVersion}`);
        for (const w of warningMessages(res.data?.warnings)) toast.warning(w);
      }
      setReason('');
      await read.refetch();
    } catch (err) {
      setError(toolchainErrorMessage(err, 'Could not change the organization default'));
    } finally {
      setPending(null);
    }
  };

  const save = () => {
    const releaseVersion = draft === FOLLOW ? null : draft;
    setPending({
      releaseVersion,
      reason: reason.trim() || undefined,
      action: releaseVersion === null
        ? (isTeam ? `Inherit the toolchain from ${rootName}` : 'Follow the platform toolchain default')
        : `Set the organization toolchain default to ${releaseVersion}`,
    });
  };

  const revert = () => {
    if (!previous) return;
    setPending({
      releaseVersion: previous.releaseVersion,
      reason: 'Revert to previous',
      action: previous.releaseVersion === null
        ? 'Revert to following the platform toolchain default'
        : `Revert the organization toolchain default to ${previous.releaseVersion}`,
    });
  };

  const pendingTarget = pending ? (pending.releaseVersion ?? followCurrent) : null;

  return (
    <Card>
      {error && <div className="mb-3"><ErrorAlert message={error} /></div>}
      <div className="space-y-5" data-testid="pipeline-toolchain">
        {/* Status: what runs, and why. */}
        <div className="space-y-1 text-sm" data-testid="toolchain-status">
          <p>
            Effective release: <strong className="font-mono">{view.effective.releaseVersion ?? 'none'}</strong>
            {' '}<span className="text-fg-muted">({RESOLVED_VIA_LABEL[view.effective.resolvedVia]}
              {view.effective.resolvedVia === 'org-default' && view.inheritedFrom && !view.orgDefault ? `, inherited from ${rootName}` : ''})</span>
          </p>
          {view.canary.member && (
            <p data-testid="toolchain-canary">
              <Badge color="purple">Canary</Badge>{' '}
              {view.canary.effective
                ? <>Your organization is in the canary for <span className="font-mono">{view.canary.releaseVersion}</span>.</>
                : <>Your organization is in the canary for <span className="font-mono">{view.canary.releaseVersion ?? 'a release'}</span>, which has no effect while your org default is set.</>}
            </p>
          )}
          <p className="text-fg-muted" data-testid="toolchain-counts">
            {view.counts.pipelines} pipeline{view.counts.pipelines === 1 ? '' : 's'} · {view.counts.pinned} pinned · {view.counts.behind} behind default
          </p>
        </div>

        {warnings.length > 0 && (
          <Callout variant="warning" title="Your organization default needs attention">
            <ul className="list-disc pl-5" data-testid="toolchain-warnings">
              {warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </Callout>
        )}

        {!canEdit && (
          <Callout variant="neutral" icon={Lock}>
            Changing the organization default needs the Manage pipeline toolchain permission (Owners and Admins hold it).
          </Callout>
        )}

        <fieldset disabled={!editable} className="space-y-2">
          <legend className="text-sm font-medium text-fg">Organization default</legend>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-default p-3 has-[:checked]:border-accent">
            <input
              type="radio"
              name={`${uid}-release`}
              value={FOLLOW}
              className="mt-1"
              checked={draft === FOLLOW}
              onChange={() => setDraft(FOLLOW)}
            />
            <span className="text-sm font-medium">{followLabel}</span>
          </label>
          {releases.map((r) => {
            const selectable = isReleaseSelectable(r) || r.releaseVersion === own;
            return (
              <label
                key={r.releaseVersion}
                className={`flex items-start gap-3 rounded-lg border border-default p-3 has-[:checked]:border-accent ${selectable ? 'cursor-pointer' : 'opacity-60'}`}
              >
                <input
                  type="radio"
                  name={`${uid}-release`}
                  value={r.releaseVersion}
                  className="mt-1"
                  checked={draft === r.releaseVersion}
                  disabled={!selectable}
                  onChange={() => setDraft(r.releaseVersion)}
                  aria-label={`Release ${r.releaseVersion}`}
                />
                <span className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="font-mono">{r.releaseVersion}</span>
                    <Badge color={RELEASE_STATUS_COLOR[r.status]}>{RELEASE_STATUS_LABEL[r.status]}</Badge>
                    {r.relation !== 'current' && <Badge color="gray">{r.relation}</Badge>}
                  </span>
                  <span className="block text-xs text-fg-muted">{toolchainVersionsText(r.toolchain)}</span>
                  <span className="block text-xs text-fg-muted">Scan: {scanSummaryText(r.scan)}</span>
                  {r.releaseNotes && <span className="block whitespace-pre-line text-xs text-fg">{r.releaseNotes}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>

        {canEdit && (
          <div className="space-y-3">
            <FormField label="Reason" hint="Optional. Recorded in the history and the audit log.">
              <Input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. hold at 1.4.1 until our CDK upgrade lands"
                disabled={!editable || draft === FOLLOW}
              />
            </FormField>
            <div className="flex justify-end">
              <Button type="button" readOnly={readOnly} disabled={!dirty} onClick={save}>
                Save toolchain default
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-2 border-t border-default pt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-medium text-fg"><History className="h-4 w-4" /> History</p>
            {canEdit && previous && (
              <Button type="button" variant="secondary" size="sm" readOnly={readOnly} onClick={revert}>
                Revert to previous
              </Button>
            )}
          </div>
          {history.length === 0 ? (
            <p className="text-sm text-fg-muted">No changes yet.</p>
          ) : (
            <ul className="divide-y divide-default text-sm" data-testid="toolchain-history">
              {history.map((h, i) => (
                <li key={`${h.setAt}-${i}`} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                  <span className="font-mono">{h.releaseVersion ?? (isTeam ? `Inherited from ${rootName}` : 'Followed the platform default')}</span>
                  <span className="text-fg-muted">by {h.setBy}</span>
                  <RelativeTime value={h.setAt} className="text-fg-muted" />
                  {h.reason && <span className="text-fg-muted">— {h.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {pending && (
        <StepUpModal
          action={pending.action}
          details={<p data-testid="toolchain-blast-radius">{blastRadiusText(view, pendingTarget)}</p>}
          onConfirmed={(token) => run(pending, token)}
          onClose={() => setPending(null)}
        />
      )}
    </Card>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <SectionCard
      icon={Wrench}
      title="Pipeline toolchain"
      description="The build image and cdk-synth release your pipelines run. Pipelines move to a new release on their next run; a pipeline pinned to a release stays on it."
    >
      {children}
    </SectionCard>
  );
}
