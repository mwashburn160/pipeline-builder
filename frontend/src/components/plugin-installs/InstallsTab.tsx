// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { PackageCheck } from 'lucide-react';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { RetryError } from '@/components/ui/RetryError';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Badge } from '@/components/ui/Badge';
import { TrustTierBadge } from '@/components/public-directory/TrustTierBadge';
import { useFetch } from '@/hooks/useFetch';
import { clearPluginCache } from '@/hooks/usePlugins';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { pluginPagePath } from '@/lib/public-directory/links';
import { entryFromInstall, INSTALL_STATUS_LABELS, listingUsage } from '@/lib/plugin-installs';
import type { InstallStatusFilter, InstallView } from '@/types/plugin-installs';
import { InstallControls } from './InstallControls';
import { InstallWarnings } from './InstallWarnings';

const STATUS_COLOR = { active: 'green', pending_approval: 'yellow', denied: 'red' } as const;

/**
 * The org's installs (§3.2), optionally with the automatic Official installs
 * (D16). Each row carries the same controls as the catalog: Upgrade (when a
 * version outside the policy's range exists), Change policy, Uninstall, or
 * Withdraw for a pending request. Rows inherited from the root org are read-only.
 */
export function InstallsTab({ canInstall, usage }: { canInstall: boolean; usage: Record<string, number> }) {
  const [status, setStatus] = useState<InstallStatusFilter>('all');
  const [implicit, setImplicit] = useState(false);

  const list = useFetch(async (signal): Promise<InstallView[]> => {
    const res = await api.listPluginInstalls({ status, implicit }, { signal });
    return res.data?.installs ?? [];
  }, [status, implicit]);
  const installs = list.data ?? [];
  const afterChange = () => { clearPluginCache(); list.refetch(); };

  return (
    <div className="space-y-4" data-testid="installs-tab">
      <div className="flex flex-wrap items-center gap-4">
        <FilterSelect aria-label="Install status" value={status} onChange={(e) => setStatus(e.target.value as InstallStatusFilter)}>
          <option value="all">All statuses</option>
          <option value="active">Installed</option>
          <option value="pending_approval">Pending approval</option>
          <option value="denied">Denied</option>
        </FilterSelect>
        <label className="flex items-center gap-2 text-sm text-fg">
          <Checkbox checked={implicit} onChange={(e) => setImplicit(e.target.checked)} />
          Show automatic Official installs
        </label>
      </div>

      {list.error && !list.data ? (
        <RetryError message={formatError(list.error, 'Could not load installs')} onRetry={list.refetch} />
      ) : list.loading && !list.data ? (
        <div className="flex items-center gap-2 py-6 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading installs…</div>
      ) : installs.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title="No installs"
          description={implicit
            ? 'Nothing matches this filter.'
            : 'Install listings from the Catalog tab. Official plugins are available automatically unless your policy says otherwise.'}
        />
      ) : (
        <ul className="divide-y divide-default rounded-xl border border-default" aria-label="Installs">
          {installs.map((install) => {
            const used = listingUsage({ publisherHandle: install.publisherHandle, name: install.name }, usage);
            return (
              <li key={install.id ?? `implicit:${install.listingId}`} className="flex flex-col gap-3 p-4 md:flex-row md:items-start md:justify-between" data-testid="install-row">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={pluginPagePath(install.publisherHandle, install.name)} className="font-mono text-sm font-semibold text-fg hover:text-brand hover:underline">
                      {install.publisherHandle}/{install.name}
                    </Link>
                    <TrustTierBadge tier={install.publisherTier} compact />
                    <Badge color={STATUS_COLOR[install.status]}>{INSTALL_STATUS_LABELS[install.status]}</Badge>
                    {install.implicit && <Badge color="blue">Automatic</Badge>}
                    {install.inherited && <Badge color="gray">From root organization</Badge>}
                    {install.paused && <Badge color="yellow">Paused</Badge>}
                  </div>
                  <p className="text-xs text-fg-muted">
                    {install.resolvedVersion ? `Resolves to v${install.resolvedVersion}` : 'Nothing resolves'}
                    {install.pinnedVersion ? ` · baseline v${install.pinnedVersion}` : ''}
                    {install.latestVersion ? ` · latest v${install.latestVersion}` : ''}
                    {used > 0 ? ` · used by ${used} pipeline${used === 1 ? '' : 's'}` : ''}
                  </p>
                  {install.upgrade && (
                    <p className="text-xs text-warning-strong">
                      Upgrade available: v{install.upgrade.version}{install.upgrade.breaking ? ' (breaking)' : ''}
                    </p>
                  )}
                  <InstallWarnings install={install} />
                </div>
                <InstallControls entry={entryFromInstall(install)} canInstall={canInstall} onChanged={afterChange} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
