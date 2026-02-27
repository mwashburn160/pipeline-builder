/**
 * @module routes/upload-plugin
 * @description Plugin upload and deployment.
 *
 * POST /plugins — upload a ZIP containing manifest.yaml + Dockerfile,
 *                 build a container image, push to registry, store metadata
 *
 * This route manages its own middleware chain because:
 *   1. Multer (multipart form-data) must run before auth.
 *   2. It checks the `plugins` quota, not `apiCalls`.
 */

import * as fs from 'fs';

import { ErrorCode, createLogger, isSystemAdmin, resolveAccessModifier, errorMessage, sendBadRequest, sendInternalError, sendError, sendSuccess, validateBody, PluginUploadBodySchema } from '@mwashburn160/api-core';
import { authenticateToken, checkQuota, getContext, requireOrgId } from '@mwashburn160/api-server';
import type { QuotaService } from '@mwashburn160/api-server';
import { Config } from '@mwashburn160/pipeline-core';
import { Router, Request, Response, RequestHandler } from 'express';
import multer from 'multer';

import { parsePluginZip, ValidationError } from '../helpers/manifest';
import { getQueue } from '../queue/plugin-build-queue';

const logger = createLogger('upload-plugin');

const MAX_UPLOAD_SIZE = parseInt(process.env.PLUGIN_MAX_UPLOAD_MB || '50', 10) * 1024 * 1024;

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
    authenticateToken as RequestHandler,
    requireOrgId() as RequestHandler,
    // Admin check BEFORE quota — non-admins should be rejected without consuming quota
    ((req: Request, res: Response, next: () => void) => {
      if (!isSystemAdmin(req)) {
        return sendError(res, 403, 'Only administrators can upload plugins', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }
      next();
    }) as RequestHandler,
    checkQuota(quotaService, 'plugins') as RequestHandler,
    async (req: Request, res: Response) => {
      const ctx = getContext(req);
      const config = Config.get();

      let zipPath: string | undefined;

      try {
        if (!req.file) {
          return sendBadRequest(res, 'No plugin file uploaded', ErrorCode.MISSING_REQUIRED_FIELD);
        }

        if (!ctx.identity.orgId) return sendBadRequest(res, 'Organization ID is required');
        const orgId = ctx.identity.orgId.toLowerCase();
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

        ctx.log('INFO', 'Manifest validated', {
          pluginName: plugin.manifest.name,
          version: plugin.manifest.version,
        });

        // -- Queue build job (returns immediately) ----------------------------
        const buildQueue = getQueue();
        await buildQueue.add(
          `upload-${plugin.manifest.name}-${plugin.imageTag}`,
          {
            requestId: ctx.requestId,
            orgId,
            userId: ctx.identity.userId || 'system',
            authToken: req.headers.authorization || '',
            buildRequest: {
              contextDir: plugin.extractDir,
              dockerfile: plugin.dockerfile,
              imageTag: plugin.imageTag,
              registry: config.registry,
              buildArgs: plugin.manifest.buildArgs || {},
            },
            pluginRecord: {
              orgId,
              name: plugin.manifest.name,
              description: plugin.manifest.description || null,
              version: plugin.manifest.version || '0.0.0',
              metadata: (plugin.manifest.metadata || {}) as Record<string, string | number | boolean>,
              pluginType: plugin.manifest.pluginType || 'CodeBuildStep',
              computeType: plugin.manifest.computeType || 'SMALL',
              primaryOutputDirectory: plugin.manifest.primaryOutputDirectory || null,
              dockerfile: plugin.dockerfileContent,
              env: plugin.manifest.env || {},
              buildArgs: plugin.manifest.buildArgs || {},
              keywords: plugin.manifest.keywords || [],
              installCommands: plugin.manifest.installCommands || [],
              commands: plugin.manifest.commands || [],
              imageTag: plugin.imageTag,
              accessModifier,
              timeout: plugin.manifest.timeout ?? null,
              failureBehavior: plugin.manifest.failureBehavior || 'fail',
              secrets: plugin.manifest.secrets || [],
            },
          },
        );

        ctx.log('INFO', 'Build queued', {
          pluginName: plugin.manifest.name,
          imageTag: plugin.imageTag,
        });

        // Clean up the uploaded zip (extract dir is cleaned up by the worker)
        if (zipPath && fs.existsSync(zipPath)) {
          try { fs.unlinkSync(zipPath); } catch (err) { logger.debug('Temp zip cleanup failed', { path: zipPath, error: String(err) }); }
          zipPath = undefined;
        }

        return sendSuccess(res, 202, {
          requestId: ctx.requestId,
          pluginName: plugin.manifest.name,
          imageTag: plugin.imageTag,
        }, 'Plugin build queued');
      } catch (error) {
        if (res.headersSent) {
          logger.error('Upload failed (response already sent)', { requestId: ctx.requestId, error: errorMessage(error), orgId: ctx.identity.orgId });
          return;
        }

        if (error instanceof ValidationError) {
          return sendBadRequest(res, error.message);
        }

        logger.error('Upload failed', { requestId: ctx.requestId, error: errorMessage(error), orgId: ctx.identity.orgId });

        return sendInternalError(res, 'Plugin upload failed');
      } finally {
        // Clean up zip if not already removed (error path)
        if (zipPath && fs.existsSync(zipPath)) {
          try { fs.unlinkSync(zipPath); } catch (err) { logger.debug('Temp zip cleanup failed', { path: zipPath, error: String(err) }); }
        }
      }
    },
  );

  return router;
}
