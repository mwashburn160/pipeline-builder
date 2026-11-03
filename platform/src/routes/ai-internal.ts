// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getOrgAIAccess, getOrgAIKey } from '../controllers/ai-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

/**
 * `/internal/ai/*` — an org's AI switch, which providers it holds its own key for, and
 * (audited) the decrypted key itself (controllers/ai-internal.ts). INTERNAL: only the
 * four services that make AI calls reach it — `ask` (Ask + the agent), `pipeline` and
 * `plugin` (generation), `reporting` (report summaries). The mesh policy on the Istio
 * targets names the same callers; compose relies on this gate alone.
 */
const aiCallers = [requireServiceAuth, requireInternalService({ callers: ['ask', 'pipeline', 'plugin', 'reporting'] })];

const router: Router = Router();

/** The org's AI switch + configured provider NAMES. */
router.get('/access/:orgId', ...aiCallers, getOrgAIAccess);

/** The org's decrypted key for one provider. Audited as `org.ai-key.read`. */
router.get('/keys/:orgId/:provider', ...aiCallers, getOrgAIKey);

export default router;
