// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Check, Download, ShieldCheck, X } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { RemediationStageBadge, isRemediationOperatorOff } from '@/components/plugin/RemediationCard';
import { RemediationOffNotice } from '@/components/plugin/RemediationOffNotice';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { triggerBlobDownload } from '@/lib/download';
import type { ToolchainFixDto } from '@/types/toolchain';

/** Why a candidate was refused, as the operator reads it (`error` codes of a needs_owner toolchain fix). */
const REFUSAL_TEXT: Record<string, string> = {
  TOOLCHAIN_INPUTS_MISSING: "The release's build inputs were never kept (it was uploaded before they were): fix it in the repository.",
  NO_CANDIDATE: 'No rebuild or patch-level library fix cleared the findings.',
  GATE_REFUSED: 'A candidate image failed the build gate.',
  TARGETED_STILL_PRESENT: 'A targeted finding was still present in a candidate.',
  NEW_FINDINGS: 'A candidate had a new Critical or High finding.',
  TOOL_VERSION_CHANGED: 'The fix would change a tool version (pipeline-manager, aws-cdk, cdk-assets or node).',
  FIX_NOT_REPRODUCIBLE: 'The fix needed an overlay layer or an AI draft, which the spec patch could not reproduce.',
  SPEC_CHANGED: "The fix changed a half's plugin-spec.yaml.",
  SYNTH_SMOKE_FAILED: 'cdk synth of the fixture app failed in a candidate image.',
};

const short = (digest: string | null | undefined): string => (digest ? digest.replace(/^sha256:/, '').slice(0, 12) : '—');
const shortRef = (ref: string): string => ref.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, '@sha256:$1');

function Diff({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="font-mono">{from} → {to}</dd>
    </div>
  );
}

type Pending = { fix: ToolchainFixDto; action: 'approve' | 'reject' } | null;

/**
 * The Toolchain console's "Toolchain fixes" card: the nightly toolchain fixes'
 * release candidates (propose-only — never published without an approval
 * here). Each shows the findings it clears, its version diff (the release, the
 * Node base image, sourceDigest and both image digests) and the exact tool
 * versions it keeps; Approve publishes the release (both halves) and tells the
 * orgs on the vulnerable one, Reject discards it — each behind a step-up —
 * and Export downloads the deploy/toolchain/** spec patch for the release
 * workflow. Approving moves nobody: orgs switch through their own toolchain
 * default.
 *
 * Gate: system org + `plugins:write` (the routes'); without it the card reads
 * nothing and says what is needed.
 */
