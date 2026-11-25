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

/** CloudFormation's stack-name rule (the same pattern aws-cdk-lib's `Stack` enforces). */
const STACK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
/** CloudFormation's stack-name length limit. */
const STACK_NAME_MAX_LENGTH = 128;
/** Leading letter for a derived name whose first character is not one (`2fa-app` → `pb-2fa-app-…`). */
const STACK_NAME_LETTER_PREFIX = 'pb-';

/**
 * The CloudFormation stack name a pipeline deploys as, derived from its
 * `project` and `organization` and always satisfying CloudFormation's naming
 * standard: starts with a letter, holds only letters, digits and hyphens, and
 * is at most 128 characters.
 *
 * - A pair whose plain derivation — `<project>-<organization>`, lowercased —
 *   already satisfies the standard, and whose organization holds no hyphen (so
 *   the name splits back into one pair only), keeps exactly that name
 *   (`spring-boot` / `system` → `spring-boot-system`).
 * - Any other pair is rewritten to conform: each disallowed character (`_`
 *   included: `spring_boot` / `system` → `spring-boot-system-<hash>`) becomes
 *   `-`, a leading non-letter gets `pb-`, and the base is truncated so that
 *   `-<hash>` of the RAW pair (`pipelineIdentityDigest`) still fits. The hash
 *   keeps rewritten names distinct from each other and from every plain name
 *   (`my.app` / `acme` → `my-app-acme-<hash>`, never `my-app-acme`).
 *
 * Shared by the CLI's synth app (`boilerplate.ts`, which names the stack), its
 * registry payload (`utils/registry.ts`, which records it) and the pipeline
 * service's first-event self-registration, so the deployed stack and its
 * registry record always agree. Only the derived name changes;
 * the project and organization values are kept as they are everywhere else.
 *
 * Throws only when project or organization is empty — there is nothing to
 * name the stack after.
 */
export function pipelineStackName(project: string, organization: string): string {
  if (!project.trim() || !organization.trim()) {
    throw new Error(
      `Cannot derive a stack name from project '${project}' and organization '${organization}': both are required.`,
    );
  }
  const plain = `${project}-${organization}`.toLowerCase();
  // Plain only when it reads back one way: the pair splits at the LAST hyphen,
  // so the organization must hold none (`a-b` / `c` and `a` / `b-c` would
  // otherwise both be `a-b-c`, one deploy replacing the other's stack).
  if (!organization.includes('-') && plain.length <= STACK_NAME_MAX_LENGTH && STACK_NAME_PATTERN.test(plain)) return plain;

  let base = plain.replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z]/.test(base)) base = `${STACK_NAME_LETTER_PREFIX}${base}`;
  const suffix = `-${pipelineIdentityDigest(project, organization)}`;
  base = base.slice(0, STACK_NAME_MAX_LENGTH - suffix.length).replace(/-+$/, '');
  return `${base}${suffix}`;
}
