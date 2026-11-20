// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints pipeline SERVES (api-core
 * `PIPELINE_INTERNAL`): each is mounted at its contract's method + path with the
 * contract's callers, and a sample request/response round-trips its schemas.
 * The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { PIPELINE_INTERNAL, buildRouteTable, internalContractsServedBy, type RouteTableEntry } from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';

const SAMPLES: Record<keyof typeof PIPELINE_INTERNAL, ContractSample> = {
  purgeOrg: { params: { orgId: 'org-1' }, response: { orgId: 'org-1', tables: { pipelines: 2 } } },
  reencryptRunnerSigningKeys: {
    params: {},
    body: { orgId: '0123456789abcdef01234567', previousKmsConfig: { keyId: 'arn:aws:kms:us-east-1:000000000000:key/k', ciphertextBase64: 'AAAA' } },
    response: { scanned: 2, reencrypted: 1, failures: [{ orgId: '0123456789abcdef01234567', kid: 'kid-1', error: 'decrypt failed' }] },
  },
  startRemediationRollout: {
    params: { remediationId: '00000000-0000-4000-8000-0000000000a1' },
    body: {
      orgId: '0123456789abcdef01234567',
      plugin: 'trivy',
      publisher: null,
      fromVersion: '1.4.2',
      toVersion: '1.4.3',
      toPluginId: '00000000-0000-4000-8000-0000000000b1',
      advisoryIds: ['CVE-2026-0001'],
      criticalCleared: 1,
      highCleared: 0,
      kev: false,
    },
    response: {
      remediationId: '00000000-0000-4000-8000-0000000000a1',
      created: true,
      orgDefault: 'propose',
      counts: {
        proposed: 2,
        change_requested: 0,
        queued: 0,
        moved: 0,
        failed: 0,
        rolled_back: 0,
        rollback_blocked: 0,
        skipped_opt_out: 1,
        skipped_runner: 0,
        dismissed: 0,
        superseded: 0,
        waiting_change_request: 0,
        moved_pending_redeploy: 0,
      },
    },
  },
  cancelRemediationRollout: {
    params: { remediationId: '00000000-0000-4000-8000-0000000000a1' },
    body: { reason: 'version_deleted' },
    response: { remediationId: '00000000-0000-4000-8000-0000000000a1', cancelled: true },
  },
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { createQuotaService }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  const { app } = createApp({ enableOpenApi: false });
  mountRoutes(app, { quotaService: createQuotaService() });
  table = buildRouteTable(app);
});

describe('pipeline internal endpoint contracts', () => {
  it('has a sample for every contract pipeline serves', () => {
    expect(internalContractsServedBy('pipeline').map((c) => c.id).sort())
      .toEqual(Object.values(PIPELINE_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(PIPELINE_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    expect(() => roundTripContractSample(contract, SAMPLES[name as keyof typeof PIPELINE_INTERNAL])).not.toThrow();
  });

  it('refuses a purge with no org id (the route answers 400, never a purge of everything)', () => {
    expect(PIPELINE_INTERNAL.purgeOrg.params.safeParse({ orgId: '' }).success).toBe(false);
  });
});
