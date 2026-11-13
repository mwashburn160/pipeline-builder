// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Package } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { RELEASE_STATUS_COLOR, RELEASE_STATUS_LABEL, scanSummaryText, toolchainVersionsText } from '@/lib/toolchain';
import { releaseActionAvailability, shortDigest } from '@/lib/toolchain-console';
import type { ToolchainConsoleRelease, ToolchainReleaseHalf, ToolchainReleasesView } from '@/types/toolchain';
import { SetPlatformDefaultFlow } from './SetPlatformDefaultFlow';

type Pending = { kind: 'notes' | 'deprecate' | 'yank' | 'delete'; release: ToolchainConsoleRelease };

/** Max release-notes length (server: same). */
const NOTES_MAX = 20_000;

interface Props {
  view: ToolchainReleasesView;
  /** `toolchain:operate` held and the session can write. */
  canWrite: boolean;
  onChanged: () => Promise<unknown> | void;
  /** "Add canary orgs": open the Canary panel on this release. */
  onOpenCanary: (releaseVersion: string) => void;
}

function HalfCell({ label, half, render }: { label: string; half: ToolchainReleaseHalf | null; render: (h: ToolchainReleaseHalf) => string }) {
  return (
    <span className="block whitespace-nowrap text-xs">
      <span className="text-fg-muted">{label}:</span> {half ? render(half) : 'missing'}
    </span>
  );
}

/**
 * Releases (§11): every toolchain release with both halves' digests and scans,
 * its status and notes, and the lifecycle actions. Every write steps up.
 */
