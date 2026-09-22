// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sql } from 'drizzle-orm';

/**
 * `LATERAL (…) AS refs`: one `ref` row per plugin reference of the pipeline
 * aliased `p` — every stage step's `plugin`, plus the synth plugin. Join it as
 * `FROM pipelines p, ${pipelinePluginRefs}` and read `ref->>'name'`,
 * `ref->>'publisher'`, `ref->'filter'->>'version'`.
 */
export function pipelinePluginRefs() {
  return sql`LATERAL (
               SELECT step->'plugin' AS ref
                 FROM jsonb_array_elements(COALESCE(p.props->'stages', '[]'::jsonb)) AS stage,
                      jsonb_array_elements(COALESCE(stage->'steps', '[]'::jsonb)) AS step
               UNION ALL
               SELECT p.props->'synth'->'plugin'
             ) AS refs`;
}
