// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The gate for suites that need a REAL Redis (`API_CORE_TEST_REDIS_URL`).
 *
 * Same reasoning, and the same two modes, as platform's Mongo gate
 * (platform/test/helpers/integration-gate.ts): a bare `(url ? describe :
 * describe.skip)` degrades to green-and-empty when the variable goes missing,
 * which looks identical to a passing run. So:
 *   - **locally**: skip — nobody should need a redis-server for unit tests;
 *   - **on the GitHub Actions runner**: the variable is REQUIRED. CI starts a
 *     `redis:7-alpine` service container and exports the URL on every job that
 *     reaches `nx build`/`nx test` (projenrc/workflow.ts); if that wiring is
 *     dropped, these suites FAIL naming the cause instead of skipping.
 *
 * Keyed on `GITHUB_ACTIONS` (set by the runner itself), not `CI`, for the reason
 * the Mongo gate gives: plenty of local tooling exports `CI`.
 *
 *   const REAL_URL = realRedisUrl();
 *   redisSuite()('thing (real Redis)', () => { … new Redis(REAL_URL!) … });
 */

import { describe, it } from '@jest/globals';

/** The real-Redis URL, or undefined when the tier is off. */
export function realRedisUrl(): string | undefined {
  const url = process.env.API_CORE_TEST_REDIS_URL;
  return url && url.length > 0 ? url : undefined;
}

const isCi = (): boolean => !!process.env.GITHUB_ACTIONS && process.env.GITHUB_ACTIONS !== 'false';

const MISSING_IN_CI =
  'API_CORE_TEST_REDIS_URL is not set, but this is a GitHub Actions run. The real-Redis '
  + 'tier would have silently skipped — a green, empty run that looks identical to a '
  + 'passing one. Restore the redis service + API_CORE_TEST_REDIS_URL on the job '
  + '(projenrc/workflow.ts → .github/workflows/test.yml / release.yml).';

/** Structural `describe`/`it` shape (these packages import globals from @jest/globals). */
export type BlockFn = (name: string, fn: () => void | Promise<void>) => void;

function gate(real: BlockFn, skip: BlockFn, failing: (name: string) => void): BlockFn {
  if (realRedisUrl()) return real;
  if (isCi()) return failing;
  return skip;
}

/** `describe` for a real-Redis suite: real when enabled, skipped locally, FAILING on CI without the URL. */
export function redisSuite(): BlockFn {
  return gate(
    describe as unknown as BlockFn,
    describe.skip as unknown as BlockFn,
    (name) => describe(name, () => {
      it('requires API_CORE_TEST_REDIS_URL in CI', () => { throw new Error(MISSING_IN_CI); });
    }),
  );
}

/** `it` for a single real-Redis case inside an otherwise unit-level suite. */
export function redisTest(): BlockFn {
  return gate(
    it as unknown as BlockFn,
    it.skip as unknown as BlockFn,
    (name) => it(`${name} — requires API_CORE_TEST_REDIS_URL in CI`, () => { throw new Error(MISSING_IN_CI); }),
  );
}
