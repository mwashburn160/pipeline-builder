// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendBadRequest,
  sendError,
  sendEntityNotFound,
  ErrorCode,
  getParam,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { type Router } from 'express';
import {
  headBlob,
  getBlobStream,
  isNotFound,
} from '../../services/registry-client.js';

// 5 MB cap for the blob proxy. The endpoint is for previewing config blobs
// in the registry UI's manifest summary — config blobs are always small
// (typically < 50 KB). Larger payloads (layer blobs, attestations) are
// rejected with 413 so the platform can't OOM serving a multi-GB layer.
// Override via `REGISTRY_MAX_BLOB_PROXY_BYTES`.
const MAX_BLOB_PROXY_BYTES = parseInt(process.env.REGISTRY_MAX_BLOB_PROXY_BYTES || String(5 * 1024 * 1024), 10);

/**
 * Register the blob proxy route:
 *  - GET /:name/blobs/:digest (5MB cap; config blobs only, streamed)
 */
export function registerBlobRoutes(router: Router): void {
  // GET /api/images/:name/blobs/:digest — proxy a config blob (5MB cap, streamed).
  router.get('/:name/blobs/:digest', withRoute(async ({ req, res, ctx }) => {
    const name = getParam(req.params, 'name');
    const digest = getParam(req.params, 'digest');
    if (!name || !digest) return sendBadRequest(res, 'name and digest are required', ErrorCode.MISSING_REQUIRED_FIELD);

    // Fast path: HEAD first to reject oversize before opening the stream.
    // Fail closed when the upstream omits Content-Length — without a known
    // size we can't preflight the cap, and serving an unbounded body via
    // this proxy endpoint is what the cap is meant to prevent. Defensive:
    // each `return sendEntityNotFound(...)` / `return sendError(...)` exits
    // the route handler before any `stream.on(...)` registration below, so
    // there's no risk of double-responding for a 404/502 path.
    try {
      const head = await headBlob(name, digest);
      if (head.contentLength === undefined) {
        return sendError(
          res, 502,
          'Upstream registry omitted Content-Length on blob HEAD; refusing to stream uncapped.',
          ErrorCode.INTERNAL_ERROR,
        );
      }
      if (head.contentLength > MAX_BLOB_PROXY_BYTES) {
        return sendError(
          res, 413,
          'Blob exceeds 5MB cap. This endpoint serves config blobs only; layer blobs are not previewable.',
          ErrorCode.PAYLOAD_TOO_LARGE,
        );
      }
    } catch (err) {
      if (isNotFound(err)) return sendEntityNotFound(res, 'Blob');
      throw err;
    }

    // Stream the body. If the registry omitted Content-Length on the GET
    // (unlikely after a successful HEAD with it set), byte-count the
    // stream and abort on overrun.
    let stream;
    try {
      const got = await getBlobStream(name, digest);
      stream = got.stream;
      res.setHeader('Content-Type', got.contentType);
      if (got.contentLength !== undefined) {
        res.setHeader('Content-Length', String(got.contentLength));
      }
    } catch (err) {
      if (isNotFound(err)) return sendEntityNotFound(res, 'Blob');
      throw err;
    }

    let bytes = 0;
    let aborted = false;
    const abort = (statusCode: number, message: string) => {
      if (aborted) return;
      aborted = true;
      stream.destroy();
      if (!res.headersSent) {
        sendError(res, statusCode, message, ErrorCode.PAYLOAD_TOO_LARGE);
      } else {
        res.end();
      }
    };

    // Release the upstream connection if the client navigates away.
    req.on('close', () => { if (!res.writableEnded) stream.destroy(); });

    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BLOB_PROXY_BYTES) {
        abort(413, 'Blob exceeds 5MB cap. This endpoint serves config blobs only; layer blobs are not previewable.');
      }
    });
    stream.on('error', (err: Error) => {
      if (aborted) return;
      aborted = true;
      ctx.log('ERROR', 'Blob stream error', { name, digest, error: err.message });
      if (!res.headersSent) sendError(res, 502, 'Upstream registry error', ErrorCode.INTERNAL_ERROR);
      else res.end();
    });
    stream.on('end', () => {
      if (!aborted) {
        ctx.log('COMPLETED', 'Streamed blob', { name, digest, bytes });
      }
    });
    stream.pipe(res);
  }));
}
