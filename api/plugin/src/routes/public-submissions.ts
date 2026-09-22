// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The anonymous plugin submission API (docs/plans/plugin-ecosystem.md §4, E2),
 * mounted at `/public/plugin-submissions`; nginx exposes it as
 * `/api/public/plugin-submissions` with credentials stripped. No caller
 * identity by design:
 *
 *  - GET  /challenge            — a proof-of-work challenge
 *  - POST /inspect              — dry-run detection of a zip (PoW; stores nothing)
 *  - POST /                     — submit a zip into quarantine (PoW, email, terms) → N1
 *  - POST /verify               — the magic link (single use) → gates run
 *  - GET  /status?token=        — the submitter's view (status token only)
 *
 * Every route: 404 `SUBMISSIONS_DISABLED` unless the path is available
 * (flag + secrets + outbound email), rate limited per TRUSTED client IP,
 * `Cache-Control: no-store`. Nothing here creates a `plugins` row, reaches a
 * tenant or `public/*` namespace, or decides anything: the only way on from
 * quarantine is the two-person `submission` request (submission-moderation.ts).
 */

import * as fs from 'fs';

import { audited, ErrorCode, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { rateLimitByOrg } from '@pipeline-builder/api-server';
import { Router, type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';

import { bodyOf, ecosystemRoute } from './ecosystem-route.js';
import { EcosystemError } from '../services/ecosystem/context.js';
import {
  assertSubmissionsAvailable, createSubmission, inspectSubmission, issueChallenge, submissionConfig, submissionStatus, verifySubmission,
} from '../services/ecosystem/submissions.js';

const UPLOAD_DEST = process.env.PLUGIN_UPLOAD_DIR || '/opt/pipeline/pipeline-data/plugins-data';

/** Multer for one submission zip, capped at `SUBMISSION_MAX_ZIP_BYTES`. */
function zipUpload(): RequestHandler {
  return multer({
    dest: UPLOAD_DEST,
    limits: { files: 1, fileSize: submissionConfig().maxZipBytes, fields: 10, fieldSize: 64 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(file.mimetype) || file.originalname.endsWith('.zip');
      if (ok) cb(null, true);
      else cb(new Error('Only ZIP files are allowed'));
    },
  }).single('plugin') as RequestHandler;
}

function cleanupUpload(req: Request): void {
  const file = (req as Request & { file?: { path?: string } }).file;
  if (file?.path) fs.rm(file.path, { force: true }, () => undefined);
}

const multipartErrors: ErrorRequestHandler = (err, req, res, next) => {
  if (!err) return next();
  cleanupUpload(req);
  const tooLarge = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
  sendError(res, tooLarge ? 413 : 400, `File upload failed: ${(err as Error).message}`, tooLarge ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.VALIDATION_ERROR);
};

/** 404 unless the anonymous path is available right now; never cacheable. */
async function availability(_req: Request, res: Response, next: NextFunction): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await assertSubmissionsAvailable();
  } catch (err) {
    if (err instanceof EcosystemError) {
      sendError(res, 404, 'Not found', ErrorCode.SUBMISSIONS_DISABLED);
      return;
    }
    next(err);
    return;
  }
  next();
}

/** An ecosystem handler with no caller org (the submitter is anonymous by design). */
const anonymous = (handler: Parameters<typeof ecosystemRoute>[0]) => ecosystemRoute(handler, { requireOrgId: false });

/** The submission routes, under `/public/plugin-submissions`. */
export function createPublicSubmissionRoutes(limits: { readsPerMinute?: number; writesPerMinute?: number } = {}): Router {
  const router = Router();
  router.use(availability as RequestHandler);
  // Reads (challenge, status) and writes (inspect, submit, verify) bucket
  // separately per trusted client IP; the per-email/IP daily caps (and the
  // per-IP inspect cap) are atomic Redis counters in the service.
  const reads = rateLimitByOrg({ name: 'plugin-submission-read', keyBy: 'ip', max: limits.readsPerMinute ?? 60, windowMs: 60_000 }) as RequestHandler;
  const writes = rateLimitByOrg({ name: 'plugin-submission-write', keyBy: 'ip', max: limits.writesPerMinute ?? 10, windowMs: 60_000 }) as RequestHandler;

  router.get('/challenge', reads, anonymous(async ({ res }) => {
    sendSuccess(res, 200, issueChallenge());
  }));

  router.get('/status', reads, anonymous(async ({ req, res }) => {
    sendSuccess(res, 200, await submissionStatus(req.query.token));
  }));

  router.post('/inspect', writes, zipUpload(), multipartErrors, anonymous(async ({ req, res }) => {
    try {
      if (!req.file) throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'No plugin file uploaded');
      sendSuccess(res, 200, await inspectSubmission(req.file.path, bodyOf(req).pow, req.ip ?? ''));
    } finally {
      cleanupUpload(req);
    }
  }));

  router.post('/', writes, zipUpload(), multipartErrors, audited('plugin.submission.create') as RequestHandler, anonymous(async ({ req, res }) => {
    try {
      if (!req.file) throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, 'No plugin file uploaded');
      const body = bodyOf(req);
      const out = await createSubmission({
        zipPath: req.file.path,
        email: body.email,
        pow: body.pow,
        metadata: body.metadata,
        acceptTerms: body.acceptTerms,
        clientIp: req.ip ?? '',
      });
      sendSuccess(res, 202, out, 'Check your email to confirm the submission');
    } finally {
      cleanupUpload(req);
    }
  }));

  router.post('/verify', writes, audited('plugin.submission.verify') as RequestHandler, anonymous(async ({ req, res }) => {
    sendSuccess(res, 200, await verifySubmission(bodyOf(req).token));
  }));

  // Anything else under the prefix is a plain 404 (never falls through to the directory).
  router.use((_req: Request, res: Response) => { sendError(res, 404, 'Not found', ErrorCode.NOT_FOUND); });
  return router;
}