export function ToolchainReleasesPanel({ view, canWrite, onChanged, onOpenCanary }: Props) {
  const toast = useToast();
  const [pending, setPending] = useState<Pending | null>(null);
  const [promote, setPromote] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [yanked, setYanked] = useState<{ releaseVersion: string; restoredDefault: string | null; wasDefault: boolean } | null>(null);

  const open = (kind: Pending['kind'], release: ToolchainConsoleRelease) => {
    setText(kind === 'notes' ? release.releaseNotes ?? '' : '');
    setError(null);
    setPending({ kind, release });
  };

  const run = async (p: Pending, token: string) => {
    const v = p.release.releaseVersion;
    try {
      if (p.kind === 'notes') {
        await api.updateToolchainReleaseNotes(v, text.trim(), token);
        toast.success(`Release notes for ${v} saved`);
      } else if (p.kind === 'deprecate') {
        await api.deprecateToolchainRelease(v, token);
        toast.success(`Release ${v} deprecated`);
      } else if (p.kind === 'yank') {
        const res = await api.yankToolchainRelease(v, text.trim(), token);
        const restoredDefault = res.data?.restoredDefault ?? null;
        setYanked({ releaseVersion: v, restoredDefault, wasDefault: p.release.status === 'default' });
        toast.success(restoredDefault ? `Release ${v} yanked; ${restoredDefault} is the platform default again` : `Release ${v} yanked`);
      } else {
        await api.deleteToolchainRelease(v, token);
        toast.success(`Release ${v} deleted`);
      }
      await onChanged();
    } catch (err) {
      setError(formatError(err, `Could not ${p.kind === 'notes' ? 'save the notes for' : p.kind} ${v}`));
    } finally {
      setPending(null);
    }
  };

  const columns: Column<ToolchainConsoleRelease>[] = [
    {
      id: 'release',
      header: 'Release',
      render: (r) => (
        <span className="block">
          <span className="font-mono font-medium">{r.releaseVersion}</span>
          {!r.complete && <> <Badge color="red">incomplete</Badge></>}
          <RelativeTime value={r.createdAt} className="block text-xs text-fg-muted" />
        </span>
      ),
    },
    {
      id: 'toolchain',
      header: 'Toolchain',
      cellClassName: 'max-w-xs text-xs',
      render: (r) => (r.toolchain ? toolchainVersionsText(r.toolchain) : <span className="text-warning">No toolchain metadata</span>),
    },
    {
      id: 'digests',
      header: 'Digests',
      cellClassName: 'font-mono',
      render: (r) => (
        <>
          <HalfCell label="bootstrap" half={r.halves.bootstrap} render={(h) => shortDigest(h.digest)} />
          <HalfCell label="synth" half={r.halves.synth} render={(h) => shortDigest(h.digest)} />
        </>
      ),
    },
    {
      id: 'scan',
      header: 'Scan',
      render: (r) => (
        <>
          <HalfCell label="bootstrap" half={r.halves.bootstrap} render={(h) => scanSummaryText(h.scan)} />
          <HalfCell label="synth" half={r.halves.synth} render={(h) => scanSummaryText(h.scan)} />
        </>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      render: (r) => (
        <span className="flex flex-col items-start gap-1">
          <Badge color={RELEASE_STATUS_COLOR[r.status]}>{RELEASE_STATUS_LABEL[r.status]}</Badge>
          {r.canaryOrgCount > 0 && <span className="text-xs text-fg-muted">{r.canaryOrgCount} canary org{r.canaryOrgCount === 1 ? '' : 's'}</span>}
        </span>
      ),
    },
    {
      id: 'notes',
      header: 'Notes',
      cellClassName: 'max-w-xs whitespace-pre-line text-xs',
      render: (r) => r.releaseNotes || <span className="text-fg-subtle">—</span>,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      locked: true,
      render: (r) => {
        const a = releaseActionAvailability(r);
        const btn = (label: string, enabled: boolean, onClick: () => void, variant: 'secondary' | 'danger-outline' = 'secondary') => (
          <Button
            type="button"
            size="xs"
            variant={variant}
            readOnly={!canWrite}
            disabled={!enabled}
            onClick={onClick}
            aria-label={`${label} ${r.releaseVersion}`}
          >
            {label}
          </Button>
        );
        return (
          <span className="flex flex-wrap gap-1">
            {btn('Edit notes', true, () => open('notes', r))}
            {btn('Add canary orgs', a.canary, () => onOpenCanary(r.releaseVersion))}
            {btn('Set as default', a.setDefault, () => { setError(null); setPromote(r.releaseVersion); })}
            {btn('Deprecate', a.deprecate, () => open('deprecate', r))}
            {btn('Yank', a.yank, () => open('yank', r), 'danger-outline')}
            {btn('Delete', a.delete, () => open('delete', r), 'danger-outline')}
          </span>
        );
      },
    },
  ];

  const pendingProps = pending ? modalCopy(pending, view.platformDefault) : null;

  return (
    <div className="space-y-3" data-testid="toolchain-releases">
      <p className="text-sm text-fg-muted">
        Platform default: <strong className="font-mono text-fg" data-testid="toolchain-platform-default">{view.platformDefault ?? 'none'}</strong>
      </p>
      {error && <ErrorAlert message={error} />}
      {yanked && (
        <Callout variant="info" title={`Release ${yanked.releaseVersion} yanked`} onDismiss={() => setYanked(null)}>
          <p data-testid="toolchain-yank-result">
            {yanked.restoredDefault
              ? <>The platform default was restored to <strong className="font-mono">{yanked.restoredDefault}</strong>.</>
              : yanked.wasDefault
                ? 'No earlier default could be restored; set a platform default now.'
                : 'The platform default did not change.'}
          </p>
        </Callout>
      )}
      <DataTable
        data={view.releases}
        columns={columns}
        isLoading={false}
        animated={false}
        getRowKey={(r) => r.releaseVersion}
        emptyState={{ icon: Package, title: 'No toolchain releases', description: 'Run deploy/bin/upgrade-toolchain.sh to build and load a release.' }}
      />

      {pending && pendingProps && (
        <StepUpModal
          title={pendingProps.title}
          action={pendingProps.action}
          details={(
            <div className="space-y-2 text-sm">
              {pendingProps.body && <p>{pendingProps.body}</p>}
              {(pending.kind === 'notes' || pending.kind === 'yank') && (
                <FormField
                  label={pending.kind === 'notes' ? 'Release notes' : 'Reason'}
                  hint={pending.kind === 'notes' ? 'Shown to org admins and on each pipeline\'s Build image row.' : 'Required. Recorded in the audit log.'}
                >
                  <Textarea
                    value={text}
                    maxLength={NOTES_MAX}
                    rows={pending.kind === 'notes' ? 5 : 2}
                    onChange={(e) => setText(e.target.value)}
                    aria-label={pending.kind === 'notes' ? 'Release notes' : 'Yank reason'}
                  />
                </FormField>
              )}
            </div>
          )}
          confirmDisabledReason={pending.kind === 'yank' && !text.trim() ? 'A reason is required to yank a release.' : null}
          onConfirmed={(token) => run(pending, token)}
          onClose={() => setPending(null)}
        />
      )}

      {promote && (
        <SetPlatformDefaultFlow
          releaseVersion={promote}
          onDone={() => { void onChanged(); }}
          onClose={() => setPromote(null)}
        />
      )}
    </div>
  );
}

function modalCopy(p: Pending, platformDefault: string | null): { title: string; action: string; body?: string } {
  const v = p.release.releaseVersion;
  switch (p.kind) {
    case 'notes':
      return { title: `Release notes for ${v}`, action: `Save the release notes for ${v}` };
    case 'deprecate':
      return {
        title: `Deprecate ${v}?`,
        action: `Deprecate toolchain release ${v}`,
        body: 'It can no longer be newly pinned or chosen as an org default. Pipelines and orgs already on it keep resolving it, with a warning.',
      };
    case 'yank':
      return {
        title: `Yank ${v}?`,
        action: `Yank toolchain release ${v}`,
        body: v === platformDefault
          ? `${v} is the platform default: yanking it restores the previous default, and pipelines following the platform default move on their next run.`
          : 'Pipelines pinned to it and orgs defaulting to it keep resolving it, with a warning, until they move.',
      };
    case 'delete':
      return {
        title: `Delete ${v}?`,
        action: `Delete toolchain release ${v}`,
        body: 'Both halves are deleted. A release any deployed pipeline, pin or org default still references is refused.',
      };
  }
}
