// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pipeline-core's `toSynthPlugin`, for suites that stub pipeline-core: the
 * stub can't load the real module inside its factory, so this mirrors it;
 * synth-plugin-helper.test.ts compares it with the real one.
 */
export const SYNTH_OMITTED_PLUGIN_FIELDS = ['readmeMd', 'readmeHtml', 'changelog', 'scanSummary', 'dockerfile', 'icon', 'uploadedIcon'] as const;

export function toSynthPlugin(record: Record<string, unknown>): Record<string, unknown> {
  const out = { ...record };
  for (const field of SYNTH_OMITTED_PLUGIN_FIELDS) delete out[field];
  return out;
}
