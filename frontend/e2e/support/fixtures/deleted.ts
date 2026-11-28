// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Soft-deleted pipelines for the Recently deleted panel (`GET /pipelines/deleted`). */

/** Long past: the retention sweep's date has gone by, so a still-deployed row says why it is kept. */
const PAST = '2020-01-01T00:00:00Z';
/** Far ahead: the row shows its purge date. */
const FUTURE = '2099-06-15T00:00:00Z';

function tombstone(id: string, pipelineName: string, over: Record<string, unknown>) {
  return {
    id, orgId: 'org-1', project: pipelineName.split('-')[1], organization: 'acme', pipelineName, description: '', keywords: [], props: {},
    visibility: 'org', isActive: false, isDefault: false, ownerId: 'u-1', ownerType: 'user',
    createdBy: 'u-1', createdAt: '2026-10-01T00:00:00Z', updatedBy: 'u-1', updatedAt: '2026-11-20T00:00:00Z',
    deletedAt: '2026-11-20T00:00:00Z', deletedBy: 'dana',
    ...over,
  };
}

const RUNNER = { id: '66666666-6666-4666-8666-666666666666', label: 'prod', capabilities: ['deploy:1'] };

/** Deployed, and its runner can remove the stack: purging it sends an undeploy. */
export const WEB = tombstone('d0000000-0000-4000-8000-000000000001', 'acme-web-pipeline', {
  purgeAfter: PAST, deployment: { stackName: 'acme-web-pipeline', region: 'us-east-1', runner: RUNNER, stackRemovedOnPurge: true },
});
/** Deployed, and no runner can remove the stack: a purge is refused until it is removed by hand. */
export const API = tombstone('d0000000-0000-4000-8000-000000000002', 'acme-api-pipeline', {
  purgeAfter: PAST, deployment: { stackName: 'acme-api-pipeline', region: 'eu-west-1', runner: null, stackRemovedOnPurge: false },
});
/** Never registered, still inside its retention window. */
export const OLD = tombstone('d0000000-0000-4000-8000-000000000003', 'acme-old-pipeline', { purgeAfter: FUTURE, deployment: null });
