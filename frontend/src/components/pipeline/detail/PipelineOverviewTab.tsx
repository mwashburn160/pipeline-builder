// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The pipeline detail page's Overview tab: scorecard, context, deployment and identity. */

import Link from 'next/link';
import { ExternalLink, GitBranch, Rocket } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { visibilityColor } from '@/components/ui/visibility-rungs';
import { Badge } from '@/components/ui/Badge';
import { CopyableId } from '@/components/ui/CopyableId';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { LifecycleBadge } from '@/components/ui/LifecycleBadge';
import { ScorecardCard } from '@/components/pipeline/ScorecardCard';
import { PipelineContextCard } from '@/components/pipeline/PipelineContextCard';
import { RunnerLinkRow, type useRunnerLink } from '@/components/pipeline/RunnerLinkStatus';
import type { PipelineDeployment } from '@/lib/api/domains/pipelines';
import type { PipelineWithRegistration } from './pipeline-detail-model';

interface PipelineOverviewTabProps {
  pipeline: PipelineWithRegistration;
  deployment: PipelineDeployment | null;
  stackConsoleUrl: string | null | undefined;
  runnerLink: ReturnType<typeof useRunnerLink>;
  canEdit: boolean;
  memberNames: Record<string, string>;
  onFindRunnerAgain: () => void;
}

export function PipelineOverviewTab({ pipeline, deployment, stackConsoleUrl, runnerLink, canEdit, memberNames, onFindRunnerAgain }: PipelineOverviewTabProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Per-pipeline maturity scorecard (renders only when advanced_reporting is on) */}
      <ScorecardCard pipelineId={pipeline.id} />
      {/* Cross-resource context: plugins used + live compliance posture */}
      <PipelineContextCard pipeline={pipeline} />
      {/* Live deployment (registry) — where this pipeline is deployed + a
          deep link to its CloudFormation stack. Hidden until registered. */}
      {deployment && (
        <Card className="min-w-0">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Rocket className="w-5 h-5 text-fg-muted" />
              <h3 className="text-base font-semibold text-fg">Deployment</h3>
            </div>
            <Link href="/dashboard/deployments" className="action-link text-xs">All deployments →</Link>
          </div>
          <dl className="text-sm space-y-2">
            <div className="flex justify-between">
              <dt className="text-fg-muted">Region</dt>
              <dd>{deployment.region || '—'}</dd>
            </div>
            {/* The pipeline runner every run goes through, by LABEL — the
                registry never carries the customer's account number. */}
            {runnerLink.link && (
              <RunnerLinkRow link={runnerLink.link} stalled={runnerLink.stalled} canRefresh={canEdit} onFindAgain={onFindRunnerAgain} />
            )}
            <div className="flex justify-between gap-2">
              <dt className="text-fg-muted">Stack</dt>
              {/* Wraps, with a copy button: a stack name is what an operator pastes
                into the AWS console, and truncated it could not be read on a phone. */}
              <dd className="min-w-0 text-right">
                {deployment.stackName ? <CopyableId value={deployment.stackName} size="sm" label="Copy stack name" /> : '—'}
              </dd>
            </div>
            {deployment.lastDeployed && (
              <div className="flex justify-between">
                <dt className="text-fg-muted">Deployed</dt>
                <dd><RelativeTime value={deployment.lastDeployed} /></dd>
              </div>
            )}
          </dl>
          {stackConsoleUrl && (
            <a
              href={stackConsoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="action-link text-xs inline-flex items-center gap-1 mt-3"
            >
              <ExternalLink className="w-3.5 h-3.5" /> View stack in AWS
            </a>
          )}
        </Card>
      )}
      {/* Identity card */}
      <Card className="min-w-0">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-fg-muted" />
            <h3 className="text-base font-semibold text-fg">Identity</h3>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Badge color={visibilityColor(pipeline.visibility)}>{pipeline.visibility}</Badge>
            <Badge color={pipeline.isActive ? 'green' : 'red'}>{pipeline.isActive ? 'Active' : 'Inactive'}</Badge>
            {pipeline.isDefault && <Badge color="blue">Default</Badge>}
          </div>
        </div>
        <dl className="text-sm space-y-2">
          <div>
            <dt className="text-fg-muted">Pipeline id</dt>
            <dd><CopyableId value={pipeline.id} size="sm" /></dd>
          </div>
          <div>
            <dt className="text-fg-muted">Name</dt>
            <dd>{pipeline.pipelineName || <span className="text-fg-subtle">Unnamed</span>}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">Project</dt>
            <dd>{pipeline.project}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">Organization</dt>
            <dd>{pipeline.organization}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">Owner</dt>
            <dd>
              {pipeline.ownerId
                ? <>{memberNames[pipeline.ownerId] ?? <code className="text-xs break-all">{pipeline.ownerId}</code>}{pipeline.ownerType ? <span className="text-fg-subtle"> ({pipeline.ownerType})</span> : null}</>
                : <span className="text-fg-subtle">Unassigned</span>}
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted">Lifecycle</dt>
            <dd className="flex flex-wrap items-center gap-1">
              <LifecycleBadge value={pipeline.lifecycle} />
              {pipeline.criticality ? <span className="text-fg-subtle"> · {pipeline.criticality} criticality</span> : null}
            </dd>
          </div>
          {pipeline.description && (
            <div>
              <dt className="text-fg-muted">Description</dt>
              <dd className="break-words">{pipeline.description}</dd>
            </div>
          )}
          {pipeline.keywords && pipeline.keywords.length > 0 && (
            <div>
              <dt className="text-fg-muted">Keywords</dt>
              <dd className="flex flex-wrap gap-1">
                {pipeline.keywords.map((k, i) => (
                  <span key={`${k}-${i}`} className="px-2 py-0.5 rounded-full text-xs bg-surface-muted text-fg-muted">{k}</span>
                ))}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-fg-muted">Created</dt>
            <dd><RelativeTime value={pipeline.createdAt} /> by {pipeline.createdBy ? (memberNames[pipeline.createdBy] ?? <code className="text-xs break-all">{pipeline.createdBy}</code>) : '—'}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">Updated</dt>
            <dd><RelativeTime value={pipeline.updatedAt} /> by {pipeline.updatedBy ? (memberNames[pipeline.updatedBy] ?? <code className="text-xs break-all">{pipeline.updatedBy}</code>) : '—'}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
