// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';

import { ErrorCode, createLogger, errorMessage, getServiceAuthHeader, reserveQuota, decrementQuota, resolveAccessModifier, sendBadRequest, sendError, sendQuotaExceeded, sendSuccess, validateBody, PluginUploadBodySchema, createComplianceClient } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { requireAuth, requireOrgId, withRoute, withTenantContext } from '@pipeline-builder/api-server';
import { Config, CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router, type Request, type Response, type RequestHandler, type ErrorRequestHandler } from 'express';
import multer from 'multer';

import { getBuildStrategy } from '../helpers/build-strategy.js';
import { createBuildJobData } from '../helpers/plugin-helpers.js';
import { parsePluginZip, validateBuildArgs } from '../helpers/plugin-spec.js';
import { enqueueBuild, getOrgTier } from '../queue/plugin-build-queue.js';
import { pluginService } from '../services/plugin-service.js';

const logger = createLogger('upload-plugin');

const complianceClient = createComplianceClient();

const MAX_UPLOAD_SIZE = CoreConstants.PLUGIN_MAX_UPLOAD_MB * 1024 * 1024;

// Multer needs a writable destination. The plugin container runs with
// readOnlyRootFilesystem=true, so a relative path like `uploads/` resolves
// under `/app` and EROFS-fails. The volume is mounted at the canonical
// /opt/pipeline/pipeline-data/plugins-data/uploads (same on host + container
// so buildkit bind mounts work). Override via PLUGIN_UPLOAD_DIR for tests
// or alternate layouts.
const UPLOAD_DEST = process.env.PLUGIN_UPLOAD_DIR
  || '/opt/pipeline/pipeline-data/plugins-data/uploads';

