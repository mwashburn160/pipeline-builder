// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The image digests an org's `org-<id>/*` namespace still needs, from the plugin
 * service (`GET /internal/plugins/image-references?orgId=`): every plugin row's
 * digest — active, inactive or soft-deleted — and every digest a pipeline of the
 * org or its teams declares, runs, or has an open deployed exposure on.
 *
 * The age GC consults it before deleting anything: a referenced image is never
 * deleted, whatever its age (a pipeline would fail its next pull — and a
 * VULNERABLE image is the worst one to take away; vulnerability state is graded
 * and notified, never removed). It FAILS SAFE: when the set cannot be read, the
 * caller deletes nothing in that namespace for the pass. Not cached: one read per
 * namespace per GC pass.
 *
 * The manual purge (`DELETE /api/images/...`) asks the narrower, NAMED question
 * — which pipelines reference these digests (`GET
 * /internal/plugins/image-pipeline-references`) — so its 409 can say what to
 * update first. Same rule, same fail-safe: unreadable means nothing is deleted.
 */

import {
  callInternal,
  getServiceAuthHeader,
  InternalHttpClient,
  MAX_REFERENCE_DIGESTS,
  PLUGIN_INTERNAL,
  serviceEndpoint,
  SYSTEM_ORG_ID,
  type ContractResponse,
  type InternalCallResult,
} from '@pipeline-builder/api-core';

/** The service token both reads carry (system-org member: the plugin routes are elevated reads). */
const authHeaders = () => ({ Authorization: getServiceAuthHeader({ serviceName: 'image-registry', orgId: SYSTEM_ORG_ID, role: 'member' }) });

/** The reply's data, or the same errors the hand-parsed reads threw. */
function dataOr<T>(res: InternalCallResult<T>, what: string): T {
  if (res.ok) return res.data;
  if (res.reason === 'invalid-response') throw new Error(`plugin service answered without a ${what} list`);
  throw new Error(`plugin service answered HTTP ${res.reason === 'status' ? res.status : 'unreachable'}`);
}

type Fetcher = (orgId: string) => Promise<string[]>;

const liveFetcher: Fetcher = async (orgId) => {
  const client = new InternalHttpClient(serviceEndpoint('plugin'));
  const res = await callInternal(client, PLUGIN_INTERNAL.orgImageReferences, { query: { orgId }, options: { headers: authHeaders() } });
  return dataOr(res, 'digests').digests;
};

let fetcher: Fetcher = liveFetcher;

/** Test hook: replace the plugin-service read (pass nothing to restore it). */
export function setPluginImageReferencesFetcherForTests(f?: Fetcher): void {
  fetcher = f ?? liveFetcher;
}

/** The digests `orgId`'s namespace still needs. THROWS when they cannot be read — the caller must then delete nothing. */
export async function pluginImageReferences(orgId: string): Promise<ReadonlySet<string>> {
  return new Set(await fetcher(orgId));
}

/**
 * The pipelines still referencing one image digest (the plugin service's
 * `findVersionReferences`). `pipelineCount` is exact; `pipelines` names at
 * most the first 50.
 */
export type ImagePipelineReference = ContractResponse<typeof PLUGIN_INTERNAL.imagePipelineReferences>['references'][number];

type PipelineReferenceFetcher = (digests: string[]) => Promise<ImagePipelineReference[]>;

/** Digests per read — the plugin route's own cap. */
const REFERENCE_CHUNK = MAX_REFERENCE_DIGESTS;

const livePipelineReferenceFetcher: PipelineReferenceFetcher = async (digests) => {
  const client = new InternalHttpClient(serviceEndpoint('plugin'));
  const res = await callInternal(client, PLUGIN_INTERNAL.imagePipelineReferences, {
    query: { digests: digests.join(',') },
    options: { headers: authHeaders() },
  });
  return dataOr(res, 'references').references;
};

let pipelineReferenceFetcher: PipelineReferenceFetcher = livePipelineReferenceFetcher;

/** Test hook: replace the plugin-service read (pass nothing to restore it). */
export function setPipelineReferencesFetcherForTests(f?: PipelineReferenceFetcher): void {
  pipelineReferenceFetcher = f ?? livePipelineReferenceFetcher;
}

/**
 * The digests among `digests` that some pipeline still references, with the
 * pipelines — what a manual purge must refuse on. THROWS when the answer cannot
 * be read: the caller must then delete nothing (an unknown answer is never "free").
 */
export async function pipelinesReferencingImages(digests: Iterable<string>): Promise<ImagePipelineReference[]> {
  const all = [...new Set(digests)];
  const out: ImagePipelineReference[] = [];
  for (let i = 0; i < all.length; i += REFERENCE_CHUNK) {
    out.push(...await pipelineReferenceFetcher(all.slice(i, i + REFERENCE_CHUNK)));
  }
  return out;
}
