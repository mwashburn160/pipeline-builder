// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/pipeline-data/testing
 *
 * Test-only helpers for running REAL data-layer code against an in-process
 * Postgres (PGlite) that has the shipped `postgres-init.sql` applied — RLS,
 * FORCE, triggers and constraints included.
 *
 * Shipped as its OWN package entry, never re-exported from the production
 * barrel, and excluded from the packed package (`.npmignore` `/lib/testing/`),
 * so no service image carries it. It is workspace-only by construction anyway:
 * it reads the init script from the repository's `deploy/` tree.
 *
 *   - {@link bootInitDb}: a raw PGlite with the init script applied (superuser).
 *   - {@link asTenant}: raw SQL as `pb_app` under a tenant's RLS GUCs, rolled back.
 *   - {@link bootTenantDb}: installs PGlite as the package's `db`, so the real
 *     `withTenantTx` / CrudService / services run against it as `pb_app`.
 *   - {@link asTenantContext}: the request-scope tenant context those read.
 */

export * from './pglite-init.js';
export * from './tenant-db.js';
