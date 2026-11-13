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
  type ComplianceViolation,
  recordAudit,
  toolchainReleasePin,
  withProposalProvenance,
} from '@pipeline-builder/api-core';
import { replaceNonAlphanumeric } from '@pipeline-builder/pipeline-core';
import type { Request } from 'express';
import type { z } from 'zod';
import { validatePipelineTemplates } from './pipeline-template-validator.js';
import { formatContractViolations, recordPipelineResolution } from './plugin-contract-check.js';
import { checkPipelinePlugins, type PluginWarning } from './plugin-save-check.js';
import { checkToolchainPin } from './toolchain-pin-check.js';
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

/** The pre-write verdict: a refusal, or none plus the plugin warnings the save carries. */
export type PipelineWriteCheck =
  | { rejection: PipelineWriteRejection; pluginWarnings?: undefined }
  | { rejection: null; pluginWarnings: PluginWarning[] };

/**
 * Template validation (all errors in the body, batched) plus plugin contracts:
 * every plugin step's required metadata/vars present with the declared types —
 * refused here, not at synth. Contracts are only checked when `props` is
 * present (an update that doesn't touch props can't change what the steps get).
 *
 * A save that passes carries `pluginWarnings` (scan caveats, flagged-but-allowed
 * versions …) for its response; an empty list when `props` wasn't touched.
 * Pass `pipelineId` on an UPDATE of one pipeline so its active risk acceptances
 * downgrade the warnings they accepted (a create has no id yet).
 *
 * The toolchain release pin (`props.toolchain.release`) is checked first: a
 * managed `cdk-synth` step pinning its own version is refused, and a pin must
 * name an eligible release when it CHANGES against the stored pipeline (loaded
 * by `pipelineId` unless the caller passes `stored`). A create, or a bulk update
 * of a shared payload (no single stored row), compares against nothing.
 */
export async function validatePipelineWrite(
  body: PipelineCreateBody | PipelineUpdateBody,
  orgId: string,
  parentOrgId: string | undefined,
  pipelineId?: string,
  stored?: { props?: unknown } | null,
): Promise<PipelineWriteCheck> {
  try {
    validatePipelineTemplates(body);
  } catch (err) {
    return { rejection: { status: 400, code: ErrorCode.TEMPLATE_VALIDATION_FAILED, message: errorMessage(err) } };
  }

  if (body.props === undefined) return { rejection: null, pluginWarnings: [] };
  // The stored row matters only when the new props pin a release (did it change?).
  const storedProps = stored !== undefined || !toolchainReleasePin(body.props)
    ? stored?.props
    : pipelineId ? (await pipelineService.findById(pipelineId, orgId))?.props : undefined;
  const pin = await checkToolchainPin(body.props, orgId, storedProps);
  if (pin) return { rejection: pin };
  const { refusals, warnings } = await checkPipelinePlugins(body.props, orgId, parentOrgId, pipelineId);
  if (refusals.length > 0) {
    return {
      rejection: {
        status: 400,
        code: ErrorCode.TEMPLATE_CONTRACT_VIOLATION,
        message: formatContractViolations(refusals),
        details: { steps: refusals },
      },
    };
  }
  return { rejection: null, pluginWarnings: warnings };
}

