// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Repo-wide `process.env` guard, wired into every project as a
 * `setupFilesAfterEnv` entry (see `configureEsmJest` in projenrc/shared-config.ts).
 *
 * WHY: a jest worker runs many test FILES in ONE process, and `process.env` is
 * process-global — it is the one piece of state jest's `clearMocks` /
 * `restoreMocks` cannot reset. Ninety-odd suites here set env vars to drive
 * config loading, and the ones that never restore leak into whichever file the
 * worker picks up next. That makes a suite pass or fail depending on the file
 * ORDER jest happened to choose, which is exactly the class of flake nobody can
 * reproduce locally.
 *
 * WHAT IT DOES: snapshots the environment as the file starts and puts it back
 * when the file finishes — keys the file added are deleted, keys it changed or
 * deleted are restored. Restoring in `afterAll` (rather than `afterEach`) is
 * deliberate: plenty of suites legitimately set an env var once in `beforeAll`
 * and rely on it for every test in the file. A suite that needs per-TEST
 * isolation still saves and restores in its own `beforeEach`/`afterEach`.
 *
 * CJS on purpose: `setupFilesAfterEnv` modules are loaded through jest's CJS
 * require path, and every package here is `"type": "module"`.
 */

const fs = require('fs');
const path = require('path');

/**
 * Node floor check, MAJOR.MINOR only (any patch of the floor's line passes).
 * Returns the refusal message, or undefined when `found` is new enough.
 *
 * The floor comes from `.nvmrc`, which projen generates from `minNodeVersion`
 * in .projenrc.ts — the same constant behind every `engines.node` and
 * `.npmrc`'s `engine-strict`. Checked here as well because `engine-strict`
 * only gates `pnpm install`: a suite run on an older Node (a stale nvm shell,
 * an IDE runner) otherwise fails deep inside some unrelated API instead of
 * saying what is wrong.
 */
function nodeVersionProblem(found, floor) {
  const clean = String(found).replace(/^v/, '');
  const [maj, min] = clean.split('.').map(Number);
  const [fMaj, fMin] = String(floor).split('.').map(Number);
  const ok = maj > fMaj || (maj === fMaj && min >= fMin);
  return ok ? undefined : `Node >= ${fMaj}.${fMin} required (found ${clean})`;
}

const floor = fs.readFileSync(path.join(__dirname, '.nvmrc'), 'utf-8').trim();
const problem = nodeVersionProblem(process.versions.node, floor);
if (problem) throw new Error(problem);

module.exports = { nodeVersionProblem };

const snapshot = { ...process.env };

afterAll(() => {
  // `process.exitCode` is process-global too: a file whose code path calls
  // `handleError` (which sets it before exiting) left it behind for every later
  // file in the worker — a CLI suite reading it then saw a successful command
  // "exit 6" (CI-only, depending on which files shared the worker), and under
  // --runInBand jest itself would exit non-zero with every test passing.
  process.exitCode = undefined;
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
});
