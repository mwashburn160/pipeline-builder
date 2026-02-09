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

import { extractDbError, ErrorCode, createLogger, isSystemAdmin, errorMessage, sendBadRequest, sendInternalError } from '@mwashburn160/api-core';
import { authenticateToken, createRequestContext, checkQuota, requireOrgId } from '@mwashburn160/api-server';
import type { SSEManager, QuotaService } from '@mwashburn160/api-server';
import { Config, db, schema, AccessModifier, ComputeType, PluginType } from '@mwashburn160/pipeline-core';
import { eq } from 'drizzle-orm';
import { Router, Request, Response, RequestHandler } from 'express';
import multer from 'multer';
import { buildAndPush } from '../helpers/docker-build';
import { parsePluginZip, ValidationError } from '../helpers/manifest';

const logger = createLogger('upload-plugin');

const upload = multer({
  limits: { files: 1, fileSize: 100 * 1024 * 1024 },
  dest: 'uploads/',
});

/**
 * Register the upload route.
 *
 * Applies its own auth + quota middleware (multer first, then auth,
 * then `plugins` quota check).
 */
export function createUploadPluginRoutes(
  sseManager: SSEManager,
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  router.post(
    '/',
    upload.single('plugin') as RequestHandler,
    authenticateToken as RequestHandler,
    requireOrgId(sseManager) as RequestHandler,
    checkQuota(quotaService, sseManager, 'plugins') as RequestHandler,
    async (req: Request, res: Response) => {
      const ctx = createRequestContext(req, res, sseManager);
      const config = Config.get();

      let zipPath: string | undefined;
      let extractDir: string | undefined;

      try {
        if (!req.file) {
          return sendBadRequest(res, 'No plugin file uploaded', ErrorCode.MISSING_REQUIRED_FIELD);
        }

        // Only admins (system or org) can upload plugins
        if (ctx.identity.role !== 'admin') {
          ctx.log('INFO', 'Non-admin denied plugin upload');
          return res.status(403).json({
            success: false,
            statusCode: 403,
            error: 'Only administrators can upload plugins.',
            code: ErrorCode.INSUFFICIENT_PERMISSIONS,
          });
        }

        const orgId = ctx.identity.orgId!.toLowerCase();
        let accessModifier = (req.body as { accessModifier?: string }).accessModifier === 'public'
          ? 'public'
          : 'private';

        // Only system admins can create public plugins
        if (!isSystemAdmin(req) && accessModifier === 'public') {
          accessModifier = 'private';
          ctx.log('INFO', 'Non-system-admin forced to private access');
        }

        zipPath = req.file.path;
        ctx.log('INFO', 'Upload received', {
          originalName: req.file.originalname,
          sizeBytes: req.file.size,
          orgId,
          accessModifier,
        });

        // -- Parse & validate ZIP ---------------------------------------------
        const plugin = parsePluginZip(zipPath);
        extractDir = plugin.extractDir;

        ctx.log('INFO', 'Manifest validated', {
          pluginName: plugin.manifest.name,
          version: plugin.manifest.version,
        });

        // -- Build & push Docker image ----------------------------------------
        const { fullImage } = buildAndPush({
          contextDir: plugin.extractDir,
          dockerfile: plugin.dockerfile,
          imageTag: plugin.imageTag,
          registry: config.registry,
        });

        ctx.log('INFO', 'Image pushed', { fullImage });

        // -- Persist to database ----------------------------------------------
        const result = await db.transaction(async (tx: any) => {
          await tx
            .update(schema.plugin)
            .set({
              isDefault: false,
              updatedAt: new Date(),
              updatedBy: ctx.identity.userId || 'system',
            })
            .where(eq(schema.plugin.name, plugin.manifest.name));

          const [inserted] = await tx
            .insert(schema.plugin)
            .values({
              orgId,
              name: plugin.manifest.name,
              description: plugin.manifest.description || null,
              version: plugin.manifest.version,
              metadata: plugin.manifest.metadata || {},
              pluginType: (plugin.manifest.pluginType || 'CodeBuildStep') as PluginType,
              computeType: (plugin.manifest.computeType || 'SMALL') as ComputeType,
              dockerfile: plugin.dockerfileContent,
              env: plugin.manifest.env || {},
              installCommands: plugin.manifest.installCommands || [],
              commands: plugin.manifest.commands,
              imageTag: plugin.imageTag,
              accessModifier: accessModifier as AccessModifier,
              isDefault: true,
              isActive: true,
              createdBy: ctx.identity.userId || 'system',
            })
            .returning();

          return inserted;
        });

        void quotaService.increment(orgId, 'plugins', req.headers.authorization || '');

        ctx.log('COMPLETED', 'Plugin deployed', {
          id: result.id,
          name: result.name,
          version: result.version,
          imageTag: result.imageTag,
        });

        return res.status(201).json({
          success: true,
          statusCode: 201,
          id: result.id,
          name: result.name,
          version: result.version,
          imageTag: result.imageTag,
          fullImage,
          accessModifier: result.accessModifier,
          isDefault: result.isDefault,
          isActive: result.isActive,
          createdBy: result.createdBy,
          message: accessModifier === 'public'
            ? 'Public plugin deployed successfully (accessible to all organizations)'
            : `Private plugin deployed successfully (accessible to ${orgId} only)`,
        });
      } catch (error) {
        if (error instanceof ValidationError) {
          return sendBadRequest(res, error.message);
        }

        const message = errorMessage(error);
        const dbDetails = extractDbError(error);
        logger.error('Deployment failed', { error: message, ...dbDetails });

        return sendInternalError(res, 'Plugin deployment failed', { details: message, ...dbDetails });
      } finally {
        if (zipPath && fs.existsSync(zipPath)) {
          try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
        }
        if (extractDir && fs.existsSync(extractDir)) {
          try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    },
  );

  return router;
}
