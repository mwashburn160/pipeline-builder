// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ErrorCode,
  createLogger,
  errorMessage,
  getParam,
  requirePermission,
  sendBadRequest,
  sendError,
  sendSuccess,
  sendEntityNotFound,
  MESSAGE_ATTACHMENT_ALLOWED_MIME,
  MESSAGE_ATTACHMENT_MAX_BYTES,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import {
  withRoute,
  incrementQuotaFromCtx,
  incCounter,
  createProtectedRoute,
  rateLimitByOrg,
} from '@pipeline-builder/api-server';
import { Router, type Request, type RequestHandler, type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { attachmentService } from '../services/attachment-service.js';
import { deleteAttachment, getAttachmentStream, getAttachmentStreamOrNull, putAttachment, generateThumbnail, thumbnailKeyFor, thumbnailContentType } from '../services/attachment-storage.js';
import { messageService } from '../services/message-service.js';

const logger = createLogger('attachment-routes');

// Attachment size cap + MIME allow-list are shared in api-core
// (MESSAGE_ATTACHMENT_MAX_BYTES / MESSAGE_ATTACHMENT_ALLOWED_MIME) so the bounds
// live with the other message limits, not only inline here.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MESSAGE_ATTACHMENT_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (MESSAGE_ATTACHMENT_ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

/** Sanitize a client filename for use inside an object key (never trust it raw). */
function safeName(name: string): string {
  return (name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
}

/**
 * Attachment routes:
 *   POST /messages/attachments        — upload one file (returns metadata + id)
 *   GET  /messages/attachments/:id     — download a file (visibility-gated)
 *
 * Flow: the client uploads a file, gets an id back, then includes that id in the
 * `attachmentIds` of a POST /messages (or reply). Uploads not attached to a sent
 * message are harmless pending orphans reaped by retention.
 */
/** Per-org upload limiter — attachment uploads buffer up to 10 MiB + write to
 *  object storage, so a single org shouldn't be able to hammer them. Lower cap
 *  than message-send. Env-overridable; runs BEFORE multer (below). */
const uploadLimiter = rateLimitByOrg({
  name: 'attachment-upload',
  max: Math.max(1, Number.parseInt(process.env.MESSAGE_ATTACHMENT_RATE_MAX ?? '30', 10) || 30),
  windowMs: Math.max(1000, Number.parseInt(process.env.MESSAGE_ATTACHMENT_RATE_WINDOW_MS ?? '60000', 10) || 60000),
  message: 'Too many attachment uploads, please slow down.',
});

export function createAttachmentRoutes(quotaService: QuotaService): Router {
  const router = Router();

  // -- Upload -----------------------------------------------------------------
  router.post(
    '/attachments',
    // Auth + orgId + apiCalls quota (+ tenant scope) BEFORE multer, so an
    // unauthenticated or over-quota client can't force multipart buffering of a
    // 10 MiB body. Mirrors the read routes' protection.
    ...createProtectedRoute(quotaService, 'apiCalls'),
    requirePermission('messages:write'),
    // Per-org upload rate limit — reject BEFORE multer buffers the multipart body.
    uploadLimiter,
    upload.single('file') as RequestHandler,
    // Convert multer errors (too large / wrong type / malformed) to a clean 4xx.
    ((err, _req, res, next) => {
      if (err) {
        const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
        sendError(res, tooBig ? 413 : 400, `Attachment upload failed: ${err.message}`,
          tooBig ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.VALIDATION_ERROR);
        return;
      }
      next();
    }) as ErrorRequestHandler,
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) return sendBadRequest(res, 'No file uploaded', ErrorCode.MISSING_REQUIRED_FIELD);
      if (!MESSAGE_ATTACHMENT_ALLOWED_MIME.has(file.mimetype)) {
        return sendBadRequest(res, `Unsupported file type: ${file.mimetype}`, ErrorCode.VALIDATION_ERROR);
      }

      const id = uuidv4();
      const storageKey = `${orgId.toLowerCase()}/${id}/${safeName(file.originalname)}`;

      try {
        await putAttachment(storageKey, file.buffer, file.mimetype);
      } catch (err) {
        ctx.log('ERROR', 'Attachment blob store failed', { error: errorMessage(err) });
        return sendError(res, 502, 'Attachment storage is unavailable', ErrorCode.INTERNAL_ERROR);
      }

      let attachment;
      try {
        attachment = await attachmentService.createPending({
          orgId: orgId.toLowerCase(),
          uploadedBy: userId,
          filename: file.originalname.slice(0, 255),
          contentType: file.mimetype,
          sizeBytes: file.size,
          storageKey,
        });
      } catch (err) {
        // Metadata insert failed — reclaim the orphaned blob so it can't leak.
        await deleteAttachment(storageKey);
        ctx.log('ERROR', 'Attachment metadata insert failed', { error: errorMessage(err) });
        return sendError(res, 500, 'Failed to record attachment', ErrorCode.INTERNAL_ERROR);
      }

      // Best-effort image thumbnail (downscaled preview served via ?thumb=1).
      // Non-fatal: a failure just means the client falls back to the original.
      // The original + metadata are already committed, so this never blocks them.
      if (file.mimetype.startsWith('image/')) {
        try {
          const thumb = await generateThumbnail(file.buffer, file.mimetype);
          if (thumb) await putAttachment(thumbnailKeyFor(orgId, id), thumb.body, thumb.contentType);
        } catch (err) {
          ctx.log('WARN', 'Thumbnail store failed (serving original)', { error: errorMessage(err) });
        }
      }

      incCounter('message_attachments_total', { action: 'uploaded' });
      incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');
      ctx.log('COMPLETED', 'Attachment uploaded', { id: attachment.id, size: file.size });

      // Return metadata only — never the storage key (internal) or a blob URL.
      return sendSuccess(res, 201, {
        attachment: {
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
        },
      });
    }),
  );

  // -- Download ---------------------------------------------------------------
  router.get(
    '/attachments/:id',
    ...createProtectedRoute(quotaService, 'apiCalls'),
    requirePermission('messages:read'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const id = getParam(req.params, 'id');
      if (!id) return sendBadRequest(res, 'Attachment ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

      const att = await attachmentService.findById(id);
      if (!att) return sendEntityNotFound(res, 'Attachment');

      // Authorization (the attachment row itself is NOT caller-org filtered).
      // A LINKED attachment is readable iff the caller can read its parent
      // message — viewer-scoped, so a per-user targeted message's attachment
      // stays private to the target, AND a cross-org (org→support / announcement)
      // attachment is readable by the message's recipient. A PENDING attachment
      // (not yet attached) is readable only by its uploader (RLS already bounds
      // it to the uploader's org; this pins it to the specific user).
      if (att.messageId) {
        const msg = await messageService.findVisibleById(att.messageId, orgId, userId);
        if (!msg) return sendEntityNotFound(res, 'Attachment');
      } else if (att.uploadedBy !== userId) {
        return sendEntityNotFound(res, 'Attachment');
      }

      const isImage = att.contentType.startsWith('image/');
      // ?thumb=1 → serve the downscaled preview when one exists (images only),
      // else transparently fall back to the original blob.
      const wantThumb = isImage && (req.query?.thumb === '1' || req.query?.thumb === 'true');

      let stream: NodeJS.ReadableStream | null = null;
      let servedThumb = false;
      let contentType = att.contentType;
      if (wantThumb) {
        stream = await getAttachmentStreamOrNull(thumbnailKeyFor(att.orgId, att.id));
        if (stream) { servedThumb = true; contentType = thumbnailContentType(att.contentType); }
      }
      if (!stream) {
        try {
          stream = await getAttachmentStream(att.storageKey);
        } catch (err) {
          ctx.log('ERROR', 'Attachment blob fetch failed', { id, error: errorMessage(err) });
          return sendError(res, 502, 'Attachment storage is unavailable', ErrorCode.INTERNAL_ERROR);
        }
      }

      incrementQuotaFromCtx(quotaService, { req, ctx, orgId }, 'apiCalls');
      res.setHeader('Content-Type', contentType);
      // Content-Length is only known for the original (thumbnail size isn't
      // persisted); omit it for a thumbnail and let the stream close the response.
      if (!servedThumb) res.setHeader('Content-Length', String(att.sizeBytes));
      // Block MIME sniffing of a user-uploaded blob served inline (defense in
      // depth on top of the upload MIME allow-list).
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Inline for images (preview), attachment for everything else (safe default).
      const disp = isImage ? 'inline' : 'attachment';
      res.setHeader('Content-Disposition', `${disp}; filename="${safeName(att.filename)}"`);
      // Never let a proxy/CDN share a tenant's private blob across users.
      res.setHeader('Cache-Control', 'private, no-store');

      stream.on('error', (err: unknown) => {
        logger.error('Attachment stream error', { id, error: String(err) });
        if (!res.headersSent) res.status(502).end();
        else res.destroy();
      });
      (stream as NodeJS.ReadableStream).pipe(res as unknown as NodeJS.WritableStream);
      return undefined;
    }),
  );

  return router;
}
