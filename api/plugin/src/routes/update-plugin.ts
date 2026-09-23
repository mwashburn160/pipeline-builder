// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  audited, getParam, ErrorCode, isSystemAdmin, requireVisibilityWriteAccess, resolveVisibility, sendBadRequest, sendError, sendSuccess,
  userHasPermission, validateBody, PluginUpdateSchema, pickDefined, sendEntityNotFound, actorId,
  PLUGIN_CATALOG_FIELDS, contractKeysMessage, findContractKeys, type MetadataSources, type PluginCatalogField,
  proposable, recordAudit, withProposalProvenance,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { renderUntrustedMarkdown } from '@pipeline-builder/api-server/lib/markdown.js';
import { Router } from 'express';
import { onPluginDeprecated } from '../helpers/deprecation-notice.js';
import { shapePlugin } from '../helpers/plugin-helpers.js';
import { checkUpdateCompliance, needsComplianceRecheck } from '../helpers/update-compliance.js';
import { pluginService, type Plugin } from '../services/plugin-service.js';

/**
 * The columns a set of catalog edits writes. `null` clears a field
 * (category falls back to `unknown`, keywords to none); the README is stored as
 * source AND sanitized HTML, rendered once here. Every edited field's
 * provenance becomes `user`.
 */
export function catalogEditColumns(
  body: Partial<Record<PluginCatalogField, unknown>>,
  existingSources: MetadataSources,
): Record<string, unknown> {
  const edited = PLUGIN_CATALOG_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(body, f));
  if (edited.length === 0) return {};
  const out: Record<string, unknown> = {};
  const sources: MetadataSources = { ...existingSources };
  for (const f of edited) {
    const v = body[f] ?? null;
    sources[f] = 'user';
    if (f === 'readme') {
      out.readmeMd = v;
      out.readmeHtml = typeof v === 'string' ? renderUntrustedMarkdown(v) : null;
    } else if (f === 'category') {
      out.category = v ?? 'unknown';
    } else if (f === 'keywords') {
      out.keywords = v ?? [];
    } else {
      out[f] = v;
    }
  }
  out.metadataSources = sources;
  return out;
}

/**
 * The deprecation columns a `lifecycle` change implies, so `deprecatedAt` (what
 * lookups and AI selection read) never disagrees with the lifecycle a catalog
 * filter shows. Returns whether the change DEPRECATES the version.
 */
function lifecycleColumns(existing: Plugin, lifecycle: string | undefined): { columns: Record<string, unknown>; deprecates: boolean } {
  if (lifecycle === undefined) return { columns: {}, deprecates: false };
  if (lifecycle === 'deprecated') {
    return existing.deprecatedAt
      ? { columns: {}, deprecates: false }
      : { columns: { deprecatedAt: new Date() }, deprecates: true };
  }
  return existing.deprecatedAt
    ? { columns: { deprecatedAt: null, deprecationMessage: null }, deprecates: false }
    : { columns: {}, deprecates: false };
}

/**
 * Register the UPDATE route on a router.
 *
 * Expects auth + orgId + tenant scope (the shared `/plugins` chain) and
 * `requirePermission('plugins:write')` from the parent mount in index.ts.
 *
 * Edits only DESCRIPTIVE catalog fields and the version's operational flags.
 * Execution-contract keys (commands, env, secrets, compute type, …) are
 * refused with 400: what runs changes only with a new version, a new
 * digest and — once published — a review diff. A frozen or listed version's
 * catalog metadata is frozen with it (409).
 */
