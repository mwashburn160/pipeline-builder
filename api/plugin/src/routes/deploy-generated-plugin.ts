// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import path from 'path';

import {
  requirePermission,
  reserveQuota,
  decrementQuota,
  resolveAccessModifier,
  sendBadRequest,
  sendError,
  sendQuotaExceeded,
  sendSuccess,
  validateBody,
  errorMessage,
  ErrorCode,
  getServiceAuthHeader,
  createComplianceClient,
  PluginDeployGeneratedSchema,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { getIdempotencyStore, withRoute, type SSEManager } from '@pipeline-builder/api-server';
import { Config, CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { v7 as uuid } from 'uuid';

import { BUILD_TEMP_ROOT } from '../helpers/docker-build.js';
import { createBuildJobData } from '../helpers/plugin-helpers.js';
import { validateBuildArgs } from '../helpers/plugin-spec.js';
import { enqueueBuild, getOrgTier } from '../queue/plugin-build-queue.js';
import { emitPluginAudit } from '../services/audit.js';

// Fail-closed compliance client (shared with the upload path's contract):
// an unreachable compliance service rejects the deploy rather than letting it through.
const complianceClient = createComplianceClient();

/**
 * Create and register the deploy-generated plugin route.
 *
 * Builds a Docker image from an AI-generated Dockerfile and persists
 * the plugin record to the database via the build queue.
 *
 * Requires admin permissions. Validated with {@link PluginDeployGeneratedSchema}.
 */
export function createDeployGeneratedPluginRoutes( quotaService: QuotaService,
  sseManager: SSEManager,
): Router {
  const router: Router = Router();

  router.post( '/deploy-generated',
    // Admin check BEFORE quota  non-admins should be rejected without consuming quota.
    // Both system admins and org admins/owners can deploy AI-generated plugins.
    // quota reservation happens inside the handler (atomic) so two
    // concurrent deploys at the limit can't both succeed; on any failure
    // path the worker decrements to give the slot back.
    requirePermission('plugins:write') as RequestHandler,
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const registry = Config.get('registry');
      // Service-minted auth for downstream calls (quota, tier, compliance). The
      // caller's admin bearer may carry only end-user scopes that won't pass
      // service-to-service authorization; mint a service token instead (matches
      // the upload-plugin path).
      const authHeader = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });

      const validation = validateBody(req, PluginDeployGeneratedSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const {
        name, description, version, pluginType, computeType, keywords,
        primaryOutputDirectory, installCommands, commands, env, buildArgs,
        dockerfile, accessModifier: rawAccess,
      } = validation.value;

      const accessModifier = resolveAccessModifier(req, rawAccess || 'private', 'plugins:publish');

      // Validate buildArgs (throws ValidationError → handled by withRoute)
      validateBuildArgs(buildArgs);

      // -- Idempotency guard (Wave-1 Redis IdempotencyStore) ----------------
      // The auto-plugin-creation path sends `Idempotency-Key: <requestId>:<name>`
      // (generate-pipeline.ts) so a client retrying a failed SSE generate doesn't
      // enqueue duplicate buildkit builds + double the `plugins` quota. Claim the
      // key BEFORE reserving quota / enqueuing. This is a defense-in-depth
      // complement to the generic response-replay middleware: keyed on the HEADER
      // ALONE (not the body), it also suppresses a retry whose body drifted
      // slightly (a differing body would mint a fresh response-cache key and slip
      // past the middleware). Uses the process-wide store createApp wired to the
      // shared env Redis (SET…NX across replicas); falls back to the in-memory
      // store single-replica when Redis isn't configured.
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      const idemKey = idempotencyKey ? `plugin:deploy-generated:${orgId}:${idempotencyKey}` : undefined;
      const idemStore = getIdempotencyStore();
      const idemTtlMs = CoreConstants.IDEMPOTENCY_TTL_MS;
      let idemReserved = false;
      if (idemKey) {
        const won = await idemStore.reserve(
          idemKey,
          { statusCode: 202, body: null, pending: true, expiresAt: Date.now() + idemTtlMs },
          Math.floor(idemTtlMs / 1000),
        );
        if (!won) {
          // The same key is already in-flight or was recently accepted — the
          // original reserved quota + queued the build, so suppress this duplicate.
          ctx.log('INFO', 'Duplicate deploy-generated suppressed by Idempotency-Key', { orgId, pluginName: name, version });
          return sendSuccess(res, 202, {
            requestId: ctx.requestId,
            pluginName: name,
            version,
            idempotent: true,
          }, 'Plugin build already queued');
        }
        idemReserved = true;
      }
      // Release the idempotency reservation on any pre-enqueue failure so a
      // legitimate retry can proceed (nothing durable happened). Only a
      // successfully-queued build KEEPS the key, deduping retries for its TTL.
      const releaseIdem = (): void => {
        if (!idemReserved || !idemKey) return;
        idemReserved = false;
        void idemStore.delete(idemKey).catch((err) =>
          ctx.log('WARN', 'Idempotency reservation release failed', { error: errorMessage(err) }));
      };

      // Reserve the plugins quota slot atomically. Worker decrements on
      // permanent failure; success keeps the reservation.
      const reservation = await reserveQuota(quotaService, orgId, 'plugins', authHeader);
      if (reservation.exceeded) {
        ctx.log('WARN', 'Plugin quota exceeded', { orgId, used: reservation.quota.used, limit: reservation.quota.limit });
        releaseIdem();
        return sendQuotaExceeded(res, 'plugins', reservation.quota, reservation.quota.resetAt);
      }
      let reserved = true;

      // -- Compliance check (fail-closed) -----------------------------------
      // AI-generated plugins must satisfy the same org compliance rules as
      // uploaded ones (see upload-plugin.ts). Without this, the deploy-generated
      // path was a bypass around org governance.
      try {
        const complianceResult = await complianceClient.validatePlugin(orgId, {
          name,
          version,
          pluginType: pluginType || 'CodeBuildStep',
          computeType: computeType || 'MEDIUM',
          env: env || {},
          buildArgs: buildArgs || {},
          installCommands: installCommands || [],
          commands,
          accessModifier,
          keywords: keywords || [],
          buildType: 'build_image',
        }, authHeader, undefined, name, 'deploy-generated');

        if (complianceResult.blocked) {
          ctx.log('WARN', 'AI-generated plugin blocked by compliance', {
            pluginName: name,
            violations: complianceResult.violations.length,
          });
          decrementQuota(quotaService, orgId, 'plugins', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
          reserved = false;
          releaseIdem();
          return sendError(res, 403, 'Plugin deploy blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
            violations: complianceResult.violations,
          });
        }

        if (complianceResult.warnings.length > 0) {
          ctx.log('WARN', 'Compliance warnings on AI-generated plugin', {
            pluginName: name,
            warnings: complianceResult.warnings.length,
          });
        }
      } catch (err) {
        // Fail-closed: compliance unreachable → reject the deploy and release the slot.
        ctx.log('ERROR', 'Compliance service unavailable', { error: errorMessage(err) });
        decrementQuota(quotaService, orgId, 'plugins', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
        reserved = false;
        releaseIdem();
        return sendError(res, 503, 'Compliance service unavailable — plugin deploy rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
      }

      ctx.log('INFO', 'Deploying AI-generated plugin', {
        pluginName: name,
        version,
        accessModifier,
      });

      try {
      // Create temp directory and write Dockerfile (worker will clean up)
        const tempDir = path.join(BUILD_TEMP_ROOT, uuid());
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'Dockerfile'), dockerfile, 'utf-8');

        // Queue build job (returns immediately)
        const jobData = createBuildJobData({
          requestId: ctx.requestId,
          orgId,
          userId: userId || 'system',
          // Period snapshot for the reserved slot so a DLQ retry spanning a
          // quota reset refunds the correct period (see releasePluginQuota).
          reservedResetAt: reservation.quota.resetAt,
          buildRequest: {
            contextDir: tempDir,
            dockerfile: 'Dockerfile',
            name,
            version,
            orgId,
            registry,
            buildArgs: buildArgs || {},
            buildType: 'build_image',
          },
          pluginRecord: {
            orgId,
            name,
            description: description || null,
            version,
            pluginType: pluginType || 'CodeBuildStep',
            computeType: computeType || 'MEDIUM',
            primaryOutputDirectory: primaryOutputDirectory || null,
            dockerfile,
            env: env || {},
            buildArgs: buildArgs || {},
            keywords: keywords || [],
            installCommands: installCommands || [],
            commands,
            accessModifier,
            buildType: 'build_image',
          },
        });

        // Bind the build-log stream's owner BEFORE the requestId is returned to
        // the caller (F3): a client can mint a ticket as soon as it has the
        // requestId, so the owner must be recorded first or a tenant could mint a
        // ticket for another tenant's guessed stream. Best-effort — a Redis hiccup
        // must not fail an accepted deploy; the worker re-binds as a backstop.
        await sseManager.bindStreamOwner(ctx.requestId, orgId).catch((bindErr) =>
          ctx.log('WARN', 'Stream-owner bind failed (non-fatal)', { error: errorMessage(bindErr) }));

        // route to the org's per-tier queue.
        const tier = await getOrgTier(quotaService, orgId, authHeader);
        await enqueueBuild(tier, `deploy-generated-${name}-${version}`, jobData);

        ctx.log('INFO', 'Build queued', {
          pluginName: name,
          version,
        });

        // Best-effort attributed audit — the deploy action was accepted and the
        // build queued. No plugin id exists yet (the worker persists the record
        // on build completion, where plugin.build.completed carries the id), so
        // `targetId` is omitted here; name/version identify the plugin.
        emitPluginAudit({
          action: 'plugin.deploy',
          actorId: req.user?.sub ?? userId ?? 'system',
          orgId,
          targetType: 'plugin',
          details: {
            pluginName: name,
            version,
            accessModifier,
            buildType: 'build_image',
          },
        });

        return sendSuccess(res, 202, {
          requestId: ctx.requestId,
          pluginName: name,
          version,
        }, 'Plugin build queued');
      } catch (err) {
        // Roll back the reserved slot if anything between reserve and the
        // successful queue.add throws (fs operations, queue down). Release the
        // idempotency key too so the client's retry isn't wrongly suppressed —
        // the build was never queued.
        if (reserved) {
          decrementQuota(quotaService, orgId, 'plugins', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
          reserved = false;
        }
        releaseIdem();
        throw err;
      }
    }),
  );

  return router;
}
