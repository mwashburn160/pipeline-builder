import * as fs from 'fs';

import { ErrorCode, createLogger, errorMessage, requireSystemAdmin, resolveAccessModifier, sendBadRequest, sendError, sendSuccess, validateBody, PluginUploadBodySchema, createComplianceClient } from '@mwashburn160/api-core';
import type { QuotaService } from '@mwashburn160/api-core';
import { requireAuth, checkQuota, requireOrgId, withRoute } from '@mwashburn160/api-server';
import { Config, CoreConstants } from '@mwashburn160/pipeline-core';
import { Router, Request, Response, RequestHandler } from 'express';
import multer from 'multer';

import { parsePluginZip, validateBuildArgs } from '../helpers/spec';
import { createBuildJobData } from '../helpers/plugin-helpers';
import { getQueue } from '../queue/plugin-build-queue';

const logger = createLogger('upload-plugin');

const MAX_UPLOAD_SIZE = CoreConstants.PLUGIN_MAX_UPLOAD_MB * 1024 * 1024;

const upload = multer({
  limits: { files: 1, fileSize: MAX_UPLOAD_SIZE },
  dest: 'uploads/',
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
export function createUploadPluginRoutes(
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  router.post(
    '/',
    upload.single('plugin') as RequestHandler,
    // Handle multer/busboy errors (e.g. "Unexpected end of form") before proceeding
    ((err: Error, _req: Request, res: Response, next: (err?: Error) => void) => {
      if (err) {
        logger.error('Multipart parse error', { error: err.message });
        return sendError(res, 400, `File upload failed: ${err.message}`, ErrorCode.VALIDATION_ERROR);
      }
      next();
    }) as unknown as RequestHandler,
    requireAuth as RequestHandler,
    requireOrgId() as RequestHandler,
    // Admin check BEFORE quota — non-admins should be rejected without consuming quota
    requireSystemAdmin as RequestHandler,
    checkQuota(quotaService, 'plugins') as RequestHandler,
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const registry = Config.get('registry');

      let zipPath: string | undefined;

      try {
        if (!req.file) {
          return sendBadRequest(res, 'No plugin file uploaded', ErrorCode.MISSING_REQUIRED_FIELD);
        }

        const validation = validateBody(req, PluginUploadBodySchema);
        if (!validation.ok) {
          return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
        }
        const accessModifier = resolveAccessModifier(req, validation.value.accessModifier);

        zipPath = req.file.path;
        ctx.log('INFO', 'Upload received', {
          originalName: req.file.originalname,
          sizeBytes: req.file.size,
          accessModifier,
        });

        // -- Parse & validate ZIP ---------------------------------------------
        const plugin = await parsePluginZip(zipPath);
        validateBuildArgs(plugin.spec.buildArgs);

        ctx.log('INFO', 'Spec validated', {
          pluginName: plugin.spec.name,
          version: plugin.spec.version,
        });

        // -- Compliance check (fail-closed) -----------------------------------
        const s = plugin.spec;
        try {
          const complianceClient = createComplianceClient();
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
            imageTag: plugin.imageTag,
            metadata: s.metadata,
            keywords: s.keywords,
            buildType: plugin.buildType,
          }, req.headers.authorization || '', undefined, s.name, 'upload');

          if (complianceResult.blocked) {
            ctx.log('WARN', 'Plugin upload blocked by compliance', {
              pluginName: s.name,
              violations: complianceResult.violations.length,
            });
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
          return sendError(res, 503, 'Compliance service unavailable — plugin upload rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
        }

        // -- Queue build job (returns immediately) ----------------------------
        const jobData = createBuildJobData({
          requestId: ctx.requestId,
          orgId,
          userId: userId || 'system',
          authToken: req.headers.authorization || '',
          buildRequest: {
            contextDir: plugin.extractDir,
            dockerfile: plugin.dockerfile,
            imageTag: plugin.imageTag,
            registry,
            buildArgs: s.buildArgs || {},
            buildType: plugin.buildType,
            imageTarPath: plugin.imageTarPath ?? undefined,
          },
          pluginRecord: (() => {
            const raw = s as unknown as Record<string, unknown>;
            const category = typeof raw.category === 'string' ? raw.category : 'unknown';

            return {
              orgId,
              name: s.name,
              description: s.description || null,
              version: s.version || '0.0.0',
              category,
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
              imageTag: plugin.imageTag,
              accessModifier,
              timeout: s.timeout ?? null,
              failureBehavior: s.failureBehavior || 'fail',
              secrets: s.secrets || [],
              buildType: plugin.buildType,
            };
          })(),
        });

        try {
          await getQueue().add(`upload-${s.name}-${plugin.imageTag}`, jobData);
        } catch (queueErr) {
          ctx.log('ERROR', 'Failed to enqueue build job', {
            error: queueErr instanceof Error ? queueErr.message : String(queueErr),
          });
          return sendError(res, 503, 'Build queue unavailable — please retry', ErrorCode.SERVICE_UNAVAILABLE);
        }

        ctx.log('INFO', 'Build queued', {
          pluginName: s.name,
          imageTag: plugin.imageTag,
        });

        return sendSuccess(res, 202, {
          requestId: ctx.requestId,
          pluginName: s.name,
          imageTag: plugin.imageTag,
        }, 'Plugin build queued');
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
