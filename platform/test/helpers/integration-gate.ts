// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The gate for suites that need a real MongoDB (`mongodb-memory-server`).
 *
 * WHY THIS ISN'T JUST `describe.skip`. These suites were gated on
 * `RUN_MONGO_INTEGRATION` alone, so a run without it degraded to **green and
 * empty** — and that is indistinguishable from a run where they all passed. CI
 * sets the variable in `.github/workflows/test.yml`, but if that line is dropped,
 * renamed, or a new workflow forgets it, the integration tier silently stops
 * running and every build stays green. A safety net you cannot tell is missing
 * is not a safety net.
 *
 * So the gate has two modes:
 *   - **locally**: skip, as before — nobody should need mongod to run unit tests;
 *   - **on the CI runner**: the variable is REQUIRED. If it is missing the suite
 *     FAILS with an explanation instead of skipping, so a dropped env line
 *     surfaces as a red build naming the cause.
 *
 * WHY NOT THE GENERIC `CI` VARIABLE. It was keyed on `CI` first, which plenty of
 * local tooling exports (task runners, IDE terminals, agent harnesses) — so a
 * developer running `jest` on their laptop got a hard failure for a tier they
 * never asked to run. `GITHUB_ACTIONS` is set by the runner itself, not by our
 * workflow file, so it keeps the property that matters: deleting the
 * `RUN_MONGO_INTEGRATION` line from `test.yml` still turns the build red.
 * Another CI system needs its own marker added here (and should also set
 * `RUN_MONGO_INTEGRATION`).
 *
 * Usage mirrors the pattern it replaces:
 *
 *   const suite = integrationSuite();
 *   suite('TOTP enrolment (real Mongo replica set)', () => { … });
 */

import { describe, it } from '@jest/globals';
const isEnabled = (): boolean =>
  process.env.RUN_MONGO_INTEGRATION === '1' || process.env.RUN_MONGO_INTEGRATION === 'true';

/** True only on the CI runner itself — set by GitHub Actions, never by us. */
const isCi = (): boolean => !!process.env.GITHUB_ACTIONS && process.env.GITHUB_ACTIONS !== 'false';

const MISSING_IN_CI =
  'RUN_MONGO_INTEGRATION is not set, but this is a GitHub Actions run. The Mongo '
  + 'integration tier would have silently skipped — a green, empty run that looks '
  + 'identical to a passing one. Restore RUN_MONGO_INTEGRATION=1 in the workflow env '
  + '(see .github/workflows/test.yml).';

/**
 * The shape a suite uses: `suite('name', () => { … })`. Declared structurally
 * rather than as `jest.Describe` — these packages drop `@types/jest` and import
 * their globals from `@jest/globals`, so the ambient `jest` namespace type does
 * not exist here.
 */
export type SuiteFn = (name: string, fn: () => void) => void;

/**
 * The `describe` to hang a Mongo integration suite off: the real one when
 * enabled, `describe.skip` locally, and a suite that FAILS when CI is set
 * without the gate variable.
 */
export function integrationSuite(): SuiteFn {
  if (isEnabled()) return describe as unknown as SuiteFn;
  if (isCi()) {
    // Not `describe.failing` — that would report as an EXPECTED failure and stay
    // green. This registers one test that fails loudly with the reason.
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
