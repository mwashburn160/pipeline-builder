// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/api-core/testing
 *
 * Test-only helpers, shipped as their OWN package entry
 * (`@pipeline-builder/api-core/testing`) — never re-exported from the
 * production barrel, and excluded from the packed package (`.npmignore`
 * `/lib/testing/`), so no service image carries them.
 *
 * A suite's `jest.unstable_mockModule('@pipeline-builder/api-core', …)` never
 * intercepts this entry: it resolves to a different module.
 */

export * from './any-fn.js';
export * from './mock-api-core.js';
export * from './mock-drizzle.js';
export * from './route-coverage.js';
export * from './service-tokens.js';
export * from './stub-module.js';
export * from './tier-mock.js';
export * from './user-tokens.js';
