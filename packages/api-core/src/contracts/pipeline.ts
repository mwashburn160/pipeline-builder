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
 */

import { z } from 'zod';
import { CASCADE_LEG_AUTH, CascadeOrgParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';
import { PerOrgKmsConfigSchema } from './platform.js';

const ORG_ID = /^[a-f0-9]{24}$/i;
const ORG_ID_MESSAGE = 'orgId must be an organization id';

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
} as const;
