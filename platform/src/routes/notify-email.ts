// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { notifyEmail, notifyEmailStatus } from '../controllers/notify-email.js';
import { requireServiceAuth } from '../middleware/index.js';

const router: Router = Router();

/**
 * POST /internal/notify-email — internal service-to-service email send.
 *
 * Two callers, because platform holds the SMTP credentials and the user
 * directory: `compliance` (its notification channels, tenant-bound) and
 * `plugin` (plugin-ecosystem notices, docs/plans/plugin-ecosystem.md §5b —
 * recipient rules resolved here, in-app + email). An INTERNAL route (#14): no
 * user token reaches it, and the caller's name is bound to its signing key, so
 * this cannot be driven by any other workload. The mesh policy on the Istio
 * targets names the same callers; compose has no mesh, so this gate is the
 * enforcement.
 */
router.post('/', requireServiceAuth, requireInternalService({ callers: ['compliance', 'plugin'] }), notifyEmail);

/**
 * GET /internal/notify-email/status — `{ enabled }`: whether this instance can
 * send email at all (EMAIL_ENABLED). The plugin service's anonymous-submission
 * API (docs/plans/plugin-ecosystem.md §4.2) stays OFF unless outbound email is
 * configured — the magic link IS the submitter's identity — so it asks here
 * (cached 60s there; unreachable ⇒ treated as disabled, fail closed). Same
 * service-only gate as the send route, plugin alone: nothing else needs it.
 */
router.get('/status', requireServiceAuth, requireInternalService({ callers: ['plugin'] }), notifyEmailStatus);

export default router;
