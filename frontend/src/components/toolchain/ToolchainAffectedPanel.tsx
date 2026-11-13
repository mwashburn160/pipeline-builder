// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { BellRing, CheckCircle2 } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { ToolchainAffectedView } from '@/types/toolchain';

type OrgRow = ToolchainAffectedView['orgs'][number];

/** Pipeline ids listed per row before "+N more". */
const IDS_SHOWN = 5;

const COLUMNS: Column<OrgRow>[] = [
  { id: 'org', header: 'Organization', render: (o) => <span>{o.orgName} <span className="font-mono text-xs text-fg-muted">{o.orgId}</span></span> },
  { id: 'count', header: 'Pipelines', cellClassName: 'tabular-nums', render: (o) => o.pipelineCount },
  {
    id: 'ids',
    header: 'Pipeline ids',
    cellClassName: 'font-mono text-xs',
    render: (o) => (
      <span title={o.pipelineIds.join('\n')}>
        {o.pipelineIds.slice(0, IDS_SHOWN).join(', ')}
        {o.pipelineIds.length > IDS_SHOWN && <span className="text-fg-muted"> +{o.pipelineIds.length - IDS_SHOWN} more</span>}
      </span>
    ),
  },
];

/**
 * Affected (§9): pipelines deployed on a release whose latest synth failed, by
 * org. They can't heal themselves — the platform has no credentials in their
 * AWS accounts — so "Notify affected owners" sends each owner the redeploy
 * command, which re-synthesizes against the current default.
 */
export function ToolchainAffectedPanel({ releaseVersion, canWrite }: { releaseVersion: string; canWrite: boolean }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ notifiedOrgs: number; notifiedPipelines: number } | null>(null);

  const read = useFetch(async (signal) => (await api.getToolchainAffected(releaseVersion, { signal })).data ?? null, [releaseVersion], {
    onSuccess: () => setSent(null),
  });
  const data = read.data;
  if (!data) {
    return read.error
      ? <RetryError message={formatError(read.error, 'Could not load affected pipelines')} onRetry={read.refetch} />
      : <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading…</div>;
  }

  const pipelines = data.orgs.reduce((n, o) => n + o.pipelineCount, 0);

  const notify = async (token: string) => {
    setError(null);
    try {
      const res = await api.notifyToolchainAffected(releaseVersion, token);
      const r = res.data ?? { notifiedOrgs: 0, notifiedPipelines: 0 };
      setSent(r);
      toast.success(`Notified the owners of ${r.notifiedPipelines} pipeline${r.notifiedPipelines === 1 ? '' : 's'} in ${r.notifiedOrgs} org${r.notifiedOrgs === 1 ? '' : 's'}`);
    } catch (err) {
      setError(formatError(err, 'Could not notify the affected owners'));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="toolchain-affected">
      <p className="text-sm text-fg-muted">
        Pipelines deployed on <span className="font-mono">{releaseVersion}</span> whose latest synth failed.
        Each owner can recover with:
      </p>
      <CodeBlock code="pipeline-manager pipeline deploy --id <pipeline-id>" />
      {error && <ErrorAlert message={error} />}
      {sent && (
        <p className="flex items-center gap-1.5 text-sm text-success" data-testid="toolchain-notified">
          <CheckCircle2 className="h-4 w-4" /> Notified {sent.notifiedPipelines} pipeline owner{sent.notifiedPipelines === 1 ? '' : 's'} in {sent.notifiedOrgs} org{sent.notifiedOrgs === 1 ? '' : 's'}.
        </p>
      )}
      <div className="flex justify-end">
        <Button type="button" readOnly={!canWrite} disabled={pipelines === 0} onClick={() => setConfirming(true)}>
          <BellRing className="h-4 w-4" /> Notify affected owners
        </Button>
      </div>
      <DataTable
        data={data.orgs}
        columns={COLUMNS}
        isLoading={false}
        animated={false}
        getRowKey={(o) => o.orgId}
        emptyState={{ icon: CheckCircle2, title: 'No affected pipelines', description: 'No pipeline on this release has a failed latest synth.' }}
      />

      {confirming && (
        <StepUpModal
          title="Notify affected owners?"
          action={`Notify the owners of pipelines stranded on ${releaseVersion}`}
          details={(
            <p className="text-sm" data-testid="toolchain-notify-summary">
              The owners of {pipelines} pipeline{pipelines === 1 ? '' : 's'} in {data.orgs.length} org{data.orgs.length === 1 ? '' : 's'} are each sent the redeploy command for their pipeline.
            </p>
          )}
          onConfirmed={notify}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
