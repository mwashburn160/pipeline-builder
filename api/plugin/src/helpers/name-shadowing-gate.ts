// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, actorId, createLogger, recordAudit, sendError } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { callerFromRequest } from '../services/ecosystem/context.js';
import { shadowingDecision } from '../services/ecosystem/installs.js';

const logger = createLogger('name-shadowing-gate');

/**
 * The ONE pre-build name-shadowing gate, shared by every route that creates a
 * plugin version from a caller-chosen name (ZIP upload, AI-generated deploy).
 *
 * A new plugin name may OVERRIDE something the org already resolves: a listing
 * from any publisher, or (for a team) its parent org's plugin. An unqualified
 * reference then picks this one, so every pipeline naming it changes behaviour
 * while its config is untouched — and the Official catalog is where `trivy`,
 * `snyk-*`, `gitleaks` and `semgrep` live.
 *
 * The org's consumption policy (`shadowing` on the plugin install policy)
 * decides:
 *  - `deny`  refuses with 409 PLUGIN_NAME_SHADOWS and audits
 *            `plugin.shadowing.denied` — call this before compliance, staging and
 *            the image build so nothing is spent on a version that cannot land;
 *  - `warn`  proceeds and logs an operator-visible line;
 *  - `allow` proceeds silently.
 *
 * Best-effort evaluation: if the decision cannot be reached the version
 * PROCEEDS. Refusing on an infrastructure failure would turn a listing read
 * into an outage for every upload, and the shadow is still reported by
 * GET /plugins/shadowing afterwards.
 *
 * Returns the names it shadows (for the caller's own audit detail —
 * `undefined` means "not established", because the evaluation failed), or
 * `refused: true` once it has SENT the 409; the caller must then release
 * whatever it reserved (the `plugins` quota slot) and return.
 */
export async function enforceNameShadowingPolicy(
  req: Request,
  res: Response,
  opts: { orgId: string; userId?: string; name: string; version: string },
): Promise<{ refused: true } | { refused: false; shadows: string[] | undefined }> {
  let decision: Awaited<ReturnType<typeof shadowingDecision>> | null;
  try {
    decision = await shadowingDecision(callerFromRequest(req), opts.name);
  } catch {
    decision = null;
  }
  if (!decision) return { refused: false, shadows: undefined };
  if (decision.shadows.length === 0) return { refused: false, shadows: [] };
  if (decision.mode === 'deny') {
    recordAudit({
      action: 'plugin.shadowing.denied',
      actorId: actorId({ userId: opts.userId }),
      orgId: opts.orgId,
      targetType: 'plugin',
      details: { pluginName: opts.name, version: opts.version, shadows: decision.shadows },
    });
    sendError(
      res, 409,
      `Plugin name "${opts.name}" would override ${decision.shadows.join(', ')}, and this organization's plugin policy refuses that. `
      + 'Rename the plugin, or change the Name shadowing setting in the plugin install policy.',
      ErrorCode.PLUGIN_NAME_SHADOWS,
      { shadows: decision.shadows },
    );
    return { refused: true };
  }
  // `warn` is what separates a deliberate override from an unnoticed one: the
  // version proceeds, but it leaves an operator-visible line. `allow` is silent
  // by choice, for an org that overrides listings as a matter of course.
  if (decision.mode === 'warn') {
    logger.warn('Plugin name overrides something this org already resolves', {
      orgId: opts.orgId, pluginName: opts.name, version: opts.version, shadows: decision.shadows,
    });
  }
  return { refused: false, shadows: decision.shadows };
}
