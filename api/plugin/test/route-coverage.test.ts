// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission + audit coverage for every route this service serves.
 *
 * Builds the REAL route table from `src/app-routes.ts` (the same mount code
 * `index.ts` runs) and fails when a write route has no permission gate or no
 * declared audit action, or a read route has no permission gate. Exceptions are
 * explicit and carry a reason; a stale one fails the test too.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildRouteTable, REMOTE_AUDIT_ACTIONS, type RouteTableEntry } from '@pipeline-builder/api-core';
import {
  INFRA_ROUTE_EXCEPTIONS,
  compareRouteTableSnapshot,
  declaredAuditActions,
  findRouteCoverageViolations,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/lib/testing/route-coverage.js';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';
// The upload route builds its multer instance at module load and mkdir's the
// destination; the production default (/opt/pipeline/...) isn't writable here.
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-route-coverage-'));

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/plugin.json');

/** Routes that legitimately can't satisfy a rule, each with its reason. */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,
  {
    method: 'POST',
    path: '/plugins/lookup',
    waive: 'audit',
    reason: 'Read-only single-plugin lookup that takes its filter from the body (gated on plugins:read); persists nothing.',
  },
  {
    method: 'POST',
    path: /^POST \/plugins\/generate/,
    waive: 'audit',
    reason: 'AI generation returns a draft plugin config; nothing is persisted (deploying it goes through POST /plugins/deploy-generated, which is audited).',
  },
];

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { createQuotaService }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  // `logStream: true` is the one createApp option that adds routes (the
  // build-log SSE stream + its ticket mint) — index.ts enables it, so the table
  // must include it.
  const { app, sseManager } = createApp({ enableOpenApi: false, logStream: true });
  mountRoutes(app, { quotaService: createQuotaService(), sseManager });
  table = buildRouteTable(app);
});

describe('plugin route coverage', () => {
  it('serves a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(0);
  });

  it('gates every write route on a permission and declares its audit action', () => {
    const { violations } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  it('has no stale coverage exceptions', () => {
    const { unusedExceptions } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('declares only audit actions platform accepts from a service', () => {
    const unknown = declaredAuditActions(table).filter((a) => !(REMOTE_AUDIT_ACTIONS as readonly string[]).includes(a));
    expect(unknown).toEqual([]);
  });

  it('matches the route table the frontend reads', () => {
    expect(compareRouteTableSnapshot(table, snapshotFile)).toBeNull();
  });
});
