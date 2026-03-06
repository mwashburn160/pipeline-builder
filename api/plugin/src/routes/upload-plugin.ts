import * as fs from 'fs';

import { ErrorCode, createLogger, requireSystemAdmin, resolveAccessModifier, sendBadRequest, sendError, sendSuccess, validateBody, PluginUploadBodySchema } from '@mwashburn160/api-core';
import { requireAuth, checkQuota, requireOrgId, withRoute } from '@mwashburn160/api-server';
import type { QuotaService } from '@mwashburn160/api-server';
import { Config, CoreConstants } from '@mwashburn160/pipeline-core';
import { Router, Request, Response, RequestHandler } from 'express';
import multer from 'multer';

import { parsePluginZip, validateBuildArgs } from '../helpers/manifest';
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
        const plugin = parsePluginZip(zipPath);
        validateBuildArgs(plugin.manifest.buildArgs);

        ctx.log('INFO', 'Manifest validated', {
          pluginName: plugin.manifest.name,
          version: plugin.manifest.version,
        });

        // -- Queue build job (returns immediately) ----------------------------
        const m = plugin.manifest;
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
            buildArgs: m.buildArgs || {},
          },
          pluginRecord: {
            orgId,
            name: m.name,
            description: m.description || null,
            version: m.version || '0.0.0',
            metadata: (m.metadata || {}) as Record<string, string | number | boolean>,
            pluginType: m.pluginType || 'CodeBuildStep',
            computeType: m.computeType || 'SMALL',
            primaryOutputDirectory: m.primaryOutputDirectory || null,
            dockerfile: plugin.dockerfileContent,
            env: m.env || {},
            buildArgs: m.buildArgs || {},
            keywords: m.keywords || [],
            installCommands: m.installCommands || [],
            commands: m.commands || [],
            imageTag: plugin.imageTag,
            accessModifier,
            timeout: m.timeout ?? null,
            failureBehavior: m.failureBehavior || 'fail',
            secrets: m.secrets || [],
          },
        });

        await getQueue().add(`upload-${m.name}-${plugin.imageTag}`, jobData);

        ctx.log('INFO', 'Build queued', {
          pluginName: m.name,
          imageTag: plugin.imageTag,
        });

        return sendSuccess(res, 202, {
          requestId: ctx.requestId,
          pluginName: m.name,
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
