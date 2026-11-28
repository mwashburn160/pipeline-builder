// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system org's Toolchain console (docs/permissions.md, `toolchain:operate`): the managed toolchain releases (the `pipeline-bootstrap`
 * build image and the `cdk-synth` step, one release), their canary, adoption,
 * stranded pipelines, the platform-default history and cleanup. The three
 * per-release views (canary, adoption, affected) share the Rollout tab.
 *
 * The Releases tab also carries the "Toolchain fixes" card (nightly toolchain
 * fixes: propose-only release candidates), whose own gate is the system org
 * plus `plugins:write` — like the Official patch export.
 *
 * Read gate: `toolchain:operate`, declared once on the nav entry (page-access
 * derives it). The permission is system-org-only, so no tenant Role can carry
 * it; a superadmin holds it implicitly but, switched into a tenant org, is
 * acting as that tenant — the routes are system-org-only — so the page shows a
 * plain "not available" state there, like the Ecosystem console. Every write
 * steps up (`requireStepUp`) and a read-only session sees the console with
 * every write control locked.
 */

import { useState } from 'react';
import { Wrench } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useGroupedUrlTab } from '@/hooks/useGroupedUrlTab';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { GroupedTabs, type GroupedTabItem } from '@/components/ui/GroupedTabs';
import { ReleaseSelect } from '@/components/toolchain/ReleaseSelect';
import { ToolchainAdoptionPanel } from '@/components/toolchain/ToolchainAdoptionPanel';
import { ToolchainAffectedPanel } from '@/components/toolchain/ToolchainAffectedPanel';
import { ToolchainCanaryPanel } from '@/components/toolchain/ToolchainCanaryPanel';
import { ToolchainCleanupPanel } from '@/components/toolchain/ToolchainCleanupPanel';
import { ToolchainFixesCard } from '@/components/toolchain/ToolchainFixesCard';
import { ToolchainHistoryPanel } from '@/components/toolchain/ToolchainHistoryPanel';
import { ToolchainReleasesPanel } from '@/components/toolchain/ToolchainReleasesPanel';
import { isSystemOrgActive } from '@/lib/ecosystem-access';
import api from '@/lib/api';
import { hasPermission } from '@/lib/auth-helpers';
import { formatError } from '@/lib/constants';
import { TOOLCHAIN_TABS, type ToolchainSection, type ToolchainTab } from '@/lib/page-tabs/toolchain';

/** Rollout holds the three views of ONE release (they share the release picker). */
const TABS: readonly GroupedTabItem<ToolchainTab, ToolchainSection>[] = [
  { id: 'releases', label: 'Releases', name: 'Releases' },
  {
    id: 'rollout',
    label: 'Rollout',
    name: 'Rollout',
    sections: [
      { id: 'canary', label: 'Canary' },
      { id: 'adoption', label: 'Adoption' },
      { id: 'affected', label: 'Affected' },
    ],
  },
  { id: 'history', label: 'History', name: 'History' },
  { id: 'cleanup', label: 'Cleanup', name: 'Cleanup' },
];
const TAB_PREFIX = 'toolchain';

export default function ToolchainConsolePage() {
  const { accessDenied, user, isReady, isReadOnly, can } = useAuthGuard();
  // `?tab=` and, for Rollout, `?section=` (TOOLCHAIN_TABS).
  const { tab, section, select } = useGroupedUrlTab(TOOLCHAIN_TABS);
  const [picked, setPicked] = useState<string | null>(null);

  const allowed = isReady && isSystemOrgActive(user);
  const releases = useFetch(
    async (signal) => (await api.listToolchainReleases({ signal })).data ?? null,
    [allowed],
    { enabled: allowed },
  );

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  // The read gate admitted the viewer; a write also needs a writable session.
  const canWrite = can('toolchain:operate') && !isReadOnly;
  // The Toolchain fixes card's routes are system org + plugins:write. The read is a GET, which a read-only
  // session may still make, so the read gate is the raw permission (can() reports false for every mutation
  // permission in a read-only session); approve / reject also need a writable session.
  const canReviewFixes = hasPermission(user, 'plugins:write');
  const view = releases.data;
  // The per-release panels default to the canary, else the newest release. A
  // pick that a refresh no longer lists (deleted in Cleanup) falls back too.
  const pickedRelease = view?.releases.find((r) => r.releaseVersion === picked);
  const selectedRelease = pickedRelease ?? view?.releases.find((r) => r.status === 'canary') ?? view?.releases[0] ?? null;
  const selected = selectedRelease?.releaseVersion ?? null;

  const openCanary = (v: string) => { setPicked(v); select('rollout', 'canary'); };

  return (
    <DashboardLayout title="Toolchain" subtitle="Managed pipeline toolchain releases, canary and the platform default">
      {!allowed ? (
        <EmptyState
          icon={Wrench}
          title="Not available"
          description="The Toolchain console is only available in the system organization, to holders of the toolchain:operate permission (Platform Operator)."
        />
      ) : !view ? (
        releases.error
          ? <RetryError message={formatError(releases.error, 'Could not load toolchain releases')} onRetry={releases.refetch} />
          : <div className="flex items-center gap-2 py-6 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>
      ) : (
        <GroupedTabs items={TABS} tab={tab} section={section} onSelect={select} idPrefix={TAB_PREFIX} ariaLabel="Toolchain sections">
          <div className="space-y-4">
            {tab === 'rollout' && view.releases.length > 0 && selected && (
              <ReleaseSelect releases={view.releases} value={selected} onChange={setPicked} />
            )}
            {tab === 'releases' && (
              <ToolchainFixesCard allowed={canReviewFixes} canWrite={canReviewFixes && !isReadOnly} onPublished={releases.refetch} />
            )}
            {tab === 'releases' && (
              <ToolchainReleasesPanel view={view} canWrite={canWrite} onChanged={releases.refetch} onOpenCanary={openCanary} />
            )}
            {tab === 'rollout' && !selectedRelease && <p className="text-sm text-fg-muted">No toolchain releases yet.</p>}
            {section === 'canary' && selectedRelease && (
              <ToolchainCanaryPanel key={selectedRelease.releaseVersion} release={selectedRelease} canWrite={canWrite} onChanged={releases.refetch} />
            )}
            {section === 'adoption' && selectedRelease && <ToolchainAdoptionPanel releaseVersion={selectedRelease.releaseVersion} />}
            {section === 'affected' && selectedRelease && <ToolchainAffectedPanel releaseVersion={selectedRelease.releaseVersion} canWrite={canWrite} />}
            {tab === 'history' && <ToolchainHistoryPanel platformDefault={view.platformDefault} canWrite={canWrite} onChanged={releases.refetch} />}
            {tab === 'cleanup' && <ToolchainCleanupPanel canWrite={canWrite} onChanged={releases.refetch} />}
          </div>
        </GroupedTabs>
      )}
    </DashboardLayout>
  );
}
