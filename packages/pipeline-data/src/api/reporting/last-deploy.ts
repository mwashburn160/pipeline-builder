// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The last commit this pipeline deployed to an environment — the exclusive lower
 * bound the events Lambda needs to ask an SCM "what shipped since?".
 *
 * The Lambda keeps that bound in a warm-container map (`lastShaByPipeline` in
 * `scm.ts`). A cold start empties it, so the next deploy resolved as a SINGLE
 * commit: lead time came out as the age of the newest commit alone and
 * `commitCount` as 1, both far too small, and nothing in the data marked the
 * number as degraded. Lambda containers recycle constantly, so this was the
 * common case, not an edge one.
 *
 * Reading it back from `commit_sha` — already persisted for every event that
 * carried one — makes the bound survive a cold start without any new state.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { eq, sql } from 'drizzle-orm';
import type { IngestCaller } from './types.js';
import { drizzleRows } from '../crud-service.js';
import { schema } from '../../database/drizzle-schema.js';
import { withTenantTx } from '../../database/tenancy.js';

const logger = createLogger('reporting-last-deploy');

/** The bound, or nulls when this pipeline has no recorded deploy carrying a commit. */
export interface LastDeployedCommit {
  /** Commit sha of the most recent successful deploy to the environment. */
  commitSha: string | null;
  /** When that deploy completed, ISO text — for the caller's own logging. */
  deployedAt: string | null;
}

const NONE: LastDeployedCommit = { commitSha: null, deployedAt: null };

/**
 * The commit sha of the most recent SUCCEEDED deploy-stage execution for this
 * pipeline — narrowed to one `environment` when given.
 *
 * Two steps, because the two facts live on different rows: `environment` is
 * stamped on the deploy STAGE event, while `commit_sha` rides the source
 * ACTION/PIPELINE event of the same execution. They are joined by `execution_id`,
 * exactly as the DORA lead-time query does it.
 *
 * `environment` is OPTIONAL because of who asks. The events Lambda resolves a
 * commit while handling the SOURCE event, and a source stage carries no
 * environment — the execution has not reached a deploy stage yet, so at that
 * moment the environment is genuinely unknown. Omitting it answers "what did this
 * pipeline last ship anywhere", which is the right lower bound for an SCM range;
 * passing it answers per-environment, for callers that know.
 *
 * TENANCY. `caller` is enforced the same way as {@link ingestEvents}: the org
 * comes from the pipeline REGISTRY, never from the caller, and a pipeline outside
 * the caller's allow-list returns nothing. Without this the endpoint would hand
 * any `reporting:ingest` holder another tenant's commit history — the same hole
 * the ingest tenancy check closes on the write side.
 */
export async function getLastDeployedCommit(
  pipelineId: string,
  environment?: string,
  caller?: IngestCaller,
): Promise<LastDeployedCommit> {
  const unrestricted = caller === undefined || caller.crossTenant === true;
  const allowed = new Set(caller?.allowedOrgIds ?? []);

  return withTenantTx(async (tx) => {
    const [registry] = await tx
      .select({ orgId: schema.pipelineRegistry.orgId })
      .from(schema.pipelineRegistry)
      .where(eq(schema.pipelineRegistry.pipelineId, pipelineId));
    // Unregistered pipeline: indistinguishable from "no deploys yet" to the
    // caller, deliberately — an unregistered id must not confirm or deny existence.
    if (!registry) return NONE;

    if (!unrestricted && !allowed.has(registry.orgId)) {
      logger.warn('Refused last-deploy-commit lookup outside the caller org scope', {
        pipelineId, foreignOrgId: registry.orgId, allowedOrgIds: [...allowed],
      });
      return NONE;
    }

    const rows = drizzleRows<{ commit_sha: string | null; completed_at: string | null }>((await tx.execute(sql`
      WITH last_deploy AS (
        SELECT e.execution_id AS execution_id, e.completed_at AS completed_at
        FROM ${schema.pipelineEvent} e
        WHERE e.pipeline_id = ${pipelineId}
          AND e.org_id = ${registry.orgId}
          ${environment ? sql`AND e.environment = ${environment}` : sql`AND e.environment IS NOT NULL`}
          AND e.event_type = 'STAGE'
          AND e.status = 'SUCCEEDED'
          AND e.completed_at IS NOT NULL
        ORDER BY e.completed_at DESC
        LIMIT 1
      )
      SELECT c.commit_sha AS commit_sha, ld.completed_at::text AS completed_at
      FROM last_deploy ld
      JOIN ${schema.pipelineEvent} c
        ON c.execution_id = ld.execution_id
       AND c.pipeline_id = ${pipelineId}
       AND c.org_id = ${registry.orgId}
      WHERE c.commit_sha IS NOT NULL
      ORDER BY c.created_at DESC
      LIMIT 1
    `)).rows);

    const row = rows[0];
    if (!row) return NONE;
    return { commitSha: row.commit_sha ?? null, deployedAt: row.completed_at ?? null };
  });
}