const upload = multer({
  limits: { files: 1, fileSize: MAX_UPLOAD_SIZE },
  dest: UPLOAD_DEST,
  fileFilter: (_req, file, cb) => {
    const allowedMimes = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
    if (allowedMimes.includes(file.mimetype) || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  },
});

/**
 * Register the upload route.
 *
 * Applies its own auth + quota middleware (multer first, then auth,
 * then `plugins` quota check).
 */
export function createUploadPluginRoutes( quotaService: QuotaService,
): Router {
  const router: Router = Router();

  // Upload timeout: 5 minutes for large plugin ZIPs (overrides global HANDLER_TIMEOUT_MS)
  const UPLOAD_TIMEOUT_MS = parseInt(process.env.PLUGIN_UPLOAD_TIMEOUT_MS || '300000', 10);

  router.post( '/',
    // Extend timeout before multer starts reading the body
    ((req: Request, res: Response, next: () => void) => {
      res.setTimeout(UPLOAD_TIMEOUT_MS);
      req.setTimeout(UPLOAD_TIMEOUT_MS);
      next();
    }) as RequestHandler,
    upload.single('plugin') as RequestHandler,
    // Handle multer/busboy errors (e.g. "Unexpected end of form") before proceeding
    ((err, _req, res, next) => {
      if (err) {
        logger.error('Multipart parse error', { error: err.message });
        sendError(res, 400, `File upload failed: ${err.message}`, ErrorCode.VALIDATION_ERROR);
        return;
      }
      next();
    }) as ErrorRequestHandler,
    requireAuth as RequestHandler,
    requireOrgId() as RequestHandler,
    // Open the RLS tenant scope (orgId + isSuperAdmin) so deployVersion's reads/writes
    // against the FORCE-RLS plugins table see the caller's org — the factory routes get
    // this via createProtectedRoute, but this route hand-wires its chain.
    withTenantContext() as RequestHandler,
    // Any authenticated org member may upload a plugin. The accessModifier is
    // resolved by `resolveAccessModifier` below  only admins/owners can mark
    // a plugin 'public'; member uploads are forced to 'private' (org-scoped).
    // quota is reserved inside the handler (atomic check+increment)
    // so two concurrent uploads at the limit can't both succeed. The slot is
    // given back via `decrementQuota` on any failure path, including build
    // worker permanent failures.
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const registry = Config.get('registry');
      // Service-minted auth for downstream calls (compliance, quota). The
      // caller's bearer token may carry only end-user scopes that won't pass
      // service-to-service authorization checks; mint a service token instead.
      const authHeader = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });

      let zipPath: string | undefined;
      let reserved = false;
      let reservedResetAt: string | undefined; // resetAt observed at reserve time (for conditional rollback)

      try {
        if (!req.file) {
          return sendBadRequest(res, 'No plugin file uploaded', ErrorCode.MISSING_REQUIRED_FIELD);
        }

        const validation = validateBody(req, PluginUploadBodySchema);
        if (!validation.ok) {
          return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
        }
        const accessModifier = resolveAccessModifier(req, validation.value.accessModifier);

        // Reserve the plugins quota slot. Done AFTER multer + body validation
        // so a bad-request never consumes quota. Two concurrent uploads at the
        // limit can't both pass  the MongoDB filter rejects the second one.
        const reservation = await reserveQuota(quotaService, orgId, 'plugins', authHeader);
        if (reservation.exceeded) {
          ctx.log('WARN', 'Plugin quota exceeded', { orgId, used: reservation.quota.used, limit: reservation.quota.limit });
          return sendQuotaExceeded(res, 'plugins', reservation.quota, reservation.quota.resetAt);
        }
        reserved = true;
        reservedResetAt = reservation.quota.resetAt;

        zipPath = req.file.path;
        ctx.log('INFO', 'Upload received', {
          originalName: req.file.originalname,
          sizeBytes: req.file.size,
          accessModifier,
        });

        // -- Parse & validate ZIP ---------------------------------------------
        const plugin = await parsePluginZip(zipPath);
        validateBuildArgs(plugin.pluginSpec.buildArgs);

        ctx.log('INFO', 'Spec validated', {
          pluginName: plugin.pluginSpec.name,
          version: plugin.pluginSpec.version,
        });

        // -- Compliance check (fail-closed) -----------------------------------
        const s = plugin.pluginSpec;
        try {
          const complianceResult = await complianceClient.validatePlugin(orgId, {
            name: s.name,
            version: s.version,
            pluginType: s.pluginType,
            computeType: s.computeType,
            timeout: s.timeout,
            failureBehavior: s.failureBehavior,
            env: s.env,
            buildArgs: s.buildArgs,
            installCommands: s.installCommands,
            commands: s.commands,
            accessModifier,
            secrets: s.secrets,
            metadata: s.metadata,
            keywords: s.keywords,
            buildType: plugin.buildType,
          }, authHeader, undefined, s.name, 'upload');

          if (complianceResult.blocked) {
            ctx.log('WARN', 'Plugin upload blocked by compliance', {
              pluginName: s.name,
              violations: complianceResult.violations.length,
            });
            decrementQuota(quotaService, orgId, 'plugins', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
            reserved = false;
            return sendError(res, 403, 'Plugin upload blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
              violations: complianceResult.violations,
            });
          }

          if (complianceResult.warnings.length > 0) {
            ctx.log('WARN', 'Compliance warnings on plugin upload', {
              pluginName: s.name,
              warnings: complianceResult.warnings.length,
            });
          }
        } catch (err) {
          // Fail-closed: if compliance service is unreachable, reject the upload
          ctx.log('ERROR', 'Compliance service unavailable', {
            error: errorMessage(err),
          });
          decrementQuota(quotaService, orgId, 'plugins', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
          reserved = false;
          return sendError(res, 503, 'Compliance service unavailable  plugin upload rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
        }

        // -- Build plugin record --------------------------------------------------
        const pluginRecord = {
          orgId,
          name: s.name,
          description: s.description || null,
          version: s.version || '0.0.0',
          category: s.category || 'unknown',
          metadata: (s.metadata || {}) as Record<string, string | number | boolean>,
          pluginType: s.pluginType || 'CodeBuildStep',
          computeType: s.computeType || 'SMALL',
          primaryOutputDirectory: s.primaryOutputDirectory || null,
          dockerfile: plugin.dockerfileContent,
          env: s.env || {},
          buildArgs: s.buildArgs || {},
          keywords: s.keywords || [],
          installCommands: s.installCommands || [],
          commands: s.commands || [],
          accessModifier,
          timeout: s.timeout ?? null,
          failureBehavior: s.failureBehavior || 'fail',
          secrets: s.secrets || [],
          buildType: plugin.buildType,
        };

        // -- No image to build (metadata_only): deploy directly ----------------
        if (!getBuildStrategy(plugin.buildType).producesImage) {
          const result = await pluginService.deployVersion(pluginRecord, userId || 'system');

          ctx.log('INFO', 'Metadata-only plugin deployed', {
            pluginName: s.name,
            pluginId: result.id,
          });

          return sendSuccess(res, 201, {
            requestId: ctx.requestId,
            pluginId: result.id,
            pluginName: s.name,
            version: s.version,
            buildType: 'metadata_only',
          });
        }

        // -- Queue build job (returns immediately) ----------------------------
        const jobData = createBuildJobData({
          requestId: ctx.requestId,
          orgId,
          userId: userId || 'system',
          buildRequest: {
            contextDir: plugin.extractDir,
            dockerfile: plugin.dockerfile,
            name: s.name,
            version: s.version || '0.0.0',
            orgId,
            registry,
            buildArgs: s.buildArgs || {},
            buildType: plugin.buildType,
          },
          pluginRecord,
        });

        try {
          // route to the org's per-tier queue. Tier lookup is cached
          // (5-min TTL) so submission stays single round-trip on hot orgs.
          const tier = await getOrgTier(quotaService, orgId, authHeader);
          await enqueueBuild(tier, `${s.name}:${s.version || '0.0.0'}`, jobData);
        } catch (queueErr) {
          ctx.log('ERROR', 'Failed to enqueue build job', {
            error: queueErr instanceof Error ? queueErr.message: String(queueErr),
          });
          decrementQuota(quotaService, orgId, 'plugins', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
          reserved = false;
          return sendError(res, 503, 'Build queue unavailable  please retry', ErrorCode.SERVICE_UNAVAILABLE);
        }

        ctx.log('INFO', 'Build queued', {
          pluginName: s.name,
          version: s.version || '0.0.0',
        });

        return sendSuccess(res, 202, {
          requestId: ctx.requestId,
          pluginName: s.name,
          version: s.version || '0.0.0',
        }, 'Plugin build queued');
      } catch (err) {
        // Any unexpected throw (e.g. parsePluginZip, deployVersion)  roll
        // back the reserved slot before propagating, otherwise the slot
        // sticks until period reset.
        if (reserved) {
          decrementQuota(quotaService, orgId, 'plugins', authHeader, ctx.log.bind(null, 'WARN'), 1, reservedResetAt);
        }
        throw err;
      } finally {
        // Clean up uploaded zip (extract dir is cleaned up by the worker)
        if (zipPath && fs.existsSync(zipPath)) {
          try { fs.unlinkSync(zipPath); } catch (err) { logger.debug('Temp zip cleanup failed', { path: zipPath, error: String(err) }); }
        }
      }
    }),
  );

  return router;
}
