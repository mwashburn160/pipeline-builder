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

const snapshot = { ...process.env };

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
});
