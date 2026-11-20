// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Request bodies of the plugin remediation routes (docs/plugin-publishing.md
 * "Scan gates"). Vocabulary in ../types/plugin-remediation.ts.
 */

import { z } from 'zod';
import {
  GRYPE_PACKAGE_TYPES,
  LIBRARY_UPGRADE_LEVELS,
  PLUGIN_REMEDIATION_MODES,
  PLUGIN_REMEDIATION_STAGES,
  TEAM_REMEDIATION_ROLLOUTS,
} from '../types/plugin-remediation.js';

const Level = z.enum(LIBRARY_UPGRADE_LEVELS);

/**
 * `PUT /plugins/remediation-settings` (org_settings:write). Only provided
 * fields are written. `libraryUpgradeLevelByType` replaces the whole map
 * (`null` for a type clears it). `rollout: 'inherit'` is valid on a team only
 * (the route answers 400 on a root org); `allowPipelineApply` is a root-org
 * setting (400 on a team). The per-plugin map is NOT written here — see
 * {@link PluginRemediationLevelWriteSchema}.
 */
export const PluginRemediationSettingsWriteSchema = z.object({
  mode: z.enum(PLUGIN_REMEDIATION_MODES).optional(),
  libraryUpgradeLevel: Level.optional(),
  libraryUpgradeLevelByType: z.partialRecord(z.enum(GRYPE_PACKAGE_TYPES), Level.nullable()).optional(),
  rollout: z.enum(TEAM_REMEDIATION_ROLLOUTS).optional(),
  allowPipelineApply: z.boolean().optional(),
}).strict();
export type PluginRemediationSettingsWrite = z.infer<typeof PluginRemediationSettingsWriteSchema>;

/** `PUT /plugins/by-name/:name/remediation-level` (plugins:write). `null` = Follow organization. */
export const PluginRemediationLevelWriteSchema = z.object({
  level: Level.nullable(),
}).strict();
export type PluginRemediationLevelWrite = z.infer<typeof PluginRemediationLevelWriteSchema>;

/** `POST /plugins/remediations/:id/approve` and `/reject` (plugins:write + step-up). */
export const PluginRemediationDecisionSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
}).strict();
export type PluginRemediationDecision = z.infer<typeof PluginRemediationDecisionSchema>;

/** `GET /plugins/remediations` query. `stage` is one stage or a comma list. */
export const PluginRemediationListQuerySchema = z.object({
  stage: z.string().optional().refine(
    (v) => v === undefined || v.split(',').every((s) => (PLUGIN_REMEDIATION_STAGES as readonly string[]).includes(s.trim())),
    'stage must be one or more remediation stages, comma-separated',
  ),
  pluginId: z.string().uuid().optional(),
  pluginName: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
});
export type PluginRemediationListQuery = z.infer<typeof PluginRemediationListQuerySchema>;
