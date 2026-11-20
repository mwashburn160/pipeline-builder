// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pipeline-core's `toResolvedPlugin`, for suites that stub pipeline-core: the
 * stub can't load the real module inside its factory, so this mirrors it;
 * resolved-plugin-helper.test.ts compares it with the real one.
 */
export const RESOLVED_PLUGIN_OMITTED_FIELDS = [
  'readmeMd', 'readmeHtml', 'changelog', 'scanSummary', 'dockerfile', 'icon', 'uploadedIcon',
  'sourceKey', 'sourceSha256', 'sourceSizeBytes', 'sourceKind', 'sourceKeptAt', 'deleteBatchId',
  'lastUsedAt', 'tidyKeptAt', 'tidyWarnedAt', 'tidyDeactivateAfter', 'tidyDeactivatedAt',
] as const;

export function toResolvedPlugin(record: Record<string, unknown>): Record<string, unknown> {
  const out = { ...record };
  for (const field of RESOLVED_PLUGIN_OMITTED_FIELDS) delete out[field];
  return out;
}
