// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline detail page.
 *
 * Lightweight surface that gives the recent-runs and executions tables a
 * real link target. Renders the pipeline identity (name, project,
 * organization), access/default/active badges, an inline edit + delete
 * flow, and a slim recent-runs summary derived from the execution-count
 * report (no per-pipeline executions endpoint exists yet, so the row is
 * filtered out of the org-wide aggregate).
 */

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useUrlTab } from '@/hooks/useUrlTab';
import Link from 'next/link';
import { ArrowLeft, Ban } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { TAP_TARGET } from '@/components/ui/responsive';
import { TabBar } from '@/components/ui/TabBar';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { RetryError } from '@/components/ui/RetryError';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Modal } from '@/components/ui/Modal';
import { PipelineSecurityTab } from '@/components/pipeline/security/PipelineSecurityTab';
import { RunRequestStatus } from '@/components/pipeline/RunRequestStatus';
import { PipelineRegistrationBanner } from '@/components/pipeline/PipelineDeployGuidance';
import { DeployPipelinePanel } from '@/components/pipeline/DeployPipelinePanel';
import { RegisterDeploymentModal } from '@/components/deployments/RegisterDeploymentModal';
import { RunWithRunnerModal } from '@/components/pipeline/RunWithRunnerModal';
import { PipelineStackNotice } from '@/components/pipeline/PipelineStackNotice';
import { RunnerLinkBanners, useRunnerLink } from '@/components/pipeline/RunnerLinkStatus';
import { DETAIL_TABS, DETAIL_TAB_IDS, type DetailTab } from '@/components/pipeline/detail/pipeline-detail-model';
import { usePipelineDetailData } from '@/components/pipeline/detail/usePipelineDetailData';
import { usePipelineDetailActions } from '@/components/pipeline/detail/usePipelineDetailActions';
import { PipelineDetailHeaderActions } from '@/components/pipeline/detail/PipelineDetailHeaderActions';
import { PipelineOverviewTab } from '@/components/pipeline/detail/PipelineOverviewTab';
import { PipelineRunsTab } from '@/components/pipeline/detail/PipelineRunsTab';
import { RunnerStepUpDialogs } from '@/components/pipeline/detail/RunnerStepUpDialogs';
import { canWritePipeline } from '@/lib/resource-helpers';
import { formatError } from '@/lib/constants';

// The edit wizard and save-as-template modal load on first use.
const EditPipelineModal = dynamic(() => import('@/components/pipeline/EditPipelineModal'), { ssr: false });
const CreateTemplateModal = dynamic(() => import('@/components/pipeline/CreateTemplateModal').then((m) => m.CreateTemplateModal), { ssr: false });

export default function PipelineDetailPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  // Keyed by id: this page is reached by same-pathname navigation (⌘K jumps
  // between pipelines), which does NOT remount it. Without the key every piece
  // of state below — the loaded record, the runs list, an open delete/cancel
  // dialog — would carry over from the previous pipeline, and its actions
  // would split between the two (delete the old record, trigger the new id).
  return <PipelineDetail key={id} id={id} />;
}

