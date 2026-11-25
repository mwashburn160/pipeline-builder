// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY pipeline.
 *
 *  - org purge: platform's cascade outbox tears a deleted org's pipelines,
 *    templates, registry entries and per-pipeline security state out of the
 *    pipeline service's own tables.
 *  - runner signing-key re-encrypt: platform's secret-rotation flow re-wraps
 *    `pipeline_runner_signing_keys.private_key_enc` after a
 *    SECRET_ENCRYPTION_KEY or per-org KMS rotation (platform's own
 *    secret-reencrypt covers MongoDB only).
 *  - first-event registration: reporting's event ingest registers a deployed
 *    pipeline it sees events for but finds no registry row for.
 */

import { z } from 'zod';
import { CASCADE_LEG_AUTH, CascadeOrgParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';
import { PerOrgKmsConfigSchema } from './platform.js';
import { PIPELINE_REMEDIATION_UPGRADE_STATES, PLUGIN_REMEDIATION_ROLLOUTS } from '../types/plugin-remediation.js';

const ORG_ID = /^[a-f0-9]{24}$/i;
const ORG_ID_MESSAGE = 'orgId must be an organization id';
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
const REMEDIATION_AUTH = 'plugin service token (the remediation job, as SYSTEM_PLUGIN_REMEDIATION). Runs under a sysadmin tenant '
  + 'context scoped to the named org (or, for an Official listing fix, every org installing the listing); every pipeline move '
  + 'goes through the normal upgrade write path (template validation, contract check, compliance, resolution recording) and is '
  + 'audited pipeline.plugin.upgraded with actor SYSTEM_PLUGIN_REMEDIATION.';

/** Upper bound on pipelines per first-event registration (an ingest batch's cap). */
const MAX_FIRST_EVENT_PIPELINES = 100;
/** Upper bound on the ingest caller's org roll-up (its org plus descendant teams). */
const MAX_FIRST_EVENT_ORGS = 1000;

const RemediationParams = z.object({ remediationId: z.string().uuid() });

/** What a rollout reports per pipeline state (counts only). */
const RolloutCounts = z.object(Object.fromEntries(PIPELINE_REMEDIATION_UPGRADE_STATES.map((s) => [s, z.number().int().nonnegative()])) as Record<typeof PIPELINE_REMEDIATION_UPGRADE_STATES[number], z.ZodNumber>);

export const PIPELINE_INTERNAL = {
  /** Idempotent: 200 `{ orgId, tables }`; 500 when any table failed (the leg retries). */
  purgeOrg: defineInternalEndpoint({
    id: 'pipeline.purgeOrg',
    service: 'pipeline',
    method: 'POST',
    path: '/pipelines/internal/orgs/:orgId/purge',
    callers: ['platform'],
    auth: CASCADE_LEG_AUTH,
    params: CascadeOrgParams,
    response: OrgPurgeResponse,
  }),
  /**
   * Re-encrypt runner signing keys under the CURRENT key provider.
   *
   *  - No `orgId`: every non-retired row (after a SECRET_ENCRYPTION_KEY rotation;
   *    each row is decrypted with the current provider, falling back to
   *    SECRET_ENCRYPTION_KEY_PREVIOUS as `decryptSecret` does).
   *  - `orgId`: that org's rows only (after its per-org KMS config changed).
   *    `previousKmsConfig` is the config the rows were written under (null =
   *    the shared provider); the service drops its cached KMS config for the
   *    org first, so the new config is read fresh for the re-encrypt.
   *
   * Each row is rewritten in its own transaction; the org's key-cache entry is
   * invalidated (pub/sub) after. Idempotent. 200 even with failures (an
   * unreadable row stays as it was and is reported); 500 only when the job
   * could not run. Never returns or logs key material.
   */
  reencryptRunnerSigningKeys: defineInternalEndpoint({
    id: 'pipeline.reencryptRunnerSigningKeys',
    service: 'pipeline',
    method: 'POST',
    path: '/pipelines/internal/runner-signing-keys/reencrypt',
    callers: ['platform'],
    auth: 'Service token from platform (system-org member); the caller is authorized by its key-bound service name. '
      + 'Runs under a sysadmin tenant context.',
    params: z.object({}),
    body: z.object({
      orgId: z.string({ error: ORG_ID_MESSAGE }).regex(ORG_ID, ORG_ID_MESSAGE).transform((s) => s.toLowerCase()).optional(),
      previousKmsConfig: PerOrgKmsConfigSchema.nullable().optional(),
    }).strict(),
    response: z.object({
      scanned: z.number().int().nonnegative(),
      reencrypted: z.number().int().nonnegative(),
      failures: z.array(z.object({ orgId: z.string(), kid: z.string(), error: z.string() })),
    }),
  }),
  /**
   * Stage 3 of a nightly plugin CVE remediation: start (idempotently, keyed by
   * `remediationId`) the staged rollout of a published fix version. The
   * pipeline service owns the rollout: it resolves each pipeline's effective
   * mode (resolveRemediationRollout: pipeline, then team, then root; re-read
   * before each wave and before each move), opens proposals (propose), change
   * requests (approval-gated installs) or moves pipelines in waves (apply:
   * canary of up to 5, then batches of 50) through the same code path as
   * `POST /pipelines/plugin-upgrades/apply`, redeploys through the org's runner,
   * and rolls a pipeline back on a failed run of a step using the new version
   * within 24 h. It reports progress back with PLUGIN_INTERNAL.reportRemediationRollout.
   *
   * `orgId` null = an Official (system-org) fix published to its listing:
   * every org's pipelines using `publisher/plugin` are in scope. A repeat call
   * for the same remediation answers the existing rollout (`created: false`).
   * A call with a different `toVersion` for the same remediation (the owner's
   * own clean version superseding the fix) supersedes the open proposals.
   */
  startRemediationRollout: defineInternalEndpoint({
    id: 'pipeline.startRemediationRollout',
    service: 'pipeline',
    method: 'POST',
    path: '/pipelines/internal/plugin-remediations/:remediationId/rollout',
    callers: ['plugin'],
    auth: REMEDIATION_AUTH,
    params: RemediationParams,
    body: z.object({
      orgId: z.string().regex(ORG_ID, ORG_ID_MESSAGE).transform((s) => s.toLowerCase()).nullable(),
      plugin: z.string().min(1).max(255),
      /** The listing publisher handle for a listed plugin; null for an org's own plugin. */
      publisher: z.string().min(1).max(64).nullable(),
      fromVersion: z.string().regex(VERSION),
      toVersion: z.string().regex(VERSION),
      toPluginId: z.string().uuid(),
      /** Advisory ids the fix clears (proposal and notice copy). */
      advisoryIds: z.array(z.string().min(1).max(64)).max(500),
      criticalCleared: z.number().int().nonnegative(),
      highCleared: z.number().int().nonnegative(),
      /** A cleared finding is KEV-listed (the opted-out pipeline banner names it). */
      kev: z.boolean(),
    }).strict(),
    response: z.object({
      remediationId: z.string(),
      created: z.boolean(),
      /** The root/org default at start, for the summary. */
      orgDefault: z.enum(PLUGIN_REMEDIATION_ROLLOUTS).nullable(),
      counts: RolloutCounts,
    }),
  }),
  /**
   * Stop a remediation's rollout: the version or the name was deleted, or the
   * remediation cancelled. Queued moves are dropped and open proposals marked
   * superseded; moved pipelines stay where they are. Idempotent (an unknown
   * remediation answers `{ cancelled: false }`).
   */
  cancelRemediationRollout: defineInternalEndpoint({
    id: 'pipeline.cancelRemediationRollout',
    service: 'pipeline',
    method: 'POST',
    path: '/pipelines/internal/plugin-remediations/:remediationId/cancel',
    callers: ['plugin'],
    auth: REMEDIATION_AUTH,
    params: RemediationParams,
    body: z.object({ reason: z.enum(['version_deleted', 'name_deleted', 'cancelled']) }).strict(),
    response: z.object({ remediationId: z.string(), cancelled: z.boolean() }),
  }),
  /**
   * Register deployed pipelines on their FIRST pipeline event. Reporting's
   * event ingest calls this for the `pb.pipeline-id`-tagged CodePipeline
   * events it would otherwise skip as unregistered, then ingests them.
   *
   * A pipeline registers only when its row exists, is NOT soft-deleted, and
   * belongs to one of `allowedOrgIds` — the orgs the ingest credential was
   * authenticated for (the same allow-list the ingest's foreign-org check
   * uses). Names are derived as a CLI deploy derives them
   * (pipeline-core `deployedPipelineNames`); `region` is the event's.
   * Insert-if-absent: an existing row is never overwritten (a CLI
   * registration keeps its manifest and region), and concurrent calls insert
   * once and audit once (`pipeline.registry.register`, actor `system`,
   * `details.source: 'first-event'`).
   *
   * `registered` lists every requested pipeline that now has a registry row in
   * its own (allowed) org — inserted by this call or already there. Anything
   * else (unknown, deleted, another org's, registered to another org) is
   * simply absent: the caller keeps skipping those events.
   */
  registerFromFirstEvent: defineInternalEndpoint({
    id: 'pipeline.registerFromFirstEvent',
    service: 'pipeline',
    method: 'POST',
    path: '/pipelines/internal/registry/first-event',
    callers: ['reporting'],
    auth: 'reporting service token (system org); the caller is authorized by its key-bound service name. Runs under a sysadmin '
      + 'tenant context for the pipeline lookup and under each pipeline\'s own org for the registry write; a pipeline outside '
      + '`allowedOrgIds`, soft-deleted, or already registered to another org is never registered.',
    params: z.object({}),
    body: z.object({
      allowedOrgIds: z.array(z.string().min(1).max(64).transform((s) => s.toLowerCase())).min(1).max(MAX_FIRST_EVENT_ORGS),
      pipelines: z.array(z.object({
        pipelineId: z.string().uuid(),
        region: z.string().min(1).max(30).optional(),
      }).strict()).min(1).max(MAX_FIRST_EVENT_PIPELINES),
    }).strict(),
    response: z.object({
      registered: z.array(z.string()),
    }),
  }),
} as const;
