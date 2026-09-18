// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /.well-known/jwks.json` — the public key set every verifier in the fleet
 * (plus the pipeline-manager CLI, image-registry's auth resolver and the
 * pipeline-events Lambda) checks user tokens against.
 *
 * Unauthenticated and cacheable BY DESIGN: requiring a credential to fetch the
 * keys that verify credentials would be a bootstrap cycle. It carries no tenant
 * data — only the public halves of platform's signing keys.
 *
 * Mounted from `index.ts` next to the health probes rather than through
 * `routes/mount.ts`: it is infrastructure, not API surface. It must answer
 * BEFORE auth is possible (it is what makes auth possible) and must keep serving
 * while Mongo is cold, so it sits ahead of the readiness guard, which allowlists
 * this path. Both consequences are deliberate — a platform database blip must
 * not stop every other service from verifying tokens.
 */

import { JWKS_PATH, createLogger, sendError } from '@pipeline-builder/api-core';
import { Router, type Request, type Response } from 'express';
import { publishedJwks } from '../services/token-signing/index.js';

const logger = createLogger('jwks-route');
const router = Router();

/**
 * How long the document may be cached downstream. Matches the verifiers' own
 * 10-minute refresh; a rotated-in key is still picked up immediately, because a
 * verifier refetches on an unknown `kid` rather than waiting for the interval.
 */
const CACHE_SECONDS = 600;

/** Exported so the suite can drive it without standing up an HTTP server. */
export async function jwksHandler(_req: Request, res: Response): Promise<void> {
  try {
    const jwks = await publishedJwks();
    res.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
    res.json(jwks);
  } catch (error) {
    // Serving an empty or partial key set would make every verifier reject every
    // token as an unknown `kid` — a 503 tells them to retry instead.
    logger.error('Failed to publish JWKS', { error });
    sendError(res, 503, 'Signing keys are not available', 'SERVICE_UNAVAILABLE');
  }
}

router.get(JWKS_PATH, jwksHandler);

export default router;
