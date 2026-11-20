// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly toolchain FIXES — the system org's decisions on a toolchain release
 * candidate (docs/plugin-publishing.md "Remediation → toolchains"), the API of
 * the "Toolchain fixes" card in the Toolchain console. Mounted at `/plugins`
 * behind the shared auth + org chain, before the read routes (`/:id`).
 *
 * Gate: the system-org check plus `plugins:write` on every route — the same
 * gate as the Official patch export (`plugins:write` is not a system-org-only
 * permission, so requireSystemOrgPermission cannot take it). The two decisions
 * also step up (always on) and are audited:
 *
 *   GET  /plugins/toolchain-fixes               the candidates, newest first, and the knobs
 *   POST /plugins/toolchain-fixes/:id/approve   publish the release (both halves) + N34      toolchain.fix.approved
 *   POST /plugins/toolchain-fixes/:id/reject    discard it                                    toolchain.fix.rejected
 *   GET  /plugins/toolchain-fixes/:id/export    the deploy/toolchain/** spec patch (text/x-diff) for the release workflow
 *
 * Approval never changes an org's toolchain default or the platform default:
 * orgs move through their own default (Settings → Organization → Pipeline
 * toolchain), the platform default through the console's promotion.
 */

import {
  attachmentDisposition,
  audited,
  ErrorCode,
  PluginRemediationDecisionSchema,
  requirePermission,
  requireStepUp,
  requireSystemOrg,
  sendSuccess,
} from '@pipeline-builder/api-core';
import type { PluginRemediation } from '@pipeline-builder/pipeline-data';
import { Router, type RequestHandler } from 'express';

import { bodyFrom, ecosystemRoute, param } from './ecosystem-route.js';
import { remediationConfig } from '../config.js';
import { EcosystemError } from '../services/ecosystem/context.js';
import { readRemediationArtifact } from '../services/remediation/artifacts.js';
import type { ToolchainInputsStore } from '../services/remediation/toolchain-inputs.js';
import {
  approveToolchainFix, getToolchainFix, listToolchainFixes, rejectToolchainFix, toToolchainFixDto, type ToolchainPorts,
} from '../services/remediation/toolchain.js';

export interface ToolchainFixRouteOptions {
  /** The registry ports (re-scan on approve, discard on reject); default: the live ones. */
  ports?: () => Promise<ToolchainPorts>;
  inputs?: ToolchainInputsStore;
  /** Reads a stored artifact (the spec patch). */
  readArtifact?: (key: string) => Promise<string | null>;
}

const livePorts = async (): Promise<ToolchainPorts> => (await import('../services/remediation/tooling.js')).liveToolchainPorts();

const notFound = (): EcosystemError => new EcosystemError(ErrorCode.NOT_FOUND, 'Toolchain fix not found');

export function createToolchainFixRoutes(opts: ToolchainFixRouteOptions = {}): Router {
  const router = Router();
  const gate = [requireSystemOrg as RequestHandler, requirePermission('plugins:write') as RequestHandler];
  const stepUp = requireStepUp as RequestHandler;
  const ports = opts.ports ?? livePorts;
  const readArtifact = opts.readArtifact ?? readRemediationArtifact;
  const deps = async () => ({ ports: await ports(), ...(opts.inputs ? { inputs: opts.inputs } : {}) });

  const fixOf = async (id: string): Promise<PluginRemediation> => {
    const row = await getToolchainFix(id);
    if (!row) throw notFound();
    return row;
  };

  router.get('/toolchain-fixes', ...gate, ecosystemRoute(async ({ res }) => {
    const cfg = remediationConfig();
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, 200, { fixes: (await listToolchainFixes()).map(toToolchainFixDto), enabled: cfg.enabled, mode: cfg.toolchains });
  }));

  router.post('/toolchain-fixes/:id/approve', ...gate, stepUp, audited('toolchain.fix.approved') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const { reason } = bodyFrom(req, PluginRemediationDecisionSchema);
    const row = await fixOf(param(req, 'id'));
    const done = await approveToolchainFix(row, caller.userId, reason ?? null, await deps());
    sendSuccess(res, 200, toToolchainFixDto(done));
  }));

  router.post('/toolchain-fixes/:id/reject', ...gate, stepUp, audited('toolchain.fix.rejected') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const { reason } = bodyFrom(req, PluginRemediationDecisionSchema);
    const row = await fixOf(param(req, 'id'));
    const done = await rejectToolchainFix(row, caller.userId, reason ?? null, await deps());
    sendSuccess(res, 200, toToolchainFixDto(done));
  }));

  router.get('/toolchain-fixes/:id/export', ...gate, ecosystemRoute(async ({ req, res }) => {
    const row = await fixOf(param(req, 'id'));
    const body = row.exportKey ? await readArtifact(row.exportKey) : null;
    if (body === null) throw new EcosystemError(ErrorCode.NOT_FOUND, 'This toolchain fix has no stored spec patch');
    const to = row.toolchainCandidate?.toRelease ?? row.fromVersion;
    res.setHeader('Content-Type', 'text/x-diff; charset=utf-8');
    res.setHeader('Content-Disposition', attachmentDisposition(`toolchain-${to}-spec.diff`));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(body);
  }));

  return router;
}
