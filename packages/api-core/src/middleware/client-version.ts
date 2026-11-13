// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode } from '../types/error-codes.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { sendError } from '../utils/response.js';
import { compareSemver, isSemver } from '../utils/semver.js';

/** Sent by pipeline-manager on every platform call: its own version. */
export const CLIENT_VERSION_HEADER = 'X-Pb-Client-Version';
/** Answered on every response to a versioned client while a minimum is set. */
export const MIN_CLIENT_VERSION_HEADER = 'X-Pb-Min-Client-Version';
/** Requests per CLI version — what is still in use before raising the minimum. */
export const CLIENT_REQUESTS_METRIC = 'pipeline_manager_requests_total';
/** 426s answered — raising the minimum shows as a visible spike, not silent failures. */
export const CLIENT_UPGRADE_REQUIRED_METRIC = 'pipeline_manager_upgrade_required_total';

/**
 * A CodeBuild step (pipeline-manager forwards `X-CodeBuild-Build-Id` there) runs
 * the CLI baked into a plugin image: it can't `--upgrade` itself, so refusing
 * it would break every org's pipelines until their images were rebuilt.
 * Counted (`caller="ci"`), never refused. The header is caller-set, so this is
 * no weaker than the gate already is — a compatibility gate, NOT a security
 * control (a CLI can omit or overstate its version; a vulnerable version is
 * shut out by revoking tokens, never by this).
 */
export const CI_CALLER_HEADER = 'X-CodeBuild-Build-Id';

/** Distinct `version` label values one process will emit before folding the rest into `other`. */
export const MAX_VERSION_LABELS = 64;
const seenVersions = new Set<string>();

/** `x.y.z` of a version (prerelease / build dropped). */
export function versionLabel(v: string): string {
  return v.replace(/^v/, '').split(/[-+]/, 1)[0]!;
}

/**
 * The `version` label for a request. The gate runs BEFORE auth, so the header
 * is attacker-controlled: past {@link MAX_VERSION_LABELS} distinct values a
 * new one counts as `other`, keeping Prometheus cardinality bounded.
 */
function boundedVersionLabel(v: string): string {
  const label = versionLabel(v);
  if (seenVersions.has(label)) return label;
  if (seenVersions.size >= MAX_VERSION_LABELS) return 'other';
  seenVersions.add(label);
  return label;
}

/** @internal Test-only: forget the seen version labels. */
export function _resetVersionLabelsForTests(): void {
  seenVersions.clear();
}

/**
 * The CLI version a request CLAIMS (`X-Pb-Client-Version`), or undefined when
 * absent / not a semver. Caller-set and unverified: fit for display and
 * compatibility ("which CLI does this key still use"), never for a decision
 * about access.
 */
export function clientVersionOf(req: Pick<Request, 'headers'>): string | undefined {
  const raw = req.headers?.[CLIENT_VERSION_HEADER.toLowerCase()];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return v && isSemver(v) ? v : undefined;
}

/**
 * Refuse a pipeline-manager CLI older than `PIPELINE_MANAGER_MIN_VERSION`
 * with 426 `CLIENT_UPGRADE_REQUIRED`, so an API change surfaces as "run
 * `pipeline-manager --upgrade`" rather than as a confusing 400 or a silently
 * misread response.
 *
 * - Unset / blank minimum: nothing is refused (the default); versions are still counted.
 * - A request WITHOUT the version header passes: browsers, other clients and
 *   CLIs released before the header existed are not identified, so they are
 *   not gated. Forward-only, by design.
 * - A CI caller (CodeBuild) is counted but never refused — see {@link CI_CALLER_HEADER}.
 * - A malformed header value passes too (nothing to compare), but a malformed
 *   MINIMUM throws at startup: a typo must not silently disable the gate.
 */
export function clientVersionGate(minVersion: string | undefined = process.env.PIPELINE_MANAGER_MIN_VERSION): RequestHandler {
  const min = minVersion?.trim() || undefined;
  if (min && !isSemver(min)) throw new Error(`PIPELINE_MANAGER_MIN_VERSION is not a semver version: ${min}`);

  // Counted whether or not a minimum is set: the version mix is what an
  // operator needs BEFORE choosing one.
  return (req: Request, res: Response, next: NextFunction) => {
    const sent = req.get(CLIENT_VERSION_HEADER)?.trim();
    if (!sent || !isSemver(sent)) return next();
    const version = boundedVersionLabel(sent);
    const caller = req.get(CI_CALLER_HEADER) ? 'ci' : 'interactive';
    emitCounter(CLIENT_REQUESTS_METRIC, { version, caller });
    if (!min) return next();
    res.setHeader(MIN_CLIENT_VERSION_HEADER, min);
    if (compareSemver(sent, min) >= 0 || caller === 'ci') return next();
    emitCounter(CLIENT_UPGRADE_REQUIRED_METRIC, { version, min: versionLabel(min) });
    sendError(
      res,
      426,
      `pipeline-manager ${sent} is no longer supported by this platform (minimum ${min}); run: pipeline-manager --upgrade`,
      ErrorCode.CLIENT_UPGRADE_REQUIRED,
      { minVersion: min, clientVersion: sent },
    );
  };
}
