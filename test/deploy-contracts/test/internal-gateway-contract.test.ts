// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ONE rule keeps every internal service-to-service contract off the external
 * surface: the gateway refuses an `internal` path segment.
 *
 * Every api-core internal contract is served under `/internal/…` or
 * `/<service>/internal/…` (`defineInternalEndpoint` refuses any other path), and
 * each nginx.conf answers `^/api/(?:[^/]+/)?internal(?:/|$)` with a 404 before
 * any per-service prefix (`/api/compliance`, `/api/reports`, `/api/billing/`, …)
 * can forward it. The services call each other over the cluster network, so
 * nothing legitimate arrives that way. This suite pins, for all four targets:
 *
 *  - the refusal exists, is the FIRST regex location in the API server (nginx
 *    takes the first matching regex, so a regex above it would win), and
 *    answers 404;
 *  - every contract path, put behind `/api`, is refused by it;
 *  - no user route in the route tables is (the rule removes nothing a client
 *    calls).
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { ALL_TARGETS, read, REPO_ROOT } from '../src/index.js';

const REFUSAL = 'location ~* ^/api/(?:[^/]+/)?internal(?:/|$) { return 404; }';
/** The same pattern, as nginx (PCRE, `~*` case-insensitive) evaluates it. */
const GATEWAY_REFUSES = /^\/api\/(?:[^/]+\/)?internal(?:\/|$)/i;

/** The uncommented `location` lines of a config, in order. */
function locations(conf: string): string[] {
  return conf.split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l.startsWith('location '));
}

/** Every `path: '…'` an api-core contract module declares. */
function contractPaths(): string[] {
  const dir = 'packages/api-core/src/contracts';
  return readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith('.ts'))
    .flatMap((f) => [...read(`${dir}/${f}`).matchAll(/^\s+path: '([^']+)',$/gm)].map((m) => m[1]!));
}

interface RouteRow { method: string; path: string; internalCallers: string[] }

/** Every route the services serve, from the generated route tables. */
function routeTable(): RouteRow[] {
  const dir = 'frontend/src/generated/route-table';
  return readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith('.json'))
    .flatMap((f) => JSON.parse(read(`${dir}/${f}`)) as RouteRow[]);
}

describe('the gateway refuses every internal path segment', () => {
  it.each(ALL_TARGETS)('%s: the refusal is the first regex location and answers 404', (target) => {
    const locs = locations(read(`${target}/nginx/nginx.conf`));
    expect(locs).toContain(REFUSAL);
    const firstRegex = locs.find((l) => /^location ~\*? /.test(l));
    expect(firstRegex).toBe(REFUSAL);
  });

  it('refuses every internal contract path once it carries the /api prefix', () => {
    const paths = contractPaths();
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.filter((p) => !GATEWAY_REFUSES.test(`/api${p}`))).toEqual([]);
  });

  it('refuses the case and trailing-segment variants Express would still route', () => {
    for (const p of ['/api/compliance/INTERNAL/posture', '/api/Reports/Internal/x', '/api/internal', '/api/billing/internal']) {
      expect(p).toMatch(GATEWAY_REFUSES);
    }
    for (const p of ['/api/reports/stakeholder-internal/x', '/api/plugins/internals', '/api/a/b/internal/x']) {
      expect(p).not.toMatch(GATEWAY_REFUSES);
    }
  });

  it('refuses no user-facing route (only routes gated to named internal callers carry the segment)', () => {
    const blocked = routeTable()
      .filter((r) => r.internalCallers.length === 0 && GATEWAY_REFUSES.test(`/api${r.path}`))
      .map((r) => `${r.method} ${r.path}`);
    expect(blocked).toEqual([]);
  });
});
