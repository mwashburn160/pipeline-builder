// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a CodePipeline's `pb.pipeline-id` tag — the proof that a pipeline IS
 * a given platform pipeline. Shared by the runner Lambda (its hint fallback)
 * and `pipeline run` / `pipeline stop` (the operator's own credentials), so both
 * prove identity the same way. Lambda-safe: only `@aws-sdk/*` and the
 * dependency-free contract catalog, which the bundler inlines.
 */

import { ListTagsForResourceCommand } from '@aws-sdk/client-codepipeline';
import { PIPELINE_ID_TAG } from '@pipeline-builder/api-core/pipeline-runners';

/** Anything with an AWS SDK v3 `send`. */
export interface Sender { send(command: unknown): Promise<unknown> }

/**
 * The pipeline's `pb.pipeline-id` tag value (every page of its tags), or
 * undefined when it carries none. AWS errors (e.g. ResourceNotFoundException)
 * propagate to the caller.
 */
export async function readPipelineIdTag(cp: Sender, resourceArn: string): Promise<string | undefined> {
  let nextToken: string | undefined;
  do {
    const out = await cp.send(new ListTagsForResourceCommand({ resourceArn, ...(nextToken ? { nextToken } : {}) })) as {
      tags?: Array<{ key?: string; value?: string }>; nextToken?: string;
    };
    const tag = (out.tags ?? []).find((t) => t.key === PIPELINE_ID_TAG);
    if (tag) return tag.value ?? '';
    nextToken = out.nextToken || undefined;
  } while (nextToken);
  return undefined;
}
