// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Write-path steps shared by single and bulk pipeline create/update, so the two
 * entry points can't drift in what they validate or persist (bulk once dropped
 * the catalog metadata that single create/update apply).
 */

import {
  actorId,
  createComplianceClient,
  ErrorCode,
  errorMessage,
  isSystemAdmin,
  pickDefined,
  resolveVisibility,
  userHasPermission,
  type PipelineCreateSchema,
  type PipelineUpdateSchema,
  recordAudit,
} from '@pipeline-builder/api-core';
import { replaceNonAlphanumeric } from '@pipeline-builder/pipeline-core';
import type { Request } from 'express';
import type { z } from 'zod';
import { validatePipelineTemplates } from './pipeline-template-validator.js';
import { findPluginContractViolations, formatContractViolations } from './plugin-contract-check.js';
import { pipelineService, type Pipeline, type PipelineInsert } from '../services/pipeline-service.js';

export type PipelineCreateBody = z.infer<typeof PipelineCreateSchema>;
export type PipelineUpdateBody = z.infer<typeof PipelineUpdateSchema>;

const complianceClient = createComplianceClient();

/** Why a write was refused before any quota or DB work. */
export interface PipelineWriteRejection {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Template validation (all errors in the body, batched) plus plugin contracts:
 * every plugin step's required metadata/vars present with the declared types —
 * refused here, not at synth. Contracts are only checked when `props` is
 * present (an update that doesn't touch props can't change what the steps get).
 */
export async function validatePipelineWrite(
  body: PipelineCreateBody | PipelineUpdateBody,
  orgId: string,
  parentOrgId: string | undefined,
): Promise<PipelineWriteRejection | null> {
  try {
    validatePipelineTemplates(body);
  } catch (err) {
    return { status: 400, code: ErrorCode.TEMPLATE_VALIDATION_FAILED, message: errorMessage(err) };
  }

  if (body.props !== undefined) {
    const violations = await findPluginContractViolations(body.props, orgId, parentOrgId);
    if (violations.length > 0) {
      return {
        status: 400,
        code: ErrorCode.TEMPLATE_CONTRACT_VIOLATION,
        message: formatContractViolations(violations),
        details: { steps: violations },
      };
    }
  }
  return null;
}

/** Normalized identity of a pipeline about to be created. */
export interface PreparedPipelineCreate {
  project: string;
  organization: string;
  pipelineName: string;
  visibility: ReturnType<typeof resolveVisibility>;
}

/**
 * Resolve visibility and normalize the project/organization slot. Runs BEFORE
 * any quota is reserved, so a bad name never burns a `pipelines` slot.
 *
 * Unspecified visibility defaults to `org`, NOT `private`: a pipeline is a team
 * asset that deploys shared infrastructure, so creating one must not hide it
 * from the team. A personal draft stays available, but opt-in.
 */
export function preparePipelineCreate(req: Request, body: PipelineCreateBody): PreparedPipelineCreate | { error: string } {
  const visibility = resolveVisibility(req, body.visibility, 'pipelines:publish', 'org');
  const project = replaceNonAlphanumeric(body.project, '_').toLowerCase();
  const organization = replaceNonAlphanumeric(body.organization, '_').toLowerCase();

  if (!project.replace(/_/g, '') || !organization.replace(/_/g, '')) {
    return { error: 'Project and organization must contain alphanumeric characters' };
  }

  return {
    project,
    organization,
    pipelineName: body.pipelineName ?? `${organization}-${project}-pipeline`,
    visibility,
  };
}

export type CreateOnePipelineOutcome =
  | { status: 'blocked'; violations: Array<{ message: string }> }
  | { status: 'unavailable'; error: string }
  | { status: 'saved'; pipeline: Pipeline; inserted: boolean };

/**
 * Compliance check (fail-closed) then the create-as-default upsert, then the
 * attributed audit event. Quota reservation/refund stays with the caller: a
 * `blocked`/`unavailable` outcome or a thrown save error means nothing was
 * created, and `inserted === false` means an existing default was updated in
 * place (no net-new pipeline).
 *
 * Owner is ALWAYS the creator — a client-supplied `ownerId` is ignored so a
 * member can't create an entity "owned" by someone else (poisoning their My
 * Services / scorecard). Reassignment happens via update (admin-gated).
 */
export async function createOnePipeline(
  req: Request,
  body: PipelineCreateBody,
  prepared: PreparedPipelineCreate,
  ctx: { orgId: string; userId: string; serviceAuth: string; auditDetails?: Record<string, unknown> },
): Promise<CreateOnePipelineOutcome> {
  const { orgId, userId, serviceAuth } = ctx;
  const { project, organization, pipelineName, visibility } = prepared;

  try {
    const verdict = await complianceClient.validatePipeline(orgId, {
      project,
      organization,
      pipelineName,
      props: body.props,
      visibility,
    }, serviceAuth, undefined, pipelineName, 'create');
    if (verdict.blocked) return { status: 'blocked', violations: verdict.violations };
  } catch (err) {
    return { status: 'unavailable', error: errorMessage(err) };
  }

  const actor = actorId({ userId });
  const { pipeline, inserted } = await pipelineService.createAsDefaultReportInserted(
    {
      orgId,
      project,
      organization,
      pipelineName,
      description: body.description ?? '',
      keywords: body.keywords ?? [],
      props: body.props as unknown as PipelineInsert['props'],
      visibility,
      createdBy: actor,
      ownerId: actor,
      ownerType: 'user',
      ...(body.lifecycle !== undefined ? { lifecycle: body.lifecycle } : {}),
      ...(body.criticality !== undefined ? { criticality: body.criticality } : {}),
      ...(body.labels !== undefined ? { labels: body.labels } : {}),
      ...(body.links !== undefined ? { links: body.links } : {}),
    },
    actor,
    project,
    organization,
    // A same-slot pipeline is updated in place only if the caller could PUT it
    // (visibility ladder); a tombstone must go through restore.
    { isSystemAdmin: isSystemAdmin(req), canPublish: userHasPermission(req, 'pipelines:publish') },
  );

  // Emitted only after the write landed. `inserted === false` means an existing
  // default was UPDATED, so it is attributed as an update.
  recordAudit({
    action: inserted ? 'pipeline.create' : 'pipeline.update',
    actorId: actor,
    orgId,
    targetType: 'pipeline',
    targetId: pipeline.id,
    details: {
      project: pipeline.project,
      organization: pipeline.organization,
      pipelineName: pipeline.pipelineName,
      visibility: pipeline.visibility,
      ...ctx.auditDetails,
    },
  });

  return { status: 'saved', pipeline, inserted };
}

/**
 * Column writes for an update body: editable fields + catalog metadata, the
 * admin-only ownership reassignment, and the visibility ladder (`public` needs
 * `pipelines:publish`). `isDefault` is left to the caller — promotion takes the
 * locked `setDefault()` path.
 */
export function buildPipelineUpdateData(req: Request, body: PipelineUpdateBody): Record<string, unknown> {
  return {
    ...pickDefined({
      pipelineName: body.pipelineName,
      description: body.description,
      keywords: body.keywords,
      props: body.props,
      isActive: body.isActive,
      lifecycle: body.lifecycle,
      criticality: body.criticality,
      labels: body.labels,
      links: body.links,
    }),
    // A regular member must not be able to hand a resource to (or take it from)
    // another user/team.
    ...((req.user?.isAdmin === true || req.user?.isSuperAdmin === true)
      ? pickDefined({ ownerId: body.ownerId, ownerType: body.ownerType })
      : {}),
    ...(body.visibility !== undefined ? { visibility: resolveVisibility(req, body.visibility, 'pipelines:publish') } : {}),
  };
}
