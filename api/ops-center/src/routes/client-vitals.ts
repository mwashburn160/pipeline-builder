// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /observability/client-vitals` — the browser's web-vitals and
 * error-boundary telemetry (see observability/client-vitals.ts).
 *
 * Any signed-in user may post: the samples describe the browser's experience
 * of the UI, not tenant data, so no permission applies — but an anonymous
 * caller is refused, which keeps the endpoint from being a free write into
 * Prometheus for the whole internet. Two buckets bound it: per verified user
 * (one person, many tabs) and per client IP (many accounts behind one host).
 *
 * Mounted by app-routes.ts AHEAD of the `/observability` tenant prefix, so it
 * neither meters nor checks `apiCalls`: telemetry the app sends on its own
 * must not spend a customer's API budget, and an org at its cap must still
 * report how the UI is performing for it.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/index.js';
import { clientVitalsIpLimiter, clientVitalsUserLimiter } from '../middleware/limiters.js';
import { clientVitals } from '../observability/client-vitals.js';

/** Where app-routes.ts mounts this router (the nginx `/api/observability` prefix already proxies it). */
export const CLIENT_VITALS_PATH = '/observability/client-vitals';

const router: Router = Router();

router.post('/', requireAuth, clientVitalsUserLimiter, clientVitalsIpLimiter, clientVitals);

export default router;
