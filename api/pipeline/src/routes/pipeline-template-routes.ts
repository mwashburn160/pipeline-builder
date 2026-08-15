// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  getParam,
  ErrorCode,
  resolveAccessModifier,
  sendBadRequest,
  sendError,
  sendSuccess,
  sendPaginatedNested,
  sendEntityNotFound,
  parsePaginationParams,
  normalizeArrayFields,
  pickDefined,
  validateQuery,
  validateBody,
  requirePermission,
  requirePublicAccess,
  requireStepUp,
  PipelineTemplateFilterSchema,
  PipelineTemplateCreateSchema,
  PipelineTemplateUpdateSchema,
  InstantiateTemplateSchema,
  type TemplateInput,
} from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@pipeline-builder/api-server';
import { tokenize } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { instantiateTemplateProps } from '../helpers/instantiate-template.js';
import { validatePipelineTemplates, type PipelineLike } from '../helpers/pipeline-template-validator.js';
import { emitPipelineAudit } from '../services/audit.js';
import { pipelineTemplateService } from '../services/pipeline-template-service.js';

/**
 * Every `{{ vars.X }}` placeholder in a template's self-scope fields must be
 * backed by a declared input (or a key already present in `props.vars`, or carry
 * a `| default:`) — otherwise instantiation omits it and it fails opaquely at
 * synth. Returns the undeclared var names.
 *
 * Only the fields the pipeline template validator/resolver actually resolve are
 * scanned — `project`/`projectName` and each `metadata.*` / `vars.*` value — and
 * each is tokenized INDIVIDUALLY (every such field is under the tokenizer's
 * per-field size cap and was already shape-validated by `validatePipelineTemplates`,
 * so a throw here would signal a real bug, not a large/quoted body). This avoids
 * the pitfalls of tokenizing the whole serialized `props` (size cap, escaped
 * quotes, literal `{{` inside unvalidated stage commands).
 */
function undeclaredVars(props: Record<string, unknown> | undefined, inputs: TemplateInput[]): string[] {
  const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  const vars = asRecord(props?.vars);
  const metadata = asRecord(props?.metadata);

  const declared = new Set<string>((inputs ?? []).map((i) => i.name));
  for (const k of Object.keys(vars)) declared.add(k);

  const fields: string[] = [];
  if (typeof props?.project === 'string') fields.push(props.project);
  if (typeof props?.projectName === 'string') fields.push(props.projectName as string);
  for (const v of Object.values(metadata)) if (typeof v === 'string') fields.push(v);
  for (const v of Object.values(vars)) if (typeof v === 'string') fields.push(v);

  const missing = new Set<string>();
  for (const field of fields) {
    if (!field.includes('{{')) continue;
    let tokens;
    try { tokens = tokenize(field); } catch { continue; }
    for (const t of tokens) {
      if (t.kind !== 'expr' || t.defaultValue !== undefined) continue;
      if (t.path[0] === 'vars' && t.path[1] && !declared.has(t.path[1])) missing.add(t.path[1]);
    }
  }
  return [...missing];
}

/** Ownership reassignment (ownerId/ownerType) is admin-only. */
function canReassignOwner(req: { user?: { isAdmin?: boolean; isSuperAdmin?: boolean } }): boolean {
  return req.user?.isAdmin === true || req.user?.isSuperAdmin === true;
}

/**
 * Golden-path pipeline templates: list/get the catalog, author templates
 * (`pipelines:write`), and instantiate a template into a concrete pipeline
 * `props` a developer can then create through the normal pipeline-create path.
 */
