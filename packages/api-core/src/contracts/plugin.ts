// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY plugin (router mounted at `/internal`, behind
 * `requireAuth`). All three are image-registry's reads of plugin facts it
 * cannot know: which of an org's plugins are public, which digests its
 * namespace still needs, and which pipelines reference given digests. Plus
 * platform's two cascade legs (its durable outbox): an org's plugin rows
 * purged, and an erased user's listing reviews anonymized.
 *
 * NOT here: `POST /plugins/toolchain/initial-default`, the deploy scripts'
 * one-time fresh-install toolchain default. Its caller is an operator shell
 * reaching the plugin service THROUGH the gateway (no mesh principal), so it is
 * an ingress route, not a service-to-service contract; its schema lives with
 * the route (api/plugin `routes/toolchain.ts`).
 */

import { z } from 'zod';
import { CASCADE_LEG_AUTH, CascadeOrgParams, CascadeUserParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';
import { REMEDIATION_ROLLOUT_PAUSE_REASONS, REMEDIATION_ROLLOUT_STATUSES } from '../types/plugin-remediation.js';

/** Digests one image-pipeline-references read may ask about (the caller chunks). */
export const MAX_REFERENCE_DIGESTS = 50;

const ORG_ID_MESSAGE = 'orgId is required';
const ORG_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** `?orgId=`, lowercased; one message for absent and malformed alike. */
const OrgIdQuery = z.object({
  orgId: z.string({ error: ORG_ID_MESSAGE })
    .transform((s) => s.toLowerCase())
    .refine((s) => ORG_ID_PATTERN.test(s) && s.length <= 255, ORG_ID_MESSAGE),
});

const DIGESTS_MESSAGE = `digests must be 1-${MAX_REFERENCE_DIGESTS} comma-separated sha256 digests`;

/** The distinct digests of a `?digests=` value (comma-separated). */
export function splitReferenceDigests(raw: string): string[] {
  return [...new Set(raw.split(','))];
}

/**
 * `?digests=a,b,…` (comma-separated). Stays a STRING on the wire and after
 * parsing — the server splits it with {@link splitReferenceDigests}.
 */
const DigestsQuery = z.object({
  digests: z.string({ error: DIGESTS_MESSAGE }).refine((s) => {
    if (s === '') return false;
    const d = splitReferenceDigests(s);
    return d.length <= MAX_REFERENCE_DIGESTS && d.every((x) => DIGEST_PATTERN.test(x));
  }, DIGESTS_MESSAGE),
});

const REGISTRY_AUTH = 'image-registry service token (it mints one for the system org); the org is the QUERY param.';

export const PLUGIN_INTERNAL = {
  /** The names of an org's live `public` plugins — the only parent repos its TEAMS may pull. */
  publicPluginNames: defineInternalEndpoint({
    id: 'plugin.publicPluginNames',
    service: 'plugin',
    method: 'GET',
    path: '/internal/plugins/public-names',
    callers: ['image-registry'],
    auth: REGISTRY_AUTH,
    params: z.object({}),
    query: OrgIdQuery,
    response: z.object({ names: z.array(z.string()) }),
  }),
  /** Every image digest the org's namespace still needs (the age GC deletes none of them). */
  orgImageReferences: defineInternalEndpoint({
    id: 'plugin.orgImageReferences',
    service: 'plugin',
    method: 'GET',
    path: '/internal/plugins/image-references',
    callers: ['image-registry'],
    auth: REGISTRY_AUTH,
    params: z.object({}),
    query: OrgIdQuery,
    response: z.object({ digests: z.array(z.string()) }),
  }),
  /**
   * Which PIPELINES (any org) still reference each digest — only digests with
   * at least one appear; `pipelines` names at most 50, `pipelineCount` is exact.
   */
  imagePipelineReferences: defineInternalEndpoint({
    id: 'plugin.imagePipelineReferences',
    service: 'plugin',
    method: 'GET',
    path: '/internal/plugins/image-pipeline-references',
    callers: ['image-registry'],
    auth: 'image-registry service token; elevated read across every org.',
    params: z.object({}),
    query: DigestsQuery,
    response: z.object({
      references: z.array(z.object({
        digest: z.string(),
        pipelineCount: z.number(),
        pipelines: z.array(z.object({
          id: z.string(),
          name: z.string().nullable(),
          orgId: z.string(),
          sources: z.array(z.string()),
          deleted: z.boolean(),
        })),
      })),
    }),
  }),
  /** Idempotent: 200 `{ orgId, tables }`; 500 when any table failed (the leg retries). */
  purgeOrg: defineInternalEndpoint({
    id: 'plugin.purgeOrg',
    service: 'plugin',
    method: 'POST',
    path: '/internal/plugins/orgs/:orgId/purge',
    callers: ['platform'],
    auth: CASCADE_LEG_AUTH,
    params: CascadeOrgParams,
    response: OrgPurgeResponse,
  }),
  /**
   * GDPR erasure of a deleted user's listing reviews (author, display name and
   * body go NULL; the rating stays). Idempotent — the predicate is the author
   * id, so a redelivery scrubs nothing and still answers 200 `{ userId, reviews }`.
   */
  eraseUser: defineInternalEndpoint({
    id: 'plugin.eraseUser',
    service: 'plugin',
    method: 'POST',
    path: '/internal/plugins/users/:userId/erase',
    callers: ['platform'],
    auth: CASCADE_LEG_AUTH,
    params: CascadeUserParams,
    response: z.object({ userId: z.string(), reviews: z.number() }),
  }),
  /**
   * A plugin lookup FOR an org, on behalf of a runner's deploy job (the
   * pipeline service's session facade `POST …/runner/deploys/:requestId/plugin-lookup`
   * proxies it; the job holds a deploy session, never a user token). Same
   * body and answer as `POST /plugins/lookup` (filter, optional context and
   * releasePin → `{ plugin, warnings, … }`), resolved as `:orgId` would see
   * it; 404 / 400 as that route answers them.
   */
  deployLookup: defineInternalEndpoint({
    id: 'plugin.deployLookup',
    service: 'plugin',
    method: 'POST',
    path: '/internal/plugins/orgs/:orgId/lookup',
    callers: ['pipeline'],
    auth: 'pipeline service token (service principal); the org is the PATH param — the deploy session\'s org, never the caller\'s choice.',
    params: CascadeOrgParams,
    body: z.object({
      filter: z.record(z.string(), z.unknown()),
      context: z.unknown().optional(),
      releasePin: z.unknown().optional(),
    }).strict(),
    response: z.looseObject({
      plugin: z.record(z.string(), z.unknown()),
      warnings: z.array(z.unknown()),
    }),
  }),
  /**
   * The pipeline service's progress report on a remediation rollout
   * (PIPELINE_INTERNAL.startRemediationRollout). The plugin service stores
   * `summary` in plugin_remediations.rollout, moves the stage (rolling_out →
   * done on `done`; → needs_review on `paused`), and sends the notices: N37
   * when the rollout finished or paused, N38 per `rolledBack` event to that
   * pipeline's owners. Idempotent per (remediationId, event.pipelineId,
   * event.kind, event.at): a redelivered report notifies nobody twice. 404 for
   * an unknown remediation (the pipeline side drops the rollout).
   */
  reportRemediationRollout: defineInternalEndpoint({
    id: 'plugin.reportRemediationRollout',
    service: 'plugin',
    method: 'POST',
    path: '/internal/plugins/remediations/:remediationId/rollout',
    callers: ['pipeline'],
    auth: 'pipeline service token; elevated write to the remediation row of any org (the row names its org).',
    params: z.object({ remediationId: z.string().uuid() }),
    body: z.object({
      summary: z.object({
        status: z.enum(REMEDIATION_ROLLOUT_STATUSES),
        toVersion: z.string().min(1).max(50),
        waves: z.array(z.object({
          index: z.number().int().nonnegative(),
          kind: z.enum(['canary', 'batch']),
          pipelineIds: z.array(z.string().uuid()).max(50),
          startedAt: z.string(),
          finishedAt: z.string().nullable(),
          outcome: z.enum(['running', 'succeeded', 'failed']),
        })).max(1000),
        counts: z.object({
          eligible: z.number().int().nonnegative(),
          proposed: z.number().int().nonnegative(),
          changeRequested: z.number().int().nonnegative(),
          moved: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          rolledBack: z.number().int().nonnegative(),
          skippedOptOut: z.number().int().nonnegative(),
          skippedRunner: z.number().int().nonnegative(),
          waitingChangeRequest: z.number().int().nonnegative().optional(),
          movedPendingRedeploy: z.number().int().nonnegative().optional(),
        }),
        pausedReason: z.enum(REMEDIATION_ROLLOUT_PAUSE_REASONS).optional(),
        updatedAt: z.string(),
      }),
      /** New per-pipeline events since the last report (notice fan-out). */
      events: z.array(z.object({
        kind: z.enum(['rolled_back', 'rollback_blocked']),
        orgId: z.string().min(1).max(255),
        pipelineId: z.string().uuid(),
        fromVersion: z.string().min(1).max(50),
        toVersion: z.string().min(1).max(50),
        at: z.string(),
      })).max(500),
    }).strict(),
    response: z.object({ remediationId: z.string(), stage: z.string() }),
  }),
} as const;
