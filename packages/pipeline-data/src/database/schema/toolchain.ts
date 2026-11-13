// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sql } from 'drizzle-orm';
import { boolean, varchar, pgTable, text, timestamp, uuid, index, check } from 'drizzle-orm/pg-core';

/**
 * Managed toolchain releases (docs/plans/bootstrap-image-versioning.md §1, §5).
 *
 * `pipeline-bootstrap@V` and `cdk-synth@V` are two system-org plugin rows that
 * share ONE release version `V`. These tables hold the release-level state the
 * plugin rows don't: which releases exist, THE platform default, the canary
 * cohort, each org's override, and the history of every change. Managed plugin
 * rows never use `plugins.is_default`.
 *
 * RLS (postgres-init.sql, dedicated policies — NOT the generic org loop): the
 * first four are system-org only (sysadmin scope or the system org's own scope)
 * for reads AND writes; `org_toolchain_default` is own-org read/write with a
 * system-org read; its history is own-org read + insert (append-only), system-org
 * read. Resolution reads them elevated (`runWithTenantContext({ isSuperAdmin: true })`).
 */

/** How a platform-default change came about: a console `set`, the install-time
 *  `initial` (D14), or a `restore` of the previous default on a yank. */
export type ToolchainDefaultKind = 'set' | 'initial' | 'restore';

/**
 * One row per release. Release versions are plain `X.Y.Z` — a managed name
 * refuses prerelease uploads, so a dev build can never become a release.
 *
 * @table toolchain_release
 */
export const toolchainRelease = pgTable('toolchain_release', {
  releaseVersion: varchar('release_version', { length: 50 }).primaryKey(),
  releaseNotes: text('release_notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  createdBy: text('created_by').notNull(),
}, (table) => ({
  versionCheck: check('toolchain_release_version_check', sql`${table.releaseVersion} ~ '^[0-9]+\.[0-9]+\.[0-9]+$'`),
}));

/**
 * THE platform default — at most one row (the boolean PK can only hold `true`).
 * The referenced release can't be deleted while it is the default.
 *
 * @table toolchain_platform_default
 */
export const toolchainPlatformDefault = pgTable('toolchain_platform_default', {
  singleton: boolean('singleton').primaryKey().default(true),
  releaseVersion: varchar('release_version', { length: 50 }).notNull()
    .references(() => toolchainRelease.releaseVersion, { onDelete: 'restrict' }),
  setAt: timestamp('set_at', { withTimezone: true }).defaultNow().notNull(),
  setBy: text('set_by').notNull(),
}, (table) => ({
  singletonCheck: check('toolchain_platform_default_singleton_check', sql`${table.singleton}`),
}));

/**
 * Every platform-default change. No FK on the versions: history outlives a
 * deleted release.
 *
 * @table toolchain_default_history
 */
export const toolchainDefaultHistory = pgTable('toolchain_default_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  releaseVersion: varchar('release_version', { length: 50 }).notNull(),
  previousReleaseVersion: varchar('previous_release_version', { length: 50 }),
  setBy: text('set_by').notNull(),
  setAt: timestamp('set_at', { withTimezone: true }).defaultNow().notNull(),
  reason: text('reason'),
  kind: varchar('kind', { length: 16 }).$type<ToolchainDefaultKind>().notNull(),
}, (table) => ({
  setAtIdx: index('toolchain_default_history_set_at_idx').on(table.setAt.desc()),
  kindCheck: check('toolchain_default_history_kind_check', sql`${table.kind} IN ('set', 'initial', 'restore')`),
}));

/**
 * Canary membership: ONE release per org. `orgId` is a MEMBER (the org the
 * canary applies to), not an owner — rows are written by the system org, and a
 * member org can't read them.
 *
 * @table toolchain_rollout
 */
export const toolchainRollout = pgTable('toolchain_rollout', {
  orgId: varchar('org_id', { length: 255 }).primaryKey(),
  releaseVersion: varchar('release_version', { length: 50 }).notNull()
    .references(() => toolchainRelease.releaseVersion, { onDelete: 'restrict' }),
  addedBy: text('added_by').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  releaseIdx: index('toolchain_rollout_release_idx').on(table.releaseVersion),
}));

/**
 * An org's override of the platform default (one per org). "Follow platform
 * default" deletes the row. Team inheritance is resolved in the resolver, not
 * by RLS.
 *
 * @table org_toolchain_default
 */
export const orgToolchainDefault = pgTable('org_toolchain_default', {
  orgId: varchar('org_id', { length: 255 }).primaryKey(),
  releaseVersion: varchar('release_version', { length: 50 }).notNull()
    .references(() => toolchainRelease.releaseVersion, { onDelete: 'restrict' }),
  setBy: text('set_by').notNull(),
  setAt: timestamp('set_at', { withTimezone: true }).defaultNow().notNull(),
  reason: text('reason'),
}, (table) => ({
  releaseIdx: index('org_toolchain_default_release_idx').on(table.releaseVersion),
}));

/**
 * An org's override changes, append-only for the org. `releaseVersion` is
 * `null` for a clear (back to the platform default). No FK: history outlives a
 * deleted release.
 *
 * @table org_toolchain_default_history
 */
export const orgToolchainDefaultHistory = pgTable('org_toolchain_default_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  releaseVersion: varchar('release_version', { length: 50 }),
  setBy: text('set_by').notNull(),
  setAt: timestamp('set_at', { withTimezone: true }).defaultNow().notNull(),
  reason: text('reason'),
}, (table) => ({
  orgIdx: index('org_toolchain_default_history_org_idx').on(table.orgId, table.setAt.desc()),
}));

export type ToolchainRelease = typeof toolchainRelease.$inferSelect;
export type ToolchainReleaseInsert = typeof toolchainRelease.$inferInsert;
export type ToolchainPlatformDefault = typeof toolchainPlatformDefault.$inferSelect;
export type ToolchainDefaultHistory = typeof toolchainDefaultHistory.$inferSelect;
export type ToolchainDefaultHistoryInsert = typeof toolchainDefaultHistory.$inferInsert;
export type ToolchainRollout = typeof toolchainRollout.$inferSelect;
export type ToolchainRolloutInsert = typeof toolchainRollout.$inferInsert;
export type OrgToolchainDefault = typeof orgToolchainDefault.$inferSelect;
export type OrgToolchainDefaultInsert = typeof orgToolchainDefault.$inferInsert;
export type OrgToolchainDefaultHistory = typeof orgToolchainDefaultHistory.$inferSelect;
export type OrgToolchainDefaultHistoryInsert = typeof orgToolchainDefaultHistory.$inferInsert;
