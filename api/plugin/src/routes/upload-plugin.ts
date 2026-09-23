// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';

import { SYSTEM_ACTOR_ID, ErrorCode, audited, createLogger, envInt, isSystemAdmin, requireAuth, userHasPermission, errorMessage, getServiceAuthHeader, requirePermission, resolveVisibility, sendBadRequest, sendError, sendQuotaReserveDenied, sendSuccess, validateBody, PluginUploadBodySchema, actorId, detectCatalogMetadata, parseCatalogEditsPart, resolveCatalogMetadata, recordAudit } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { requireOrgId, withRoute, withTenantContext, rateLimitByOrg, withQuotaReservation, type QuotaSlot, type SSEManager } from '@pipeline-builder/api-server';
import type { PluginSpec } from '@pipeline-builder/pipeline-core';
import { Config, CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router, type Request, type Response, type RequestHandler, type ErrorRequestHandler } from 'express';
import multer from 'multer';

import { getBuildStrategy } from '../helpers/build-strategy.js';
import { compliancePreflight, queuePluginBuild } from '../helpers/build-submission.js';
import { catalogColumns } from '../helpers/catalog-metadata.js';
import { DEFAULT_PLUGIN_VERSION } from '../helpers/default-version.js';
import { createBuildJobData, toPluginInsert } from '../helpers/plugin-helpers.js';
import { parsePluginZip, specContractFields, validateBuildArgs, type ParsedPlugin } from '../helpers/plugin-spec.js';
import { callerFromRequest } from '../services/ecosystem/context.js';
import { submitAfterBuild } from '../services/ecosystem/requests.js';
import { deletePluginArtifact, pluginArtifactKey, putPluginArtifact } from '../services/plugin-artifact-storage.js';
import { pluginService } from '../services/plugin-service.js';

const logger = createLogger('upload-plugin');

const MAX_UPLOAD_SIZE = CoreConstants.PLUGIN_MAX_UPLOAD_MB * 1024 * 1024;

// Multer needs a writable destination for the incoming multipart ZIP. The
// plugin container runs with readOnlyRootFilesystem=true, so a relative path
// like `uploads/` resolves under `/app` and EROFS-fails. It writes into the
// per-pod build-scratch volume mounted at the canonical
// /opt/pipeline/pipeline-data/plugins-data. The staged ZIP is transient — it is
// uploaded to object storage (for cross-replica builds) and extracted locally,
// then deleted in the finally block. Override via PLUGIN_UPLOAD_DIR for tests.
const UPLOAD_DEST = process.env.PLUGIN_UPLOAD_DIR
  || '/opt/pipeline/pipeline-data/plugins-data';

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
 * Remove the multer temp ZIP for this request, if one was written.
 *
 * Called from the handler's `finally` (EVERY outcome, early returns included)
 * and from the multipart error handler (a parse error short-circuits before the
 * handler runs). Nothing else reclaims these files: the stale-temp sweeper
 * (`cleanupStaleTempDirs`) scans BUILD_TEMP_ROOT, not the multer upload
 * destination.
 */
function cleanupUploadFile(req: Request): void {
  const uploaded = (req as Request & { file?: { path?: string } }).file;
  if (!uploaded?.path) return;
  try {
    fs.unlinkSync(uploaded.path);
  } catch (err) {
    // Best-effort: the file may not have been created yet.
    logger.debug('Upload temp cleanup failed', { path: uploaded.path, error: String(err) });
  }
}

/** What catalog detection reads from a parsed zip. */
function catalogInputs(plugin: Pick<ParsedPlugin, 'pluginSpec' | 'readmeMd' | 'dockerfileContent'>): {
  spec: PluginSpec; readmeMd: string | null; dockerfileContent: string | null;
} {
  return { spec: plugin.pluginSpec, readmeMd: plugin.readmeMd, dockerfileContent: plugin.dockerfileContent };
}

/**
 * Register the upload route (`POST /plugins`) and its dry-run sibling
 * (`POST /plugins/inspect`).
 *
 * Hand-wires its own chain — auth, orgId, `plugins:write` and the per-org rate
 * limit run BEFORE multer accepts the body; the `plugins` quota slot is reserved
 * inside the handler (atomic check+increment).
 */