export function createUpdatePluginRoutes(): Router {
  const router: Router = Router();

  router.put('/:id', audited('plugin.update'), proposable, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');

    if (!id) return sendBadRequest(res, 'Plugin ID is required.', ErrorCode.MISSING_REQUIRED_FIELD);

    // Refuse execution-contract keys BY NAME before the strict schema runs, so
    // the caller learns exactly which fields need a new version instead.
    const contractKeys = findContractKeys(req.body);
    if (contractKeys.length > 0) {
      return sendError(res, 400, contractKeysMessage(contractKeys), ErrorCode.VALIDATION_ERROR, { fields: contractKeys });
    }

    const validation = validateBody(req, PluginUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    ctx.log('INFO', 'Plugin update request received', { id });

    const existing = await pluginService.findById(id, orgId);

    if (!existing) return sendEntityNotFound(res, 'Plugin');

    // Visibility ladder: `public` needs plugins:publish, `private` is author-only.
    if (!requireVisibilityWriteAccess(req, res, existing, userId, 'plugins:publish')) return;

    // A version referenced by a publish request, or published to a listing,
    // has its catalog metadata frozen with it: changing a live
    // listing goes through a listing_update request instead.
    // Its VISIBILITY is frozen too: a version waiting for approval must
    // still be `public` when it is published.
    const catalogEdited = PLUGIN_CATALOG_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(body, f));
    const visibilityChanged = body.visibility !== undefined && body.visibility !== existing.visibility;
    if (catalogEdited || visibilityChanged) {
      const frozen = await pluginService.versionImmutability(existing);
      if (frozen) {
        return sendError(res, 409, frozen === 'listed'
          ? 'This plugin version is published to the ecosystem; its catalog details and visibility are frozen with it. Request a listing update instead.'
          : 'This plugin version is referenced by a publish request; its catalog details and visibility are frozen with it.',
        ErrorCode.PLUGIN_VERSION_FROZEN);
      }
    }

    // A yanked version's lifecycle is the yank's; it is not editable here.
    if (body.lifecycle !== undefined && (existing.lifecycle === 'yanked' || existing.yankedAt)) {
      return sendError(res, 409, 'This plugin version is yanked; its lifecycle cannot be changed.', ErrorCode.CONFLICT);
    }
    const lifecycle = lifecycleColumns(existing, body.lifecycle);

    const updateData: Record<string, unknown> = {
      ...pickDefined({
        isActive: body.isActive,
        isDefault: body.isDefault,
        // Developer-portal catalog metadata (lifecycle / classification).
        lifecycle: body.lifecycle,
        criticality: body.criticality,
        labels: body.labels,
        links: body.links,
      }),
      ...lifecycle.columns,
      ...catalogEditColumns(body, existing.metadataSources ?? {}),
      // Ownership reassignment is admin-only (see update-pipeline.ts).
      ...((req.user?.isAdmin === true || req.user?.isSuperAdmin === true)
        ? pickDefined({ ownerId: body.ownerId, ownerType: body.ownerType })
        : {}),
      // `public` needs plugins:publish — resolveVisibility clamps it to `org` otherwise.
      ...(body.visibility !== undefined ? { visibility: resolveVisibility(req, body.visibility, 'plugins:publish') } : {}),
    };

    // -- Compliance re-check on UPDATE (fail-closed) ------------------------
    // Visibility and the inventory tags (keywords / labels) are what an edit
    // here can change about a plugin's compliance posture; the rest of the
    // execution contract is not editable.
    if (needsComplianceRecheck(updateData)) {
      const verdict = await checkUpdateCompliance(orgId, existing, updateData);
      if (verdict.outcome === 'blocked') {
        ctx.log('WARN', 'Plugin update blocked by compliance', { id, violations: verdict.violations.length });
        return sendError(res, 403, 'Plugin update blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
          violations: verdict.violations,
        });
      }
      if (verdict.outcome === 'unavailable') {
        ctx.log('ERROR', 'Compliance service unavailable — plugin update rejected', { error: verdict.error });
        return sendError(res, 503, 'Compliance service unavailable — plugin update rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
      }
    }

    // Promoting to default demotes the current default in the same transaction,
    // which needs write access to THAT row too — pass the caller's authority.
    const updated = await pluginService.update(
      id,
      updateData,
      orgId,
      userId,
      { isSystemAdmin: isSystemAdmin(req), canPublish: userHasPermission(req, 'plugins:publish') },
    );

    if (!updated) return sendEntityNotFound(res, 'Plugin');

    ctx.log('COMPLETED', 'Updated plugin', { id: updated.id, name: updated.name });

    if (lifecycle.deprecates) void onPluginDeprecated(updated, actorId({ userId }));

    recordAudit({
      action: 'plugin.update',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'plugin',
      targetId: id,
      // The handler's details stay authoritative; `proposedBy: 'ask-agent'` is
      // added only when the request carried the Ask panel's provenance header.
      details: withProposalProvenance(req.headers, {
        pluginName: updated.name,
        version: updated.version,
        visibility: updated.visibility,
        fields: Object.keys(body),
      }),
    });

    return sendSuccess(res, 200, { plugin: shapePlugin(updated) });
  }));

  return router;
}
