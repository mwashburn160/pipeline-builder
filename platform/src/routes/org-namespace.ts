// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin route for the per-org k8s namespace render endpoint.
 *
 * Mounted at `/admin/orgs/:orgId/k8s-namespace.yaml`. The render-only
 * design means the platform never holds cluster-write credentials —
 * operators pipe the response to `kubectl apply -f -`.
 */

import { Router } from 'express';
import { renderOrgNamespace } from '../controllers/org-namespace';
import { requireAuth, requireStepUp } from '../middleware';

const router = Router({ mergeParams: true });

// YAML pins service-account tokens / namespace labels — sensitive enough
// to warrant step-up. Operators run this rarely (one-time per-org
// provisioning), so the prompt cost is acceptable.
router.get('/', requireAuth, requireStepUp, renderOrgNamespace);

export default router;
