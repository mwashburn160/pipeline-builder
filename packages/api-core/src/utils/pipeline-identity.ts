// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';

/**
 * Characters a (project, organization) name may hold and still derive its
 * pipeline and stack names WITHOUT a disambiguating hash: letters, digits and
 * hyphens. Within that set the derivation loses only case, and names are
 * case-insensitive by design (the hash lowercases too). Every other character
 * — `_` included, since the stack name maps it to `-` and the pipeline name
 * maps `-` to `_` — gets the hash, so `spring_boot` and `spring-boot` never
 * share a CodePipeline or a CloudFormation stack.
 */
const CLEAN_NAME = /^[A-Za-z0-9-]*$/;

/**
 * A short stable hash of the RAW (project, organization) pair — or `null`
 * when both are clean (see {@link CLEAN_NAME}).
 *
 * The derived names are lossy: the pipeline name maps every non-alphanumeric
 * character to `_` and the stack name maps `_` to `-`, so `my.app` and `my_app`
 * would share one CodePipeline and one CloudFormation stack, each deploy
 * overwriting the other. A pair holding a character outside the clean set
 * gets this hash appended, so it can never collide with a clean name. The pair is hashed as a JSON array (not joined with a character
 * either part may contain), lowercased because every derived name is.
 */
export function pipelineIdentityHash(project: string, organization: string): string | null {
  if (CLEAN_NAME.test(project) && CLEAN_NAME.test(organization)) return null;
  return pipelineIdentityDigest(project, organization);
}

/**
 * The 8-hex digest {@link pipelineIdentityHash} appends, computed
 * unconditionally — for a derivation that must disambiguate even a clean
 * pair (e.g. a stack name truncated to satisfy CloudFormation).
 */
export function pipelineIdentityDigest(project: string, organization: string): string {
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
