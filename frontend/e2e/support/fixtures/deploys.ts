// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A never-deployed pipeline and the deploy-through-a-runner endpoints its
 * detail page's Deploy panel drives: targets, start (step-up gated), the
 * polled deploy, cancel and the latest deploy it resumes on mount.
 */

import type { Backend, StubReply } from '../backend';

export const PIPELINE_ID = '55555555-5555-4555-8555-555555555555';
export const RUNNER_DEFAULT = '66666666-6666-4666-8666-666666666666';
export const RUNNER_PROD = '77777777-7777-4777-8777-777777777777';
export const RUNNER_OLD = '88888888-8888-4888-8888-888888888888';

const P = `/api/pipelines/${PIPELINE_ID}`;
const ok = (data: unknown): StubReply => ({ json: { success: true, data } });

export const PIPELINE = {
  id: PIPELINE_ID, orgId: 'org-1', project: 'web', organization: 'acme', pipelineName: 'acme-web-pipeline',
  description: '', keywords: [], props: {}, visibility: 'org', isActive: true, isDefault: false,
  ownerId: 'u-1', ownerType: 'user', createdBy: 'u-1', createdAt: '2026-11-01T00:00:00Z', updatedBy: 'u-1', updatedAt: '2026-11-01T00:00:00Z',
};

export const TARGETS = {
  pipelineId: PIPELINE_ID, available: true, unavailableReason: null, alreadyDeployed: false, activeRequestId: null,
  runners: [
    { id: RUNNER_DEFAULT, label: 'default', isOwn: true, ownerOrgName: null, regions: ['us-east-1'], deployable: true, reason: null },
    { id: RUNNER_PROD, label: 'prod', isOwn: true, ownerOrgName: null, regions: ['us-east-1'], deployable: true, reason: null },
    { id: RUNNER_OLD, label: 'legacy', isOwn: true, ownerOrgName: null, regions: ['us-east-1'], deployable: false, reason: 'update_required' },
  ],
  autoRunnerId: null,
  setupCommand: 'pipeline-manager infra setup-runner --enable-deploy',
};

export type DeployState = Record<string, unknown> & { requestId: string; status: string; stage: string };

/** A deploy as `GET …/deploys/:requestId` reports it. */
export function deploy(over: Partial<DeployState> & { requestId: string }): DeployState {
  return {
    pipelineId: PIPELINE_ID, status: 'queued', stage: 'queued', runnerId: RUNNER_PROD, runnerLabel: 'prod', region: 'us-east-1',
    errorCode: null, failureClass: null, retryable: false, requestedAt: '2026-11-27T10:00:00Z',
    acceptedAt: null, finishedAt: null, deadlineAt: null, logHint: null,
    ...over,
  };
}

/**
 * The pipeline page, never deployed, with the Deploy panel's endpoints. The
 * returned `deploys` map is the server's view: a spec moves a deploy along by
 * replacing its entry, and every poll reads it.
 */
export function stubDeployablePipeline(api: Backend, opts: { latest?: DeployState | null } = {}) {
  const deploys = new Map<string, DeployState>();
  if (opts.latest) deploys.set(opts.latest.requestId, opts.latest);
  api.on(`GET ${P}`, ok({ pipeline: PIPELINE, registration: { registered: false, hasEvents: false, lastDeployed: null, stackName: null, region: null } }));
  api.on(`GET ${P}/deploy-targets`, ok(TARGETS));
  api.on(`GET ${P}/register-runners`, ok({ pipelineId: PIPELINE_ID, available: true, unavailableReason: null, runners: [], registered: false, hasEvents: false, linkedRunnerId: null }));
  api.on(`GET ${P}/deploys/latest`, () => (opts.latest ? ok(deploys.get(opts.latest.requestId)) : { status: 404, json: { success: false, message: 'No deploy yet' } }));
  api.on('POST /api/auth/step-up', ok({ ok: true, stepUpToken: 'su-deploy', expiresAt: Date.now() + 300_000, method: 'password' }));
  return {
    deploys,
    /** Answer polls of `requestId` from the map. */
    poll(requestId: string) {
      api.on(`GET ${P}/deploys/${requestId}`, () => ok(deploys.get(requestId)));
    },
    path: P,
  };
}
