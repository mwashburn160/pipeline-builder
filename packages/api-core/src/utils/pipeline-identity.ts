// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';

/**
 * Characters a (project, organization) name may hold and still derive its
 * pipeline and stack names WITHOUT a disambiguating hash: letters, digits and
 * hyphens. Every name deployed before the hash existed falls in this set
 * (an underscore or any other character made an invalid stack name), so a
 * clean pair keeps the names it always had.
 */
const CLEAN_NAME = /^[A-Za-z0-9-]*$/;

/**
 * A short stable hash of the RAW (project, organization) pair — or `null`
 * when both are clean (see {@link CLEAN_NAME}).
 *
 * The derived names are lossy: the pipeline name maps every non-alphanumeric
 * character to `_` and the stack name maps `_` to `-`, so `spring-boot` and
 * `spring_boot` (or `my.app` and `my_app`) would share one CodePipeline and one
 * CloudFormation stack, each deploy overwriting the other. Any pair whose
 * derivation is lossy gets this hash appended, so distinct inputs never
 * collide. The pair is hashed as a JSON array (not joined with a character
 * either part may contain), lowercased because every derived name is.
 */
export function pipelineIdentityHash(project: string, organization: string): string | null {
  if (CLEAN_NAME.test(project) && CLEAN_NAME.test(organization)) return null;
  return createHash('sha256')
    .update(JSON.stringify([project.toLowerCase(), organization.toLowerCase()]))
    .digest('hex')
    .slice(0, 8);
}

/**
 * The CodePipeline name a pipeline gets when it names none:
 * `<org>-<project>-pipeline` (non-alphanumerics -> `_`, lowercased), plus
 * `-<hash>` when that derivation is lossy ({@link pipelineIdentityHash}).
 * The ONE rule: pipeline-core's `PipelineConfiguration` and the CLI's
 * create/registry paths must derive the same name.
 */
export function defaultPipelineName(organization: string, project: string): string {
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const hash = pipelineIdentityHash(project, organization);
  return `${sanitize(organization)}-${sanitize(project)}-pipeline${hash ? `-${hash}` : ''}`;
}
