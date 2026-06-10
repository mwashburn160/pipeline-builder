// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import path from 'path';

import {
  requireAdmin,
  reserveQuota,
  decrementQuota,
  resolveAccessModifier,
  sendBadRequest,
  sendQuotaExceeded,
  sendSuccess,
  validateBody,
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
    requireAdmin as RequestHandler,
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const registry = Config.get('registry');
      const authHeader = req.headers.authorization || '';

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
          decrementQuota(quotaService, orgId, 'plugins', authHeader, ctx.log.bind(null, 'WARN'));
          reserved = false;
        }
        throw err;
      }
    }),
  );

  return router;
}
