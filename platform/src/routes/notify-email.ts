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
 * `plugin` (plugin-ecosystem notices — recipient rules resolved here, in-app +
 * email). An INTERNAL route: no
 * user token reaches it, and the caller's name is bound to its signing key, so
 * this cannot be driven by any other workload. The mesh policy on the Istio
 * targets names the same callers; compose has no mesh, so this gate is the
 * enforcement.
 *
 * `ask` is deliberately NOT here, though it is a caller of /status below: the
 * agent may learn WHETHER email works, never make this instance send mail to an
 * address a model (or a prompt-injected message) chose.
 */
router.post('/', requireServiceAuth, requireInternalService({ callers: ['compliance', 'plugin'] }), notifyEmail);

/**
 * GET /internal/notify-email/status — `{ enabled }`: whether this instance can
 * send email at all (EMAIL_ENABLED). Two callers, both of which need the switch
 * itself rather than the ability to send:
 *
 *  - `plugin`: its anonymous-submission API (docs/plugin-publishing.md
 *    "Submitting without an account") stays OFF unless outbound email is
 *    configured — the magic link IS the submitter's identity — so it asks here
 *    (cached 60s there; unreachable ⇒ treated as disabled, fail closed);
 *  - `ask`: `diagnose_notifications` answers "we configured notifications and
 *    nothing arrives", and a disabled send REPORTS SUCCESS (utils/email.ts), so
 *    this switch is the whole diagnosis. It read the PUBLIC `/config` before —
 *    a silent coupling that would have gone dark the day `/config` narrowed.
 *    Unreachable ⇒ reported as `unknown`, NOT as disabled: a diagnostic that
 *    guesses sends someone chasing the wrong problem.
 *
 * Reading it is strictly weaker than sending: the answer is one instance-wide
 * boolean with no tenant, recipient or provider detail in it (see
 * `notifyEmailStatus`), which is why `ask` — an agent acting for whichever
 * member is asking — may read it while it may NOT appear on the send route
 * above. Same service-only gate either way.
 */
router.get('/status', requireServiceAuth, requireInternalService({ callers: ['ask', 'plugin'] }), notifyEmailStatus);

export default router;
