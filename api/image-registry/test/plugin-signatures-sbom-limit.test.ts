// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SBOM SIZE ceiling on `POST /internal/plugin-signatures`.
 *
 * Its own suite because the limit is read ONCE, at module import
 * (`REGISTRY_SBOM_BODY_LIMIT`), so it cannot be varied inside the main
 * signatures suite — which deliberately proves the opposite property, that an
 * SBOM larger than the app-wide 1mb limit is accepted. Here the ceiling is set
 * low so the refusal can be exercised without sending tens of megabytes.
 *
 * What this guards: `gar-push` and `gcloud-deploy` install `google-cloud-cli`,
 * whose vendored Python tree makes an SPDX document far larger than a normal
 * image's. It went over the ceiling and body-parser answered a BARE 413 with no
 * body, so the build failed with "image-registry refused to sign (HTTP 413): no
 * detail" — nothing said the SBOM was the reason, and the operator had no knob
 * to reach for.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { jest, beforeAll, afterAll, beforeEach, describe, it, expect } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { registryClientMock } from './helpers/registry-client-mock.js';

const headManifest = jest.fn<(name: string, ref: string) => Promise<{ digest: string } | null>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ digest: string }>>();
const deleteManifest = jest.fn<(name: string, digest: string) => Promise<void>>();
jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({ headManifest, getManifest, deleteManifest }));
// The internal router also mounts the public/* publication routes; they have
// their own coverage (route-coverage + their own suite), so stub them out here.
jest.unstable_mockModule('../src/routes/internal-publications.js', () => ({
  registerPublicationRoutes: () => undefined,
  PLUGIN_PUBLICATIONS_PATH: '/plugin-publications',
}));

class PluginSigningError extends Error {}
const signPluginImage = jest.fn<(p: unknown) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/services/plugin-signing.js', () => ({
  signPluginImage,
  PluginSigningError,
}));

// The quarantine delete hook (DELETE /internal/quarantine/:submissionId) is
// exercised below against a stubbed registry-gc (its own suite covers the walk).
const deleteQuarantineRepository = jest.fn<(repo: string, reason: string) => Promise<{ repository: string; deleted: number }>>();
jest.unstable_mockModule('../src/services/registry-gc.js', () => ({
  deleteOrgNamespace: jest.fn<AnyFn>(),
  deleteQuarantineRepository,
}));

const recordAuditMock = jest.fn<AnyFn>();
const recordAuthzDenialMock = jest.fn<AnyFn>();

const mintQuarantineCredential = jest.fn<(id: string, ttl: number) => Promise<{ username: string; password: string; expiresAt: string }>>();
jest.unstable_mockModule('../src/services/quarantine-credential.js', () => ({
  mintQuarantineCredential,
  isQuarantineSubmissionId: (id: string) => /^[a-z0-9-]{1,128}$/.test(id),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
    const ctx = { log: jest.fn<AnyFn>(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx });
    } catch (err) {
      const r = res as { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void } };
      if (!r.headersSent) r.status(500).json({ success: false, message: (err as Error)?.message });
    }
  },
}));

type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: recordAuditMock,
  recordAuthzDenial: recordAuthzDenialMock,
  sendSuccess: (res: Res, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  sendBadRequest: (res: Res, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  sendError: (res: Res, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  // The allow-list is asserted by route-coverage; here the stub user IS the plugin service.
  requireInternalService: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  audited: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  actorId: () => 'system',
}));

// Set BEFORE the route module is imported: the limit is read once, at import.
process.env.REGISTRY_SBOM_BODY_LIMIT = '4kb';

const express = (await import('express')).default;
const { createInternalRoutes } = await import('../src/routes/internal.js');

const ORG = '6650f0c3a1b2c3d4e5f60718';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const SBOM = { spdxVersion: 'SPDX-2.3', name: 'foo', packages: [] };

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  // Stand-in for requireAuth: a plugin service token for the org in the header.
  app.use((req, _res, next) => {
    (req as { user?: unknown }).user = {
      principalType: 'service', serviceName: 'plugin', organizationId: req.header('x-test-org') ?? ORG,
    };
    next();
  });
  app.use('/internal', createInternalRoutes());
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  headManifest.mockResolvedValue({ digest: DIGEST });
});

const post = async (body: unknown, org?: string) => {
  const res = await fetch(`${baseUrl}/internal/plugin-signatures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(org ? { 'x-test-org': org } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('an SBOM over REGISTRY_SBOM_BODY_LIMIT', () => {
  const bigSbom = (n: number) => ({
    spdxVersion: 'SPDX-2.3',
    name: 'gar-push',
    packages: Array.from({ length: n }, (_, i) => ({ name: `pkg-${i}`, versionInfo: '1.0.0' })),
  });

  it('answers 413 with a message naming the limit and the knob', async () => {
    const { status, body } = await post({ repository: `org-${ORG}/gar-push`, digest: DIGEST, sbom: bigSbom(400) });

    expect(status).toBe(413);
    // The three things the build log needs: that the SBOM was the problem, what
    // the ceiling is, and which variable moves it.
    expect(String(body.message)).toContain('SBOM');
    expect(String(body.message)).toContain('4kb');
    expect(String(body.message)).toContain('REGISTRY_SBOM_BODY_LIMIT');
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('does not sign, audit, or touch the registry when it refuses', async () => {
    await post({ repository: `org-${ORG}/gar-push`, digest: DIGEST, sbom: bigSbom(400) });
    expect(signPluginImage).not.toHaveBeenCalled();
    expect(headManifest).not.toHaveBeenCalled();
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it('still answers 400 for a MALFORMED body rather than the size message', async () => {
    // The handler must claim "too large" only for `entity.too.large`. A broken
    // JSON body is a different fault, and telling the operator to raise the
    // limit would send them after the wrong thing.
    const res = await fetch(`${baseUrl}/internal/plugin-signatures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"repository": "org-x/y", ',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('REGISTRY_SBOM_BODY_LIMIT');
  });

  it('accepts an SBOM under the ceiling unchanged', async () => {
    const { status } = await post({ repository: `org-${ORG}/foo`, digest: DIGEST, sbom: SBOM });
    expect(status).toBe(200);
    expect(signPluginImage).toHaveBeenCalled();
  });
});
