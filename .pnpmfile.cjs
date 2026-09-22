// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pnpm install hooks.
 *
 * drizzle-orm declares an OPTIONAL peer on every driver it can wrap, including
 * `@electric-sql/pglite`. pipeline-data's RLS integration suite uses PGlite
 * directly (raw SQL against the real postgres-init.sql) — never through drizzle —
 * but pnpm still resolves drizzle's optional peer to it, producing a
 * `drizzle-orm(@electric-sql/pglite)` variant that every service then shares.
 * That variant carries the 25 MB WASM Postgres into each service's
 * `pnpm deploy --prod` image. Dropping the unused peer keeps one plain
 * drizzle-orm everywhere and PGlite a test-only devDependency.
 */
function readPackage(pkg) {
  if (pkg.name === 'drizzle-orm') {
    if (pkg.peerDependencies) delete pkg.peerDependencies['@electric-sql/pglite'];
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta['@electric-sql/pglite'];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
