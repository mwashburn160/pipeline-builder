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
import { withRoute } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { v7 as uuid } from 'uuid';

import { BUILD_TEMP_ROOT } from '../helpers/docker-build.js';
import { createBuildJobData } from '../helpers/plugin-helpers.js';
import { validateBuildArgs } from '../helpers/plugin-spec.js';
import { enqueueBuild, getOrgTier } from '../queue/plugin-build-queue.js';

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

      const accessModifier = resolveAccessModifier(req, rawAccess || 'private');

      // Validate buildArgs (throws ValidationError → handled by withRoute)
      validateBuildArgs(buildArgs);

      // Reserve the plugins quota slot atomically. Worker decrements on
      // permanent failure; success keeps the reservation.
      const reservation = await reserveQuota(quotaService, orgId, 'plugins', authHeader);
      if (reservation.exceeded) {
        ctx.log('WARN', 'Plugin quota exceeded', { orgId, used: reservation.quota.used, limit: reservation.quota.limit });
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

        // route to the org's per-tier queue.
        const tier = await getOrgTier(quotaService, orgId, authHeader);
        await enqueueBuild(tier, `deploy-generated-${name}-${version}`, jobData);

        ctx.log('INFO', 'Build queued', {
          pluginName: name,
          version,
        });

        return sendSuccess(res, 202, {
          requestId: ctx.requestId,
          pluginName: name,
          version,
        }, 'Plugin build queued');
      } catch (err) {
        // Roll back the reserved slot if anything between reserve and the
        // successful queue.add throws (fs operations, queue down).
        if (reserved) {
          decrementQuota(quotaService, orgId, 'plugins', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
          reserved = false;
        }
        throw err;
      }
    }),
  );

  return router;
}
