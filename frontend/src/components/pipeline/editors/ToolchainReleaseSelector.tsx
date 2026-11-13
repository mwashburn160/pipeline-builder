// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId } from 'react';
import { Select } from '@/components/ui/Select';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import {
  RELEASE_STATUS_LABEL, compareReleaseVersions, followDefaultLabel, isReleaseSelectable, releaseWarnings,
  scanSummaryText, toolchainVersionsText,
} from '@/lib/toolchain';
import type { ToolchainEligibleView, ToolchainOrgDefaultView } from '@/types/toolchain';

interface Props {
  /** The pinned release, or `''` to follow the default (no `props.toolchain`). */
  value: string;
  onChange: (release: string) => void;
  disabled?: boolean;
}

/**
 * The pipeline editor's "Toolchain" selector (docs/plans/
 * bootstrap-image-versioning.md §5, §11): follow the default — the org's own,
 * or the platform's — or pin the whole managed release (build image +
 * `cdk-synth`) to one eligible version. Yanked and deprecated releases are
 * labelled and can't be NEWLY chosen; a pipeline already pinned to one keeps
 * it (and sees why it should move). A pin older than the effective default
 * shows "behind default".
 */
export default function ToolchainReleaseSelector({ value, onChange, disabled }: Props) {
  const uid = useId();
  const read = useFetch(async (signal): Promise<{ view: ToolchainOrgDefaultView | null; eligible: ToolchainEligibleView | null }> => {
    const [viewRes, eligibleRes] = await Promise.all([
      api.getToolchainOrgDefault({ signal }),
      api.getToolchainEligible({ signal }),
    ]);
    return { view: viewRes.data ?? null, eligible: eligibleRes.data ?? null };
  }, []);
  const view = read.data?.view ?? null;
  const releases = read.data?.eligible?.releases ?? [];
  const platformDefault = read.data?.eligible?.platformDefault ?? view?.platformDefault ?? null;

  const pinned = value.trim();
  const pinnedRelease = pinned ? releases.find((r) => r.releaseVersion === pinned) : undefined;
  const effectiveDefault = view?.effective.releaseVersion ?? null;
  const behind = !!pinned && !!effectiveDefault && compareReleaseVersions(pinned, effectiveDefault) < 0;
  const warnings = pinned && read.data ? releaseWarnings(pinned, platformDefault, releases) : [];

  return (
    <div className="space-y-2" data-testid="toolchain-selector">
      <label className="label" htmlFor={`${uid}-release`}>Toolchain release</label>
      <Select
        id={`${uid}-release`}
        value={pinned}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">{followDefaultLabel(view)}</option>
        {releases.map((r) => {
          const selectable = isReleaseSelectable(r) || r.releaseVersion === pinned;
          const tags = [RELEASE_STATUS_LABEL[r.status], r.relation !== 'current' ? r.relation : null].filter(Boolean).join(', ');
          return (
            <option key={r.releaseVersion} value={r.releaseVersion} disabled={!selectable}>
              {r.releaseVersion} ({tags})
            </option>
          );
        })}
        {/* A pin the list no longer offers stays visible rather than silently reading as "follow". */}
        {pinned && !pinnedRelease && read.data && <option value={pinned}>{pinned} (no longer offered)</option>}
        {pinned && !read.data && <option value={pinned}>{pinned}</option>}
      </Select>
      <p className="text-xs text-fg-subtle">
        Pins the build image and the cdk-synth step together. Leave on the default to move with your organization&apos;s
        choice on each run.
      </p>
      {read.error && (
        <p className="text-xs text-danger">{formatError(read.error, 'Could not load the toolchain releases')}</p>
      )}
      {pinnedRelease && (
        <p className="text-xs text-fg-muted">
          {toolchainVersionsText(pinnedRelease.toolchain)} · Scan: {scanSummaryText(pinnedRelease.scan)}
        </p>
      )}
      {behind && (
        <p className="text-xs text-warning-strong" data-testid="toolchain-behind">
          Behind default: unpinned pipelines run {effectiveDefault}.
        </p>
      )}
      {warnings.map((w) => <p key={w} className="text-xs text-warning-strong">{w}</p>)}
    </div>
  );
}