/** `{ pluginWarnings }` for a success response — omitted when there are none. */
export function pluginWarningsField(warnings: readonly PluginWarning[] | undefined): { pluginWarnings?: PluginWarning[] } {
  return warnings && warnings.length > 0 ? { pluginWarnings: [...warnings] } : {};
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

/** Cap on the rule ids one blocked-write audit event carries. */
const MAX_AUDITED_RULE_IDS = 50;

/**
 * Audit `details` for a write compliance REFUSED: which rules blocked it, as
 * ids (deduped, capped) — never the violations' expected/actual values, which
 * echo config the event has no business storing.
 */
export function complianceBlockedDetails(violations: ReadonlyArray<Pick<ComplianceViolation, 'ruleId'>>): Record<string, unknown> {
  const ruleIds = [...new Set(violations.map((v) => v.ruleId).filter(Boolean))];
  return {
    blockedBy: 'compliance',
    ruleIds: ruleIds.slice(0, MAX_AUDITED_RULE_IDS),
    violationCount: violations.length,
  };
}

export type CreateOnePipelineOutcome =
  | { status: 'blocked'; violations: ComplianceViolation[] }
  | { status: 'unavailable'; error: string }
  | { status: 'saved'; pipeline: Pipeline; inserted: boolean };

/**
 * Compliance check (fail-closed) then the create-as-default upsert, then the
 * attributed audit event. Quota reservation/refund stays with the caller: a
 * `blocked`/`unavailable` outcome or a thrown save error means nothing was
 * created, and `inserted === false` means an existing default was updated in
 * place (no net-new pipeline) — which only happens when `ctx.upsert` is set,
 * since otherwise a taken slot throws a 409.
 *
 * Owner is ALWAYS the creator — a client-supplied `ownerId` is ignored so a
 * member can't create an entity "owned" by someone else (poisoning their My
 * Services / scorecard). Reassignment happens via update (admin-gated).
 */
export async function createOnePipeline(
  req: Request,
  body: PipelineCreateBody,
  prepared: PreparedPipelineCreate,
  ctx: { orgId: string; userId: string; serviceAuth: string; upsert?: boolean; auditDetails?: Record<string, unknown> },
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
    if (verdict.blocked) {
      // A refused create is still an attempt a reviewer must see: no pipeline
      // exists, so the slot it would have taken rides in `details`.
      recordAudit({
        action: 'pipeline.create',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline',
        outcome: 'failure',
        details: withProposalProvenance(req.headers, {
          project,
          organization,
          pipelineName,
          ...ctx.auditDetails,
          ...complianceBlockedDetails(verdict.violations),
        }),
      });
      return { status: 'blocked', violations: verdict.violations };
    }
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
      // `--no-active` creates the pipeline paused. Omitted rather than defaulted
      // here so the service keeps ownership of the default (active).
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
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
    // Overwriting a live same-slot pipeline is opt-in (`?upsert=true`); without it
    // the service throws a 409 naming the normalized slot and the id to PUT.
    { upsert: ctx.upsert === true },
  );

  // What the saved config resolves to (the report's declared side, and the
  // reference set a plugin version's removal guard reads). AWAITED, so a plugin
  // delete issued right after this save sees the references it dropped; never
  // throws — reporting must not fail a save.
  await recordPipelineResolution(pipeline.id, orgId, req.user?.parentOrganizationId, pipeline.props);

  // Emitted only after the write landed. `inserted === false` means an existing
  // default was UPDATED, so it is attributed as an update.
  recordAudit({
    action: inserted ? 'pipeline.create' : 'pipeline.update',
    actorId: actor,
    orgId,
    targetType: 'pipeline',
    targetId: pipeline.id,
    // The caller's details stay authoritative (`bulk: true` and friends);
    // `proposedBy: 'ask-agent'` is added only when the request carried the Ask
    // panel's provenance header, and is the only key provenance can write.
    details: withProposalProvenance(req.headers, {
      project: pipeline.project,
      organization: pipeline.organization,
      pipelineName: pipeline.pipelineName,
      visibility: pipeline.visibility,
      ...ctx.auditDetails,
    }),
  });

  return { status: 'saved', pipeline, inserted };
}

/**
 * The scalar columns an update audit records before/after VALUES for. Config
 * and free-form blobs (`props`, `description`, `keywords`, `labels`, `links`)
 * are named in `fields` only — a value diff of those would copy whole configs
 * into the audit trail.
 */
const AUDITED_VALUE_FIELDS = [
  'pipelineName', 'visibility', 'isActive', 'isDefault', 'ownerId', 'ownerType', 'lifecycle', 'criticality',
] as const;

/**
 * `{ field: { from, to } }` for every audited scalar column whose value the
 * update actually changed — read from the rows before and after the write, so a
 * no-op assignment (same value) records nothing.
 */
export function auditedChanges(
  before: Partial<Record<string, unknown>>,
  after: Partial<Record<string, unknown>>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of AUDITED_VALUE_FIELDS) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
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