export function createUploadPluginRoutes( quotaService: QuotaService,
  sseManager: SSEManager,
): Router {
  const router: Router = Router();

  // Upload timeout: 5 minutes for large plugin ZIPs (overrides global HANDLER_TIMEOUT_MS)
  const UPLOAD_TIMEOUT_MS = envInt('PLUGIN_UPLOAD_TIMEOUT_MS', 300_000, { min: 1 });

  router.post( '/',
    // Extend timeout before multer starts reading the body
    ((req: Request, res: Response, next: () => void) => {
      res.setTimeout(UPLOAD_TIMEOUT_MS);
      req.setTimeout(UPLOAD_TIMEOUT_MS);
      next();
    }) as RequestHandler,
    // AUTHORIZE BEFORE ACCEPTING THE BODY. Multer streams the whole request to
    // UPLOAD_DEST (up to PLUGIN_MAX_UPLOAD_MB), so running it first would let an
    // unauthenticated caller fill the build-scratch volume — and nothing reclaims
    // a file whose handler never ran (the stale-temp sweep scans
    // BUILD_TEMP_ROOT, not UPLOAD_DEST). Everything here reads only headers.
    requireAuth as RequestHandler,
    requireOrgId() as RequestHandler,
    // Gate the mutation on `plugins:write` (mirrors the factory write routes and
    // pipeline's create route). members keep access via the role bundle; this
    // enforces the permission for custom groups.
    requirePermission('plugins:write') as RequestHandler,
    // Per-org burst cap on the build-triggering upload path (each upload runs an
    // async Docker build). Keys on the verified org.
    rateLimitByOrg({ name: 'plugin-upload', max: 30, windowMs: 60_000, message: 'Too many plugin uploads, please slow down.' }) as RequestHandler,
    upload.single('plugin') as RequestHandler,
    // Handle multer/busboy errors (e.g. "Unexpected end of form") before proceeding
    ((err, req, res, next) => {
      if (err) {
        logger.error('Multipart parse error', { error: err.message });
        // Reclaim a partially-written upload: multer may have created the temp
        // file before failing, and the handler's `finally` never runs.
        cleanupUploadFile(req as Request);
        sendError(res, 400, `File upload failed: ${err.message}`, ErrorCode.VALIDATION_ERROR);
        return;
      }
      next();
    }) as ErrorRequestHandler,
    // Open the RLS tenant scope (orgId + isSuperAdmin) so deployVersion's reads/writes
    // against the FORCE-RLS plugins table see the caller's org — the factory routes get
    // this via createProtectedRoute, but this route hand-wires its chain.
    withTenantContext() as RequestHandler,
    // Declares the audit action the handler emits below (route-coverage contract).
    audited('plugin.upload') as RequestHandler,
    // `plugins:write` holders may upload (gated above). Visibility is resolved by
    // `resolveVisibility` below: unspecified → `org`; `public` needs
    // plugins:publish and is clamped to `org` otherwise. The `plugins` quota is
    // reserved inside the handler (atomic check+increment) so two concurrent
    // uploads at the limit can't both succeed. The slot is given back via
    // `decrementQuota` on any failure path, including build worker permanent
    // failures.
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const registry = Config.get('registry');
      // Service-minted auth for downstream calls (compliance, quota). The
      // caller's bearer token may carry only end-user scopes that won't pass
      // service-to-service authorization checks; mint a service token instead.
      const authHeader = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });

      const logWarn = ctx.log.bind(null, 'WARN');

      try {
        // Pinned to a const: the narrowing from this guard does not survive
        // into the reservation callback below (TS widens property accesses read
        // inside a closure).
        const uploadedFile = req.file;
        if (!uploadedFile) {
          return sendBadRequest(res, 'No plugin file uploaded', ErrorCode.MISSING_REQUIRED_FIELD);
        }

        const validation = validateBody(req, PluginUploadBodySchema);
        if (!validation.ok) {
          return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
        }
        // Defaults to `org` like pipelines — an uploaded plugin is a team asset.
        const visibility = resolveVisibility(req, validation.value.visibility, 'plugins:publish', 'org');

        // Catalog edits (docs/plugin-publishing.md): the optional `metadata`
        // part carries the user's accept-or-edit result; absent ⇒ every
        // detected value is accepted (scripts, the Official loader). Contract
        // keys are refused by name. Checked before the quota slot is reserved.
        const edits = parseCatalogEditsPart(validation.value.metadata);
        if (!edits.ok) return sendBadRequest(res, edits.error, ErrorCode.VALIDATION_ERROR);

        // `publishRequest=true` submits a publish request once the version is
        // deployed. A request needs a `public` version and the right to request
        // publishing — checked up front, not discovered after the build.
        const publishRequest = validation.value.publishRequest === 'true';
        if (publishRequest) {
          if (!userHasPermission(req, 'plugins:publish')) {
            return sendError(res, 403, 'publishRequest needs plugins:publish', ErrorCode.INSUFFICIENT_PERMISSIONS);
          }
          if (visibility !== 'public') {
            return sendBadRequest(res, 'publishRequest needs visibility=public', ErrorCode.VALIDATION_ERROR);
          }
        }
        const publish = publishRequest ? { caller: callerFromRequest(req) } : undefined;

        // Reserve the plugins quota slot. Done AFTER multer + body validation
        // so a bad-request never consumes quota. The quota service's atomic
        // reserve means two concurrent uploads at the limit can't both pass.
        //
        // The shared guard owns the slot for the whole body: an unexpected
        // throw (parsePluginZip, deployVersion, …) refunds it automatically,
        // and `markConsumed()` at the hand-off point stops that refund once
        // the queued build job owns the slot instead.
        const outcome = await withQuotaReservation(
          { quotaService, orgId, type: 'plugins', serviceName: 'plugin', logWarn },
          async (slot: QuotaSlot) => {
            const zipPath = uploadedFile.path;
            ctx.log('INFO', 'Upload received', {
              originalName: uploadedFile.originalname,
              sizeBytes: uploadedFile.size,
              visibility,
            });

            // -- Parse & validate ZIP ---------------------------------------------
            const plugin = await parsePluginZip(zipPath);
            validateBuildArgs(plugin.pluginSpec.buildArgs);
            const catalog = catalogColumns(resolveCatalogMetadata(detectCatalogMetadata(catalogInputs(plugin)), edits.value));
            const s = plugin.pluginSpec;
            const version = s.version || DEFAULT_PLUGIN_VERSION;

            ctx.log('INFO', 'Spec validated', { pluginName: s.name, version });

            // Refuse up front (before compliance, S3 staging and an image build) a
            // re-upload that would overwrite a version the caller can't write or
            // un-delete a tombstone. Throws a typed 403/409; the catch below refunds
            // the slot. deployVersion re-checks under its lock.
            const access = { isSystemAdmin: isSystemAdmin(req), canPublish: userHasPermission(req, 'plugins:publish') };
            await pluginService.assertDeployable(orgId, s.name, version, userId || SYSTEM_ACTOR_ID, access);

            // -- Compliance check (fail-closed) -----------------------------------
            const preflight = await compliancePreflight(orgId, authHeader, {
              attributes: {
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
                visibility,
                secrets: s.secrets,
                metadata: s.metadata,
              },
              buildType: plugin.buildType,
              pluginType: s.pluginType ?? 'CodeBuildStep',
              keywords: catalog.keywords,
              action: 'upload',
            });
            if (preflight.status === 'blocked') {
              ctx.log('WARN', 'Plugin upload blocked by compliance', { pluginName: s.name, violations: preflight.violations.length });
              slot.refund();
              return sendError(res, 403, 'Plugin upload blocked by compliance rules', ErrorCode.COMPLIANCE_VIOLATION, {
                violations: preflight.violations,
              });
            }
            if (preflight.status === 'unavailable') {
              ctx.log('ERROR', 'Compliance service unavailable', { error: preflight.error });
              slot.refund();
              return sendError(res, 503, 'Compliance service unavailable  plugin upload rejected', ErrorCode.COMPLIANCE_SERVICE_UNAVAILABLE);
            }
            if (preflight.warnings > 0) {
              ctx.log('WARN', 'Compliance warnings on plugin upload', { pluginName: s.name, warnings: preflight.warnings });
            }

            // -- Build plugin record --------------------------------------------------
            const pluginRecord = {
              orgId,
              name: s.name,
              version,
              metadata: (s.metadata || {}) as Record<string, string | number | boolean>,
              pluginType: s.pluginType || 'CodeBuildStep',
              computeType: s.computeType || 'SMALL',
              primaryOutputDirectory: s.primaryOutputDirectory || null,
              dockerfile: plugin.dockerfileContent,
              env: s.env || {},
              buildArgs: s.buildArgs || {},
              installCommands: s.installCommands || [],
              commands: s.commands || [],
              visibility,
              timeout: s.timeout ?? null,
              failureBehavior: s.failureBehavior || 'fail',
              secrets: s.secrets || [],
              buildType: plugin.buildType,
              // Execution contract: spec-only, persisted, never editable.
              ...specContractFields(s),
              // Catalog metadata: detected, then accepted or edited, with
              // per-field provenance.
              ...catalog,
              // The quota period this upload's slot was charged to, so a later
              // delete/purge can refund it conditionally (never into a new period).
              quotaResetAt: slot.reservation.quota.resetAt ?? null,
            };

            // -- No image to build (metadata_only): deploy directly ----------------
            if (!getBuildStrategy(plugin.buildType).producesImage) {
              const result = await pluginService.deployVersion(toPluginInsert(pluginRecord), userId || SYSTEM_ACTOR_ID, access);

              ctx.log('INFO', 'Metadata-only plugin deployed', {
                pluginName: s.name,
                pluginId: result.id,
              });
              const publishOutcome = publish ? await submitAfterBuild(publish.caller, result.id) : undefined;

              // Best-effort attributed audit — the source upload landed (deployed
              // directly, no image build), so we have the persisted plugin id.
              recordAudit({
                action: 'plugin.upload',
                actorId: actorId({ userId }),
                orgId,
                targetType: 'plugin',
                targetId: result.id,
                details: {
                  pluginName: s.name,
                  version: s.version,
                  visibility,
                  buildType: 'metadata_only',
                },
              });

              return sendSuccess(res, 201, {
                requestId: ctx.requestId,
                pluginId: result.id,
                pluginName: s.name,
                version: s.version,
                buildType: 'metadata_only',
                ...(publishOutcome ? { publishRequest: publishOutcome } : {}),
              });
            }

            // -- Stage the build context in object storage ------------------------
            // The upload + build workers run on every replica and BullMQ may route
            // the build to a DIFFERENT replica than this one; `contextDir` is per-pod
            // local scratch, so stage the raw ZIP in S3 (MinIO) FIRST. A worker
            // elsewhere re-materializes the context from this key; the local
            // extractDir remains the same-replica fast path. Fail the upload if
            // staging fails — a build we can't reconstruct must never be queued.
            const s3Key = pluginArtifactKey(orgId, ctx.requestId);
            try {
              await putPluginArtifact(s3Key, await fs.promises.readFile(zipPath));
            } catch (s3Err) {
              ctx.log('ERROR', 'Failed to stage build context in object storage', { error: errorMessage(s3Err) });
              slot.refund();
              return sendError(res, 503, 'Object storage unavailable  please retry', ErrorCode.SERVICE_UNAVAILABLE);
            }

            // -- Queue build job (returns immediately) ----------------------------
            const jobData = createBuildJobData({
              requestId: ctx.requestId,
              orgId,
              userId: userId || SYSTEM_ACTOR_ID,
              access,
              // Period snapshot for the reserved slot so a DLQ retry spanning a
              // quota reset refunds the correct period (see releasePluginQuota).
              reservedResetAt: slot.reservation.quota.resetAt,
              ...(publish ? { publish } : {}),
              buildRequest: {
                contextDir: plugin.extractDir,
                s3Key,
                dockerfile: plugin.dockerfile,
                name: s.name,
                version,
                orgId,
                registry,
                buildArgs: s.buildArgs || {},
                buildType: plugin.buildType,
              },
              pluginRecord,
            });

            try {
              await queuePluginBuild({ quotaService, sseManager, orgId, authHeader, jobName: `${s.name}:${version}`, jobData, logWarn });
            } catch (queueErr) {
              ctx.log('ERROR', 'Failed to enqueue build job', {
                error: errorMessage(queueErr),
              });
              slot.refund();
              // The build won't run — drop the staged context so it doesn't orphan
              // (best-effort; the bucket's expiry lifecycle is the backstop).
              await deletePluginArtifact(s3Key);
              return sendError(res, 503, 'Build queue unavailable  please retry', ErrorCode.SERVICE_UNAVAILABLE);
            }
            // Queued: the build worker owns the slot now (it refunds on permanent failure).
            slot.markConsumed();

            ctx.log('INFO', 'Build queued', { pluginName: s.name, version });

            // Best-effort attributed audit — the source upload was accepted and the
            // build queued. No plugin id exists yet (the worker persists the record
            // on build completion, where plugin.build.completed carries the id), so
            // `targetId` is omitted here; name/version identify the artifact.
            recordAudit({
              action: 'plugin.upload',
              actorId: actorId({ userId }),
              orgId,
              targetType: 'plugin',
              details: {
                pluginName: s.name,
                version,
                visibility,
                buildType: plugin.buildType,
              },
            });

            return sendSuccess(res, 202, {
              requestId: ctx.requestId,
              pluginName: s.name,
              version,
            }, 'Plugin build queued');
          },
        );
        if (outcome.status === 'denied') {
          const { reservation } = outcome;
          ctx.log('WARN', reservation.unavailable ? 'Plugin quota unconfirmable (quota service unavailable)' : 'Plugin quota exceeded', { orgId, used: reservation.quota.used, limit: reservation.quota.limit });
          // 503 + Retry-After when the quota service couldn't confirm; 429 when over limit.
          return sendQuotaReserveDenied(res, 'plugins', reservation);
        }
      } finally {
        // Remove the uploaded temp ZIP on EVERY outcome — early returns (bad
        // body, quota denied, compliance block) included, not only once the
        // handler got as far as parsing it. The extract dir belongs to the build
        // worker, which cleans it up.
        cleanupUploadFile(req);
      }
    }),
  );

  // POST /plugins/inspect — DRY-RUN parse of a plugin zip: every
  // descriptive catalog field with its detected value, source and validation
  // error, for the upload dialog's "Catalog details" step (and the CLI).
  // Same chain and zip bounds as the upload (auth, orgId, plugins:write, a
  // per-org rate limit, then multer); builds nothing, reserves no quota and
  // stores nothing — the extracted files are removed before responding.
  router.post('/inspect',
    requireAuth as RequestHandler,
    requireOrgId() as RequestHandler,
    requirePermission('plugins:write') as RequestHandler,
    rateLimitByOrg({ name: 'plugin-inspect', max: 30, windowMs: 60_000, message: 'Too many plugin inspections, please slow down.' }) as RequestHandler,
    upload.single('plugin') as RequestHandler,
    ((err, req, res, next) => {
      if (err) {
        cleanupUploadFile(req as Request);
        sendError(res, 400, `File upload failed: ${err.message}`, ErrorCode.VALIDATION_ERROR);
        return;
      }
      next();
    }) as ErrorRequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      let extractDir: string | null = null;
      try {
        if (!req.file) return sendBadRequest(res, 'No plugin file uploaded', ErrorCode.MISSING_REQUIRED_FIELD);
        const plugin = await parsePluginZip(req.file.path);
        extractDir = plugin.extractDir;
        const fields = detectCatalogMetadata(catalogInputs(plugin));
        ctx.log('COMPLETED', 'Plugin inspected', {
          pluginName: plugin.pluginSpec.name,
          version: plugin.pluginSpec.version,
          invalid: fields.filter((f) => f.error).map((f) => f.field),
        });
        return sendSuccess(res, 200, {
          plugin: {
            name: plugin.pluginSpec.name,
            version: plugin.pluginSpec.version,
            pluginType: plugin.pluginSpec.pluginType ?? 'CodeBuildStep',
            buildType: plugin.buildType,
          },
          fields,
        });
      } finally {
        cleanupUploadFile(req);
        if (extractDir) await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  return router;
}
