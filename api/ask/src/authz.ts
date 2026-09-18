// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requirePermission } from '@pipeline-builder/api-core';

/**
 * Capability gate for every `/ask` route.
 *
 * There is no `ask:*` capability — Ask is not a resource of its own but a
 * read-only assistant OVER the build catalogs: it answers how-to questions
 * about them and drafts pipelines / plugins / templates the user then confirms
 * elsewhere. So the gate is any-of the three catalog READ capabilities (all
 * three are in the built-in Member bundle); a custom role that can't read any
 * of them has nothing to ask the assistant about.
 *
 * It composes with, and does not replace, the other two controls on these
 * routes: `requireFeature('ai_generation')` (the plan entitlement that governs
 * LLM spend) and the agent tools' own downstream authorization — every tool
 * calls pipeline/plugin as the USER, with their forwarded bearer token, so the
 * owning service re-checks the caller's permissions on each read.
 */
export const requireAskAccess = requirePermission('pipelines:read', 'plugins:read', 'templates:read');