export function ToolchainFixesCard({ allowed, canWrite, onPublished }: {
  /** The viewer holds plugins:write in the system org (the routes' gate). */
  allowed: boolean;
  /** …and the session is writable (approve / reject). */
  canWrite: boolean;
  /** A release was published: the Releases panel refreshes. */
  onPublished: () => Promise<unknown> | void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState<Pending>(null);
  // Set when approve / resume answered 503: the operator turned remediation off.
  const [operatorOff, setOperatorOff] = useState(false);
  const read = useFetch(async (signal) => (await api.listToolchainFixes({ signal })).data ?? null, [allowed], { enabled: allowed });

  const card = (body: React.ReactNode) => (
    <div data-testid="toolchain-fixes">
      <SectionCard
        icon={ShieldCheck}
        title="Toolchain fixes"
        description="Nightly security fixes of toolchain releases: verified candidates wait here for approval and are never published automatically."
      >
        {body}
      </SectionCard>
    </div>
  );

  if (!allowed) return card(<p className="text-sm text-fg-muted">Reviewing toolchain fixes needs plugins:write in the system organization.</p>);
  const view = read.data;
  if (!view) {
    return card(read.error
      ? <RetryError message={formatError(read.error, 'Could not load toolchain fixes')} onRetry={read.refetch} />
      : <div className="flex items-center gap-2 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>);
  }

  const decide = async (p: NonNullable<Pending>, token: string) => {
    try {
      if (p.action === 'approve') {
        await api.approveToolchainFix(p.fix.id, {}, token);
        toast.success(`Toolchain release ${p.fix.toRelease} published`);
        await onPublished();
      } else {
        await api.rejectToolchainFix(p.fix.id, {}, token);
        toast.success(`Toolchain fix ${p.fix.toRelease} rejected`);
      }
    } catch (err) {
      if (p.action === 'approve' && isRemediationOperatorOff(err)) setOperatorOff(true);
      else toast.error(formatError(err, p.action === 'approve' ? 'Could not publish the toolchain release' : 'Could not reject the toolchain fix'));
    } finally {
      setPending(null);
      await read.refetch();
    }
  };

  const download = async (f: ToolchainFixDto) => {
    try {
      const { blob, filename } = await api.downloadToolchainFixExport(f.id);
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(formatError(err, 'Spec patch download failed'));
    }
  };

  const off = !view.enabled
    ? 'Plugin remediation is turned off by the operator (PLUGIN_REMEDIATION_ENABLED=false): no toolchain fix is built.'
    : view.mode === 'off'
      ? 'Toolchain fixes are turned off by the operator (PLUGIN_REMEDIATION_TOOLCHAINS=off): a flagged release gets an owner request only.'
      : null;

  return card(
    <div className="space-y-3">
      {off && <p className="rounded-md border border-default bg-surface-muted p-2 text-sm" data-testid="toolchain-fixes-off">{off}</p>}
      {operatorOff && view.enabled && <RemediationOffNotice />}
      {view.fixes.length === 0 ? (
        <p className="text-sm text-fg-muted">No toolchain fixes yet. A flagged release&apos;s candidate appears here after the nightly rescan.</p>
      ) : (
        <ul className="space-y-3">
          {view.fixes.map((f) => {
            const to = f.toRelease ?? '—';
            const advisories = [...new Map(f.cleared.map((c) => [c.id, c])).values()];
            const waiting = f.stage === 'awaiting_approval';
            // Approved, but the publish stopped part-way: Approve resumes it (the nightly sweep does too).
            const publishing = waiting ? f.publishing : null;
            return (
              <li key={f.id} className="space-y-2 rounded-md border border-default p-3 text-xs" data-testid={`toolchain-fix-${f.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{f.fromRelease} → {to}</span>
                  <RemediationStageBadge stage={f.stage} />
                  <span className="text-fg-muted"><RelativeTime value={f.createdAt} /></span>
                  {f.decidedBy && <span className="text-fg-muted">decided by {f.decidedBy}</span>}
                </div>
                {f.error && REFUSAL_TEXT[f.error] && <p className="text-fg-muted">{REFUSAL_TEXT[f.error]}</p>}
                {publishing && (
                  <p className="text-fg-muted" data-testid="toolchain-fix-publishing">
                    Approved by {publishing.approvedBy}; publishing was interrupted. Done so far:{' '}
                    {[
                      publishing.steps.bootstrap && 'pipeline-bootstrap stored',
                      publishing.steps.cdkSynth && 'cdk-synth stored',
                      publishing.steps.inputs && 'build inputs kept',
                      publishing.steps.notice && 'orgs told',
                    ].filter(Boolean).join(', ') || 'nothing yet'}. Resume publish finishes the rest under the same version; it can no longer be rejected.
                  </p>
                )}
                {advisories.length > 0 && (
                  <div>
                    <p className="font-medium">Findings cleared</p>
                    <ul className="ml-4 list-disc">
                      {advisories.map((c) => (
                        <li key={c.id}><span className="font-mono">{c.id}</span> {c.packageName} {c.fromVersion}{c.toVersion ? ` → ${c.toVersion}` : ''}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {f.toolchain && (
                  <p>
                    <span className="text-fg-muted">Unchanged: </span>
                    pipeline-manager {f.toolchain.pipelineManager}, aws-cdk {f.toolchain.awsCdk}, cdk-assets {f.toolchain.cdkAssets}, node {f.toolchain.node}
                  </p>
                )}
                {f.digests && (
                  <dl className="space-y-0.5">
                    <Diff label="Release" from={f.fromRelease} to={to} />
                    {f.baseImage && <Diff label="Base image" from={shortRef(f.baseImage.from)} to={shortRef(f.baseImage.to)} />}
                    {f.sourceDigest && <Diff label="sourceDigest" from={short(f.sourceDigest.from)} to={short(f.sourceDigest.to)} />}
                    <Diff label="pipeline-bootstrap" from={short(f.digests['pipeline-bootstrap'].from)} to={short(f.digests['pipeline-bootstrap'].to)} />
                    <Diff label="cdk-synth" from={short(f.digests['cdk-synth'].from)} to={short(f.digests['cdk-synth'].to)} />
                  </dl>
                )}
                {(waiting || f.hasExport) && (
                  <div className="flex flex-wrap gap-2">
                    {waiting && (
                      <>
                        <Button type="button" size="xs" readOnly={!canWrite || !view.enabled || operatorOff} aria-label={`${publishing ? 'Resume publish' : 'Approve'} ${to}`} onClick={() => setPending({ fix: f, action: 'approve' })}>
                          <Check className="h-3 w-3" aria-hidden /> {publishing ? 'Resume publish' : 'Approve'}
                        </Button>
                        {!publishing && (
                          <Button type="button" size="xs" variant="danger-outline" readOnly={!canWrite} aria-label={`Reject ${to}`} onClick={() => setPending({ fix: f, action: 'reject' })}>
                            <X className="h-3 w-3" aria-hidden /> Reject
                          </Button>
                        )}
                      </>
                    )}
                    {f.hasExport && (
                      <Button type="button" size="xs" variant="secondary" aria-label={`Export spec patch ${to}`} onClick={() => { void download(f); }}>
                        <Download className="h-3 w-3" aria-hidden /> Export spec patch
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pending && (
        <StepUpModal
          title={pending.action === 'approve' ? `Publish ${pending.fix.toRelease}?` : `Reject ${pending.fix.toRelease}?`}
          action={pending.action === 'approve' ? `Publish toolchain release ${pending.fix.toRelease}` : `Reject toolchain fix ${pending.fix.toRelease}`}
          details={pending.action === 'approve'
            ? <p className="text-sm">Both halves are published as release {pending.fix.toRelease} and the orgs on {pending.fix.fromRelease} are told. No org is moved: each switches through its own toolchain default, and the platform default stays yours to promote.</p>
            : <p className="text-sm">Nothing is published and the candidate images are discarded.</p>}
          onConfirmed={(token) => decide(pending, token)}
          onClose={() => setPending(null)}
        />
      )}
    </div>,
  );
}
