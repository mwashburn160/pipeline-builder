// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The gate for suites that need a real MongoDB (`mongodb-memory-server`).
 *
 * A COPY of platform/test/helpers/integration-gate.ts (read that file for the
 * full reasoning) — same variable, same CI wiring (the job-level
 * `RUN_MONGO_INTEGRATION` emitted by projenrc/workflow.ts on every job that
 * reaches `nx build`/`nx test`). Keep the copies in step.
 *
 *   - **locally**: skip — nobody should need mongod to run unit tests;
 *   - **on the GitHub Actions runner**: the variable is REQUIRED. Missing, the
 *     suite FAILS naming the cause instead of going green-and-empty.
 *
 * Keyed on `GITHUB_ACTIONS` (set by the runner itself), not the generic `CI`
 * that plenty of local tooling exports.
 *
 *   const suite = integrationSuite();
 *   suite('thing (real Mongo)', () => { … });
 */

import { describe, it, jest } from '@jest/globals';

/** Per test/hook budget: a real mongod under a full `nx run-many` is slower than a unit test. */
jest.setTimeout(30_000);

/** mongod boot budget under CI CPU contention; an explicit env value still wins. */
process.env.MONGOMS_INSTANCE_START_TIMEOUT ??= '60000';

/** The mongod version every integration suite boots (platform's pin). */
export const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';

const isEnabled = (): boolean =>
  process.env.RUN_MONGO_INTEGRATION === '1' || process.env.RUN_MONGO_INTEGRATION === 'true';

/** True only on the CI runner itself — set by GitHub Actions, never by us. */
const isCi = (): boolean => !!process.env.GITHUB_ACTIONS && process.env.GITHUB_ACTIONS !== 'false';

const MISSING_IN_CI =
  'RUN_MONGO_INTEGRATION is not set, but this is a GitHub Actions run. The Mongo '
  + 'integration tier would have silently skipped — a green, empty run that looks '
  + 'identical to a passing one. Restore RUN_MONGO_INTEGRATION=1 in the workflow env '
  + '(projenrc/workflow.ts → .github/workflows/test.yml).';

/** Structural `describe` shape (these packages import their globals from @jest/globals). */
export type SuiteFn = (name: string, fn: () => void) => void;

/** Real `describe` when enabled, `describe.skip` locally, a FAILING suite on CI without the variable. */
export function integrationSuite(): SuiteFn {
  if (isEnabled()) return describe as unknown as SuiteFn;
  if (isCi()) {
    // Not `describe.failing` — that would report as an EXPECTED failure and stay green.
    return (name: string) => {
      describe(name, () => {
        it('requires RUN_MONGO_INTEGRATION in CI', () => {
          throw new Error(MISSING_IN_CI);
        });
      });
    };
  }
  return describe.skip as unknown as SuiteFn;
}
