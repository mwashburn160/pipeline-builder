// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system org's Toolchain console (docs/plans/bootstrap-image-versioning.md
 * §6, §8, §9, §11): the managed toolchain releases (the `pipeline-bootstrap`
 * build image and the `cdk-synth` step, one release), their canary, adoption,
 * stranded pipelines, the platform-default history and cleanup.
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
import { useUrlTab } from '@/hooks/useUrlTab';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { ReleaseSelect } from '@/components/toolchain/ReleaseSelect';
import { ToolchainAdoptionPanel } from '@/components/toolchain/ToolchainAdoptionPanel';
import { ToolchainAffectedPanel } from '@/components/toolchain/ToolchainAffectedPanel';
import { ToolchainCanaryPanel } from '@/components/toolchain/ToolchainCanaryPanel';
import { ToolchainCleanupPanel } from '@/components/toolchain/ToolchainCleanupPanel';
import { ToolchainHistoryPanel } from '@/components/toolchain/ToolchainHistoryPanel';
import { ToolchainReleasesPanel } from '@/components/toolchain/ToolchainReleasesPanel';
import { isSystemOrgActive } from '@/lib/ecosystem-access';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';

const TABS = [
  { id: 'releases', label: 'Releases' },
  { id: 'canary', label: 'Canary' },
  { id: 'adoption', label: 'Adoption' },
  { id: 'affected', label: 'Affected' },
  { id: 'history', label: 'History' },
  { id: 'cleanup', label: 'Cleanup' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const TAB_IDS = TABS.map((t) => t.id);
const TAB_PREFIX = 'toolchain';
/** Tabs that look at one release (and show the release picker). */
const PER_RELEASE: readonly TabId[] = ['canary', 'adoption', 'affected'];

export default function ToolchainConsolePage() {
  const { accessDenied, user, isReady, isReadOnly, can } = useAuthGuard();
  const [tab, setTab] = useUrlTab<TabId>('tab', TAB_IDS, 'releases');
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
  const view = releases.data;
  // The per-release panels default to the canary, else the newest release.
  const selected = picked ?? view?.releases.find((r) => r.status === 'canary')?.releaseVersion ?? view?.releases[0]?.releaseVersion ?? null;
  const selectedRelease = view?.releases.find((r) => r.releaseVersion === selected) ?? null;

  const openCanary = (v: string) => { setPicked(v); setTab('canary'); };

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
        <>
          <TabBar
            items={TABS.map(({ id, label }) => ({ id, label }))}
            activeId={tab}
            onSelect={(id) => setTab(id as TabId)}
            idPrefix={TAB_PREFIX}
            ariaLabel="Toolchain sections"
            className="mb-4"
          />
          <div {...tabPanelProps(TAB_PREFIX, tab)} className="space-y-4">
            {PER_RELEASE.includes(tab) && view.releases.length > 0 && selected && (
              <ReleaseSelect releases={view.releases} value={selected} onChange={setPicked} />
            )}
            {tab === 'releases' && (
              <ToolchainReleasesPanel view={view} canWrite={canWrite} onChanged={releases.refetch} onOpenCanary={openCanary} />
            )}
            {PER_RELEASE.includes(tab) && !selectedRelease && <p className="text-sm text-fg-muted">No toolchain releases yet.</p>}
            {tab === 'canary' && selectedRelease && (
              <ToolchainCanaryPanel key={selectedRelease.releaseVersion} release={selectedRelease} canWrite={canWrite} onChanged={releases.refetch} />
            )}
            {tab === 'adoption' && selectedRelease && <ToolchainAdoptionPanel releaseVersion={selectedRelease.releaseVersion} />}
            {tab === 'affected' && selectedRelease && <ToolchainAffectedPanel releaseVersion={selectedRelease.releaseVersion} canWrite={canWrite} />}
            {tab === 'history' && <ToolchainHistoryPanel platformDefault={view.platformDefault} canWrite={canWrite} onChanged={releases.refetch} />}
            {tab === 'cleanup' && <ToolchainCleanupPanel canWrite={canWrite} onChanged={releases.refetch} />}
          </div>
        </>
      )}
    </DashboardLayout>
  );
}
