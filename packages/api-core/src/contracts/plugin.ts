// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY plugin (router mounted at `/internal`, behind
 * `requireAuth`). All three are image-registry's reads of plugin facts it
 * cannot know: which of an org's plugins are public, which digests its
 * namespace still needs, and which pipelines reference given digests. Plus
 * platform's two cascade legs (its durable outbox): an org's plugin rows
 * purged, and an erased user's listing reviews anonymized.
 */

import { z } from 'zod';
import { CASCADE_LEG_AUTH, CascadeOrgParams, CascadeUserParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';

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
} as const;
