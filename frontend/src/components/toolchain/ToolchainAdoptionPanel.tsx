// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { TOOLCHAIN_RESOLVED_VIA } from '@pipeline-builder/api-core/plugin-catalog';
import { Download, Users } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { datedFilename, downloadCsv } from '@/lib/csv-export';
import type { ToolchainAdoptionView, ToolchainResolvedVia } from '@/types/toolchain';

type OrgRow = ToolchainAdoptionView['orgs'][number];

/** The tile label per resolution (keyed by api-core's vocabulary, so a new
 *  resolution is a compile error rather than a missing tile). Tiles run least
 *  specific first: api-core's most-specific-first list, reversed. */
const VIA_LABEL: Record<ToolchainResolvedVia, string> = {
  default: 'Platform default',
  canary: 'Canary',
  'org-default': 'Org default',
  pin: 'Pinned',
};
const VIA = [...TOOLCHAIN_RESOLVED_VIA].reverse().map((id) => ({ id, label: VIA_LABEL[id] }));

const COLUMNS: Column<OrgRow>[] = [
  { id: 'org', header: 'Organization', render: (o) => <span>{o.orgName} <span className="font-mono text-xs text-fg-muted">{o.orgId}</span></span>, sortValue: (o) => o.orgName },
  { id: 'pipelines', header: 'Pipelines', cellClassName: 'tabular-nums', render: (o) => o.pipelines, sortValue: (o) => o.pipelines },
  { id: 'pinned', header: 'Pinned', cellClassName: 'tabular-nums', render: (o) => o.pinned, sortValue: (o) => o.pinned },
  { id: 'orgDefault', header: 'Org default', render: (o) => (o.orgDefault ? <Badge color="blue">On this release</Badge> : <span className="text-fg-subtle">—</span>) },
];

/** The CSV columns, in order. */
export const ADOPTION_CSV_HEADERS = ['releaseVersion', 'orgId', 'orgName', 'pipelines', 'pinned', 'orgDefault'] as const;

/**
 * Adoption (§11): pipelines on a release across all orgs, from deployed
 * manifests and pins — by how they resolve it, and per org — with a CSV export.
 */
export function ToolchainAdoptionPanel({ releaseVersion }: { releaseVersion: string }) {
  const read = useFetch(async (signal) => (await api.getToolchainAdoption(releaseVersion, { signal })).data ?? null, [releaseVersion]);
  const data = read.data;
  if (!data) {
    return read.error
      ? <RetryError message={formatError(read.error, 'Could not load adoption')} onRetry={read.refetch} />
      : <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>;
  }

  const exportCsv = () => downloadCsv(
    data.orgs.map((o) => ({ releaseVersion: data.releaseVersion, ...o })),
    ADOPTION_CSV_HEADERS,
    datedFilename(`toolchain-adoption-${data.releaseVersion}`),
  );

  return (
    <div className="space-y-4" data-testid="toolchain-adoption">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="toolchain-adoption-via">
        {VIA.map(({ id, label }) => (
          <div key={id} className="rounded-lg border border-default p-3">
            <dt className="text-xs text-fg-muted">{label}</dt>
            <dd className="text-xl font-semibold tabular-nums" data-via={id}>{data.byResolvedVia[id] ?? 0}</dd>
          </div>
        ))}
      </dl>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="secondary" disabled={data.orgs.length === 0} onClick={exportCsv}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>
      <DataTable
        data={data.orgs}
        columns={COLUMNS}
        isLoading={false}
        animated={false}
        defaultSortColumn="pipelines"
        defaultSortDirection="desc"
        getRowKey={(o) => o.orgId}
        emptyState={{ icon: Users, title: 'No pipelines on this release', description: 'No deployed manifest, pin or org default references it.' }}
      />
    </div>
  );
}
