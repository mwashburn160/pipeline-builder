// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints plugin SERVES (api-core
 * `PLUGIN_INTERNAL`): each is mounted at its contract's method + path with the
 * contract's callers, and a sample request/response round-trips its schemas.
 * The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { INTERNAL_CONTRACTS, PLUGIN_INTERNAL, buildRouteTable, internalContractsServedBy, type RouteTableEntry } from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-internal-contracts-'));

const DIGEST = `sha256:${'b'.repeat(64)}`;

const SAMPLES: Record<keyof typeof PLUGIN_INTERNAL, ContractSample> = {
  publicPluginNames: { query: { orgId: 'acme' }, response: { names: ['lint', 'deploy'] } },
  orgImageReferences: { query: { orgId: 'acme' }, response: { digests: [DIGEST] } },
  purgeOrg: { params: { orgId: 'acme' }, response: { orgId: 'acme', tables: { plugins: 3, plugin_installs: 1 } } },
  eraseUser: { params: { userId: 'u-1' }, response: { userId: 'u-1', reviews: 2 } },
  deployLookup: {
    params: { orgId: 'acme' },
    body: { filter: { name: 'lint' } },
    response: { plugin: { name: 'lint', version: '1.0.0' }, warnings: [] },
  },
  reportRemediationRollout: {
    params: { remediationId: '00000000-0000-4000-8000-000000000001' },
    body: {
      summary: {
        status: 'canary',
        toVersion: '1.4.3',
        waves: [],
        updatedAt: '2026-11-20T00:00:00.000Z',
        counts: { eligible: 1, proposed: 0, changeRequested: 0, moved: 0, failed: 0, rolledBack: 0, skippedOptOut: 0, skippedRunner: 0 },
      },
      events: [],
    },
    response: { remediationId: '00000000-0000-4000-8000-000000000001', stage: 'rolling_out' },
  },
  imagePipelineReferences: {
    query: { digests: `${DIGEST},${DIGEST}` },
    response: {
      references: [{
        digest: DIGEST,
        pipelineCount: 1,
        pipelines: [{ id: 'p-1', name: null, orgId: 'acme', sources: ['declared'], deleted: false }],
      }],
    },
  },
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { createQuotaService }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  const { app, sseManager } = createApp({ enableOpenApi: false, logStream: true });
  mountRoutes(app, { quotaService: createQuotaService(), sseManager });
  table = buildRouteTable(app);
});

describe('plugin internal endpoint contracts', () => {
  it('has a sample for every contract plugin serves', () => {
    expect(internalContractsServedBy('plugin').map((c) => c.id).sort())
      .toEqual(Object.values(PLUGIN_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(PLUGIN_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    expect(() => roundTripContractSample(contract, SAMPLES[name as keyof typeof PLUGIN_INTERNAL])).not.toThrow();
  });

  it('keeps the routes\' own refusal messages in the schemas', () => {
    const msg = (r: { error?: { issues: Array<{ message: string }> } }) => r.error?.issues[0]?.message;
    expect(msg(PLUGIN_INTERNAL.publicPluginNames.query!.safeParse({}))).toBe('orgId is required');
    expect(PLUGIN_INTERNAL.publicPluginNames.query!.parse({ orgId: 'ACME' })).toEqual({ orgId: 'acme' });
    const tooMany = Array.from({ length: 51 }, (_, i) => `sha256:${i.toString(16).padStart(64, '0')}`).join(',');
    expect(msg(PLUGIN_INTERNAL.imagePipelineReferences.query!.safeParse({ digests: tooMany })))
      .toBe('digests must be 1-50 comma-separated sha256 digests');
  });
});

/**
 * `POST /plugins/toolchain/initial-default` is reached by an operator shell
 * THROUGH the gateway (init-platform.sh, no mesh principal), so it is an
 * ingress route and deliberately not an internal contract: those all live
 * under `/internal`, which the gateway never routes from outside.
 */
describe('the deploy-bootstrap initial-default ingress route', () => {
  it('is served at the path init-platform.sh posts (behind the /api gateway prefix), deploy-bootstrap only', async () => {
    const { INITIAL_DEFAULT_PATH, TOOLCHAIN_MOUNT, DEPLOY_BOOTSTRAP_SERVICE } = await import('../src/routes/toolchain.js');
    const path = `${TOOLCHAIN_MOUNT}${INITIAL_DEFAULT_PATH}`;
    expect(path).toBe('/plugins/toolchain/initial-default');
    const entry = table.find((e) => e.method === 'POST' && e.path === path);
    expect(entry?.internalCallers).toEqual([DEPLOY_BOOTSTRAP_SERVICE]);
  });

  it('is not an internal contract (it is reachable through the gateway)', () => {
    expect(INTERNAL_CONTRACTS.some((c) => c.path.startsWith('/plugins/toolchain'))).toBe(false);
  });

  it('keeps the route\'s own refusal messages in its body schema', async () => {
    const { InitialToolchainDefaultBody: initial } = await import('../src/routes/toolchain.js');
    const msg = (r: { error?: { issues: Array<{ message: string }> } }) => r.error?.issues[0]?.message;
    expect(msg(initial.safeParse({ releaseVersion: 'v1.4' }))).toBe('releaseVersion must be a plain MAJOR.MINOR.PATCH release');
    expect(msg(initial.safeParse({ releaseVersion: '1.4.0', acceptVulnerabilities: ' ' }))).toBe('acceptVulnerabilities needs a reason');
    expect(initial.safeParse({ releaseVersion: '1.4.0', force: true }).success).toBe(false);
    expect(initial.parse({ releaseVersion: ' 1.4.0 ', acceptVulnerabilities: 'CVE-2026-1 has no fix yet' }))
      .toEqual({ releaseVersion: '1.4.0', acceptVulnerabilities: 'CVE-2026-1 has no fix yet' });
  });
});