function PipelineDetail({ id }: { id: string }) {
  const router = useRouter();
  const { accessDenied, isReady, user, isSuperAdmin, can } = useAuthGuard();
  // The pipeline's link to its runner (every run goes through one): the
  // Deployment card's "Runs via", Find runner again, and the pause / unhealthy banners.
  const runnerLink = useRunnerLink(id);
  const [runnerStepUp, setRunnerStepUp] = useState<'find' | 'test' | null>(null);

  // Detail sections split into Overview (metadata) + Runs (recent runs +
  // executions) so it isn't one long scroll. Deep-linkable via `?tab=` (kept
  // separate from the `?id` route param).
  const [activeTab, changeTab] = useUrlTab<DetailTab>('tab', DETAIL_TAB_IDS, 'overview');

  const data = usePipelineDetailData(id, user?.organizationId, activeTab);
  const { pipeline, fetching, fetchError, reloadPipeline, executions } = data;

  const actions = usePipelineDetailActions({ id, pipeline, runnerLink, can, loadExecutions: data.loadExecutions });
  const {
    actionError, setActionError, reportActionError, runRequests, trigger, triggering, runTrigger, handleTrigger, runWith,
    cancelTarget, setCancelTarget, canceling, confirmCancel, showDelete, setShowDelete, deleting, confirmDelete,
    showRegister, setShowRegister, runAfterRegister, setRunAfterRegister, showRunWith, setShowRunWith,
  } = actions;

  const [showEdit, setShowEdit] = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  // Saving as a template is a TEMPLATE write (`POST /pipeline-templates` gates on
  // `templates:write`, and the public rung on `templates:publish`) — not a
  // pipeline write, which a member can hold without either.
  const canWriteTemplate = can('templates:write');
  const canPublishTemplate = can('templates:publish');

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  // Write controls (run / cancel / edit / delete) require BOTH the
  // `pipelines:write` capability and ownership of the resource — the backend
  // gates every pipeline mutation on `pipelines:write`, so a read-only member
  // must not see them enabled (matches the list page).
  const canEdit = pipeline ? canWritePipeline(can, isSuperAdmin, pipeline, user?.id, user?.organizationId) : false;

  return (
    <DashboardLayout
      title={pipeline?.pipelineName || pipeline?.project || 'Pipeline'}
      subtitle="Pipeline detail"
      breadcrumbs={[
        { label: 'Pipelines', href: '/dashboard/pipelines' },
        { label: pipeline?.pipelineName || pipeline?.project || 'Pipeline' },
      ]}
      actions={pipeline ? (
        <PipelineDetailHeaderActions
          canEdit={canEdit}
          canWriteTemplate={canWriteTemplate}
          triggering={triggering}
          hasRuns={!!executions && executions.length > 0}
          onTrigger={handleTrigger}
          onEdit={() => setShowEdit(true)}
          onSaveTemplate={() => setShowSaveTemplate(true)}
          onDelete={() => setShowDelete(true)}
        />
      ) : undefined}
    >
      <div className="mb-4">
        <Link href="/dashboard/pipelines" className="action-link inline-flex items-center gap-1 text-sm max-sm:min-h-11">
          <ArrowLeft className="w-4 h-4" /> Back to pipelines
        </Link>
      </div>

      {/* Never hidden behind a loaded copy: a failed reload says so, and the
          copy below is labelled as the last one that loaded. */}
      {fetchError && (
        <RetryError
          message={pipeline
            ? `${formatError(fetchError, 'Failed to refresh pipeline')} — showing the last loaded copy.`
            : formatError(fetchError, 'Failed to load pipeline')}
          onRetry={reloadPipeline}
          className="mb-4"
        />
      )}
      <ErrorAlert message={actionError} onDismiss={() => setActionError(null)} />

      <RunnerLinkBanners
        link={runnerLink.link}
        canTest={can('org_settings:write')}
        onTest={() => setRunnerStepUp('test')}
      />

      {/* A Re-run / Stop queued for a pipeline runner, until it settles. */}
      {runRequests.active.map((r) => <RunRequestStatus key={r.requestId} request={r} />)}

      {/* Unregistered ⇒ no events ⇒ every report below is legitimately empty.
          Without this the Runs tab, the scorecard and DORA all read as broken.
          Never deployed (the normal state after create) reads differently from
          deployed-but-unregistered. */}
      {pipeline?.registration && (
        <PipelineRegistrationBanner
          className="mb-4"
          pipelineId={pipeline.id}
          registered={pipeline.registration.registered}
          hasEvents={pipeline.registration.hasEvents}
          onRegister={can('pipeline_registry:write') ? () => { setRunAfterRegister(false); setShowRegister(true); } : undefined}
        />
      )}
      {showRegister && pipeline && (
        <RegisterDeploymentModal
          configs={[{ id: pipeline.id, pipelineName: pipeline.pipelineName, project: pipeline.project, organization: pipeline.organization }]}
          initialPipelineId={pipeline.id}
          lockPipeline
          // The Deploy panel is on this page (when it can be edited): close the dialog onto it.
          onDeployInstead={canEdit ? () => setShowRegister(false) : undefined}
          onClose={() => setShowRegister(false)}
          onRegistered={() => { void reloadPipeline(); void runnerLink.refetch(); }}
          // Register and run: start the run once the chosen runner linked it.
          onLinked={runAfterRegister ? () => { setShowRegister(false); void runTrigger(pipeline.id); } : undefined}
        />
      )}
      {showRunWith && pipeline && (
        <RunWithRunnerModal
          pipelineId={pipeline.id}
          pipelineLabel={pipeline.pipelineName || pipeline.id}
          running={trigger.pending}
          onRun={(runnerId) => { void runWith(runnerId); }}
          onClose={() => setShowRunWith(false)}
        />
      )}
      {/* Never deployed and editable: deploy it through a pipeline runner from here. */}
      {pipeline?.registration && !pipeline.registration.registered && !pipeline.registration.hasEvents && canEdit && (
        <DeployPipelinePanel className="mb-4 rounded-xl border border-default p-4" pipelineId={pipeline.id} onDeployed={() => { void reloadPipeline(); }} />
      )}

      {fetching && !pipeline && <LoadingSpinner />}

      {pipeline && (
        <>
        <TabBar items={[...DETAIL_TABS]} activeId={activeTab} onSelect={(tabId) => changeTab(tabId as DetailTab)} className="mb-4" />

        {activeTab === 'overview' && (
          <PipelineOverviewTab
            pipeline={pipeline}
            deployment={data.deployment}
            stackConsoleUrl={data.stackConsoleUrl}
            runnerLink={runnerLink}
            canEdit={canEdit}
            memberNames={data.memberNames}
            onFindRunnerAgain={() => setRunnerStepUp('find')}
          />
        )}

        {activeTab === 'security' && <PipelineSecurityTab pipelineId={pipeline.id} canWrite={canEdit} />}

        {activeTab === 'runs' && (
          <PipelineRunsTab data={data} canEdit={canEdit} canceling={canceling} cancelTarget={cancelTarget} onCancel={setCancelTarget} />
        )}
        </>
      )}

      {showEdit && pipeline && (
        <EditPipelineModal
          pipeline={pipeline}
          canPublish={can('pipelines:publish')}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); reloadPipeline(); }}
        />
      )}

      {showSaveTemplate && pipeline && (
        <CreateTemplateModal
          pipeline={pipeline}
          canPublish={canPublishTemplate}
          onClose={() => setShowSaveTemplate(false)}
          onCreated={() => setShowSaveTemplate(false)}
        />
      )}

      {cancelTarget && (
        <Modal
          title="Cancel execution"
          onClose={() => { if (!canceling) setCancelTarget(null); }}
          footer={(
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setCancelTarget(null)} disabled={canceling} className={`max-sm:flex-1 ${TAP_TARGET}`}>
                Keep running
              </Button>
              <Button variant="danger" onClick={confirmCancel} disabled={canceling} className={`inline-flex items-center gap-2 max-sm:flex-1 ${TAP_TARGET}`}>
                {canceling ? <LoadingSpinner size="sm" /> : <Ban className="w-4 h-4" />}
                Cancel execution
              </Button>
            </div>
          )}
        >
          <p className="text-sm text-fg-muted">
            Stop the in-progress execution <code className="text-xs break-all">{cancelTarget}</code>? In-progress
            stages will be halted. This cannot be undone.
          </p>
        </Modal>
      )}

      <RunnerStepUpDialogs
        open={runnerStepUp}
        runnerLink={runnerLink}
        reportActionError={reportActionError}
        setActionError={setActionError}
        onClose={() => setRunnerStepUp(null)}
      />

      {showDelete && pipeline && (
        <DeleteConfirmModal
          title="Delete pipeline"
          itemName={pipeline.pipelineName || 'Unnamed Pipeline'}
          loading={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setShowDelete(false)}
        >
          {(pipeline.registration?.registered || pipeline.registration?.hasEvents) && (
            <PipelineStackNotice
              purge={false}
              source={{
                kind: 'live',
                stackName: pipeline.registration?.stackName ?? null,
                region: pipeline.registration?.region ?? null,
                // The link's runner (null: none linked); unread link → both outcomes.
                runner: runnerLink.link ? runnerLink.link.runner : undefined,
              }}
            />
          )}
        </DeleteConfirmModal>
      )}
    </DashboardLayout>
  );
}
