// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import path from 'path';

import {
  requireAdmin,
  resolveAccessModifier,
  sendBadRequest,
  sendSuccess,
  validateBody,
  PluginDeployGeneratedSchema,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { checkQuota, withRoute } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { v7 as uuid } from 'uuid';

import { BUILD_TEMP_ROOT } from '../helpers/docker-build';
import { createBuildJobData, generateImageTag } from '../helpers/plugin-helpers';
import { validateBuildArgs } from '../helpers/plugin-spec';
import { getQueue } from '../queue/plugin-build-queue';

/**
 * Create and register the deploy-generated plugin route.
 *
 * Builds a Docker image from an AI-generated Dockerfile and persists
 * the plugin record to the database via the build queue.
 *
 * Requires admin permissions. Validated with {@link PluginDeployGeneratedSchema}.
 */
export function createDeployGeneratedPluginRoutes(
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  router.post(
    '/deploy-generated',
    // Admin check BEFORE quota — non-admins should be rejected without consuming quota.
    // Both system admins and org admins/owners can deploy AI-generated plugins.
    requireAdmin as RequestHandler,
    checkQuota(quotaService, 'plugins') as RequestHandler,
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const registry = Config.get('registry');

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

      const imageTag = generateImageTag(name);

      ctx.log('INFO', 'Deploying AI-generated plugin', {
        pluginName: name,
        version,
        imageTag,
        accessModifier,
      });

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
          imageTag,
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
          imageTag,
          accessModifier,
          buildType: 'build_image',
        },
      });

      await getQueue().add(`deploy-generated-${name}-${imageTag}`, jobData);

      ctx.log('INFO', 'Build queued', {
        pluginName: name,
        imageTag,
      });

      return sendSuccess(res, 202, {
        requestId: ctx.requestId,
        pluginName: name,
        imageTag,
      }, 'Plugin build queued');
    }),
  );

  return router;
}