export function createPipelineTemplateRoutes(): Router {
  const router: Router = Router();

  // GET /pipeline-templates — paginated catalog list
  router.get('/', ...createAuthenticatedWithOrgRoute(), withRoute(async ({ req, res, ctx, orgId }) => {
    const filter = validateQuery(req, PipelineTemplateFilterSchema);
    if (!filter.ok) return sendBadRequest(res, filter.error);

    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query as Record<string, unknown>);
    const includeTotal = req.query.includeTotal === 'true';
    const parentOrgId = req.user?.parentOrganizationId;

    const result = await pipelineTemplateService.findPaginated(filter.value, orgId, { limit, offset, sortBy, sortOrder, includeTotal }, parentOrgId);

    ctx.log('COMPLETED', 'Listed pipeline templates', { count: result.data.length });
    return sendPaginatedNested(res, 'templates', result.data.map(r => normalizeArrayFields(r, ['keywords'])), {
      total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore, nextCursor: result.nextCursor,
    });
  }));

  // GET /pipeline-templates/:id
  router.get('/:id', ...createAuthenticatedWithOrgRoute(), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Template ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const result = await pipelineTemplateService.findById(id, orgId, req.user?.parentOrganizationId);
    if (!result) return sendEntityNotFound(res, 'Template');

    ctx.log('COMPLETED', 'Retrieved pipeline template', { id: result.id });
    return sendSuccess(res, 200, { template: normalizeArrayFields(result, ['keywords']) });
  }));

  // POST /pipeline-templates/:id/instantiate — render a template into pipeline props.
  // Returns a BuilderProps (with vars baked in) the caller submits via the normal
  // create endpoint, so compliance + quota still apply at actual creation.
  router.post('/:id/instantiate', ...createAuthenticatedWithOrgRoute(), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Template ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, InstantiateTemplateSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);

    const template = await pipelineTemplateService.findById(id, orgId, req.user?.parentOrganizationId);
    if (!template) return sendEntityNotFound(res, 'Template');

    let props: Record<string, unknown>;
    try {
      props = instantiateTemplateProps(template, validation.value);
    } catch (err) {
      return sendBadRequest(res, (err as Error).message, ErrorCode.VALIDATION_ERROR);
    }

    ctx.log('COMPLETED', 'Instantiated pipeline template', { id });
    return sendSuccess(res, 200, { props, description: template.description ?? undefined, keywords: template.keywords ?? [] });
  }));

  // POST /pipeline-templates — author a template
  router.post('/', ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, PipelineTemplateCreateSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const body = validation.value;

    // Validate the `{{ }}` tokens in the template body (shape/roots/cycles).
    try {
      validatePipelineTemplates({ props: body.props } as unknown as PipelineLike);
    } catch (err) {
      return sendBadRequest(res, (err as Error).message, ErrorCode.TEMPLATE_VALIDATION_FAILED);
    }

    // Every `{{ vars.X }}` must be a declared input — caught here, not at synth.
    const missing = undeclaredVars(body.props, (body.inputs ?? []) as TemplateInput[]);
    if (missing.length > 0) {
      return sendBadRequest(res, `Template references undeclared vars: ${missing.join(', ')}. Add them to inputs[] or give the placeholder a default.`, ErrorCode.TEMPLATE_VALIDATION_FAILED);
    }

    // Reject a same-org name collision rather than silently upserting (which would
    // overwrite the existing body AND reassign its ownership to the re-creator).
    const sameName = (await pipelineTemplateService.find({ name: body.name }, orgId))
      .find((t) => t.orgId === orgId && t.name === body.name);
    if (sameName) return sendError(res, 409, `A template named "${body.name}" already exists in this organization.`, ErrorCode.CONFLICT);

    const accessModifier = resolveAccessModifier(req, body.accessModifier, 'pipelines:publish');

    const created = await pipelineTemplateService.create({
      orgId,
      name: body.name,
      description: body.description ?? null,
      keywords: body.keywords ?? [],
      category: body.category ?? 'general',
      props: body.props,
      inputs: body.inputs ?? [],
      accessModifier,
      // Owner is always the creator on create (client-supplied ownerId ignored).
      ownerId: userId ?? 'system',
      ownerType: 'user',
      ...(body.lifecycle !== undefined ? { lifecycle: body.lifecycle } : {}),
      ...(body.criticality !== undefined ? { criticality: body.criticality } : {}),
      ...(body.labels !== undefined ? { labels: body.labels } : {}),
      ...(body.links !== undefined ? { links: body.links } : {}),
    }, userId ?? 'system');

    ctx.log('COMPLETED', 'Created pipeline template', { id: created.id });
    emitPipelineAudit({
      action: 'pipeline_template.create',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      targetType: 'pipeline_template',
      targetId: created.id,
      details: { name: created.name, category: created.category, accessModifier: created.accessModifier },
    });
    return sendSuccess(res, 201, { template: normalizeArrayFields(created, ['keywords']) });
  }));

  // PUT /pipeline-templates/:id
  router.put('/:id', ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Template ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, PipelineTemplateUpdateSchema);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const body = validation.value;

    // Load the current row: needed to gate public (published) templates and to
    // check declared-vars against the EXISTING inputs on a props-only update.
    const existing = await pipelineTemplateService.findById(id, orgId, req.user?.parentOrganizationId);
    if (!existing) return sendEntityNotFound(res, 'Template');
    // A plain pipelines:write member must not modify a PUBLIC (shared) template —
    // only a publisher/admin can (mirrors pipelines/plugins).
    if (!requirePublicAccess(req, res, existing, 'pipelines:publish')) return;

    if (body.props) {
      try {
        validatePipelineTemplates({ props: body.props } as unknown as PipelineLike);
      } catch (err) {
        return sendBadRequest(res, (err as Error).message, ErrorCode.TEMPLATE_VALIDATION_FAILED);
      }
      // Re-check declared-vars against the new inputs if supplied, else the
      // template's stored inputs (a props-only update must not false-positive).
      const inputs = (body.inputs ?? existing.inputs ?? []) as TemplateInput[];
      const missing = undeclaredVars(body.props, inputs);
      if (missing.length > 0) {
        return sendBadRequest(res, `Template references undeclared vars: ${missing.join(', ')}.`, ErrorCode.TEMPLATE_VALIDATION_FAILED);
      }
    }

    const updateData: Record<string, unknown> = {
      ...pickDefined({
        name: body.name,
        description: body.description,
        keywords: body.keywords,
        category: body.category,
        props: body.props,
        inputs: body.inputs,
        isActive: body.isActive,
        lifecycle: body.lifecycle,
        criticality: body.criticality,
        labels: body.labels,
        links: body.links,
      }),
      // Ownership reassignment is admin-only.
      ...(canReassignOwner(req) ? pickDefined({ ownerId: body.ownerId, ownerType: body.ownerType }) : {}),
      ...(body.accessModifier !== undefined ? { accessModifier: resolveAccessModifier(req, body.accessModifier, 'pipelines:publish') } : {}),
    };

    const updated = await pipelineTemplateService.update(id, updateData, orgId, userId ?? 'system');
    if (!updated) return sendEntityNotFound(res, 'Template');

    ctx.log('COMPLETED', 'Updated pipeline template', { id });
    emitPipelineAudit({
      action: 'pipeline_template.update',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      targetType: 'pipeline_template',
      targetId: id,
      details: { fields: Object.keys(updateData) },
    });
    return sendSuccess(res, 200, { template: normalizeArrayFields(updated, ['keywords']) });
  }));

  // DELETE /pipeline-templates/:id
  router.delete('/:id', ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Template ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Gate deletion of a PUBLIC (shared) template on pipelines:publish, like PUT.
    const existing = await pipelineTemplateService.findById(id, orgId, req.user?.parentOrganizationId);
    if (!existing) return sendEntityNotFound(res, 'Template');
    if (!requirePublicAccess(req, res, existing, 'pipelines:publish')) return;

    const deleted = await pipelineTemplateService.delete(id, orgId, userId ?? 'system');
    if (!deleted) return sendEntityNotFound(res, 'Template');

    ctx.log('COMPLETED', 'Deleted pipeline template', { id });
    emitPipelineAudit({
      action: 'pipeline_template.delete',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      targetType: 'pipeline_template',
      targetId: id,
      details: { name: deleted.name },
    });
    return sendSuccess(res, 200, { message: 'Template deleted' });
  }));

  // POST /pipeline-templates/:id/restore — undo a soft-delete within the
  // retention window. Step-up-gated (reverses a destructive action); mirrors the
  // DELETE authority (auth + orgId + pipelines:write, +pipelines:publish for
  // public templates).
  router.post('/:id/restore', ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:write'), requireStepUp, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Template ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Own-org only: the subsequent restore() is own-org-pinned, so widening the
    // tombstone lookup to a parent org would load a row restore() can't touch
    // (apparent success → 404). Mirrors restore-pipeline.ts.
    const existing = await pipelineTemplateService.findDeletedById(id, orgId);
    if (!existing) return sendEntityNotFound(res, 'Template');
    if (!requirePublicAccess(req, res, existing, 'pipelines:publish')) return;

    const restored = await pipelineTemplateService.restore(id, orgId, userId ?? 'system');
    if (!restored) return sendEntityNotFound(res, 'Template');

    ctx.log('COMPLETED', 'Restored pipeline template', { id });
    emitPipelineAudit({
      action: 'pipeline_template.restore',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'pipeline_template',
      targetId: id,
      details: { name: restored.name },
    });
    return sendSuccess(res, 200, { template: normalizeArrayFields(restored, ['keywords']) });
  }));

  return router;
}
