// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An org's `pluginRetention` settings (`plugin_retention_settings`; an absent
 * row is the defaults): `autoTidy` off | notify | on (default notify: warn
 * only), `staleAfterDays` (default 90, min 30), and the plugin names tidying
 * never touches. Read and written elevated: every call names its org.
 */

import { schema, type PluginRetentionSetting } from '@pipeline-builder/pipeline-data';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { TIDY_STALE_DEFAULT_DAYS, TIDY_STALE_MAX_DAYS, TIDY_STALE_MIN_DAYS } from './config.js';
import { elevated } from '../ecosystem/store.js';

export const AUTO_TIDY_MODES = ['off', 'notify', 'on'] as const;
export type AutoTidyMode = typeof AUTO_TIDY_MODES[number];

/** An org's effective tidy settings. */
export interface TidySettings {
  autoTidy: AutoTidyMode;
  staleAfterDays: number;
  /** Plugin names tidying never touches, sorted. */
  neverTidy: string[];
  /** The org's last tidy digest (ISO), or null. */
  lastDigestAt: string | null;
}

const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]{0,254}$/i;
/** A name a write may ADD: lowercase only, as the spec schema stores plugin names. */
const PLUGIN_NAME_WRITE = /^[a-z0-9][a-z0-9._-]{0,254}$/;

/** `PUT /plugins/tidy/settings` body: only the fields to change. */
export const TidySettingsWriteSchema = z.object({
  autoTidy: z.enum(AUTO_TIDY_MODES).optional(),
  staleAfterDays: z.number().int().min(TIDY_STALE_MIN_DAYS).max(TIDY_STALE_MAX_DAYS).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type TidySettingsWrite = z.infer<typeof TidySettingsWriteSchema>;

/** `PUT /plugins/by-name/:name/never-tidy` body. */
export const NeverTidyWriteSchema = z.object({ neverTidy: z.boolean() }).strict();

const S = () => schema.pluginRetentionSetting;

/** The effective settings of a stored row (or the defaults). */
export function normalizeTidySettings(row: Partial<PluginRetentionSetting> | null | undefined): TidySettings {
  const mode = AUTO_TIDY_MODES.includes(row?.autoTidy as AutoTidyMode) ? row!.autoTidy as AutoTidyMode : 'notify';
  const days = Number.isInteger(row?.staleAfterDays) && row!.staleAfterDays! >= TIDY_STALE_MIN_DAYS ? row!.staleAfterDays! : TIDY_STALE_DEFAULT_DAYS;
  const names = Array.isArray(row?.neverTidy) ? row!.neverTidy!.filter((n): n is string => typeof n === 'string' && PLUGIN_NAME.test(n)) : [];
  const last = row?.lastDigestAt ? new Date(row.lastDigestAt) : null;
  return { autoTidy: mode, staleAfterDays: days, neverTidy: [...new Set(names)].sort(), lastDigestAt: last ? last.toISOString() : null };
}

export async function readTidySettings(orgId: string): Promise<TidySettings> {
  const rows = await elevated((tx) => tx.select().from(S()).where(eq(S().orgId, orgId.toLowerCase())).limit(1)) as PluginRetentionSetting[];
  return normalizeTidySettings(rows[0]);
}

type SettingsPatch = Partial<{ autoTidy: AutoTidyMode; staleAfterDays: number; neverTidy: string[]; lastDigestAt: Date | null }>;

/** Upsert an org's settings row with `patch` (validated by the caller). */
export async function writeTidySettings(orgId: string, patch: SettingsPatch, by: string): Promise<TidySettings> {
  const org = orgId.toLowerCase();
  const rows = await elevated((tx) => tx.insert(S()).values({ orgId: org, ...patch, updatedBy: by })
    .onConflictDoUpdate({ target: S().orgId, set: { ...patch, updatedBy: by, updatedAt: new Date() } })
    .returning()) as PluginRetentionSetting[];
  return normalizeTidySettings(rows[0]);
}

/** Whether `name` is a plugin name as stored — lowercase only (what the never-tidy route may ADD). */
export const isPluginName = (name: string): boolean => PLUGIN_NAME_WRITE.test(name);

/** Whether `name` may be on a stored never-tidy list (any case: a list written before adds were lowercase-only can still be cleared). */
export const isListedPluginName = (name: string): boolean => PLUGIN_NAME.test(name);
