// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { BaseFilterSchema, BooleanQuerySchema, VisibilitySchema, CatalogMetadataShape } from './common-schemas.js';
import { PUBLISHER_HANDLE_PATTERN } from '../types/ecosystem.js';
import { PIPELINE_REMEDIATION_ELECTIONS } from '../types/plugin-remediation.js';
import { isReservedTagKey, RESERVED_TAG_KEYS, RESERVED_TAG_PREFIXES } from '../types/reserved-tags.js';

/**
 * Pipeline filter schema for query parameters
 */
export const PipelineFilterSchema = BaseFilterSchema.extend({
  project: z.string().min(1).optional(),
  organization: z.string().min(1).optional(),
  pipelineName: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
  keyword: z.string().min(1).optional(),
});

/**
 * Keys that look like plugin-reference fields but aren't: synth never reads
 * them, so without a loud refusal the reference silently resolves to something
 * other than what its author meant.
 */
const PLUGIN_REF_NON_FIELDS: Record<string, string> = {
  version:
    '`version` is not a plugin-reference field — it is ignored and the default version is used. '
    + 'Pin or range the version with `filter: { version: "1.2.3" }` (also ^, ~, 1.x, 1.2, latest).',
};

/**
 * A managed toolchain RELEASE version: plain `MAJOR.MINOR.PATCH` — a managed name refuses prerelease uploads,
 * so a release is never a range or a prerelease.
 */
export const TOOLCHAIN_RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * A pipeline's toolchain release pin: `{ release: "1.4.2" }` pins BOTH
 * halves of one release (`pipeline-bootstrap` + `cdk-synth`). Omitted = the
 * org default, canary or platform default. Eligibility is checked by the
 * pipeline service when the pin changes, not here. Never carried by a pipeline
 * TEMPLATE.
 */
export const PipelineToolchainPinSchema = z.object({
  release: z.string().regex(TOOLCHAIN_RELEASE_VERSION_PATTERN, 'toolchain.release must be a release version (MAJOR.MINOR.PATCH, e.g. 1.4.2)'),
}).strict();

/**
 * Plugin options schema (name-based selection)
 */
const PluginOptionsSchema = z.object({
  name: z.string().min(1),
  /**
   * The publisher whose installed listing the reference resolves to
   * (docs/plugin-publishing.md). Absent: the org's own plugin, then
   * its parent's, then the Official listing.
   */
  publisher: z.string().max(39).regex(PUBLISHER_HANDLE_PATTERN, 'publisher must be a publisher handle (lowercase letters, digits and single hyphens)').optional(),
  alias: z.string().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough().superRefine((ref, ctx) => {
  for (const [key, message] of Object.entries(PLUGIN_REF_NON_FIELDS)) {
    if (key in (ref as Record<string, unknown>)) {
      ctx.addIssue({ code: 'custom', path: [key], message });
    }
  }
});

/**
 * Stage step schema
 *
 * `passthrough()` keeps forward-compatible fields, but a few common mistakes are
 * rejected loudly rather than silently ignored at synth — most notably a
 * top-level `commands`, which is NOT a step field (the plugin's own commands run)
 * and would otherwise do nothing.
 */
const STEP_NON_FIELDS: Record<string, string> = {
  commands:
    '`commands` is not a step field — it is ignored at synth (the plugin\'s own commands run). '
    + 'To change what a step runs, use a plugin env knob (e.g. `metadata.GRADLE_TASK`), '
    + '`preCommands`/`postCommands` to add commands around the plugin\'s, or the '
    + '`aws:cdk:pipelines:codebuildstep:commands` metadata key for a full override.',
};

const StageStepSchema = z.object({
  plugin: PluginOptionsSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
  network: z.record(z.string(), z.unknown()).optional(),
  position: z.enum(['pre', 'post']).optional(),
}).passthrough().superRefine((step, ctx) => {
  for (const [key, message] of Object.entries(STEP_NON_FIELDS)) {
    if (key in (step as Record<string, unknown>)) {
      ctx.addIssue({ code: 'custom', path: [key], message });
    }
  }
});

/**
 * Stage schema. `passthrough()` like its siblings: a strict-by-default object
 * here stripped every undeclared stage field before storage — including
 * `environment`, which marks a stage as a DORA deploy.
 */
const StageSchema = z.object({
  stageName: z.string().min(1),
  alias: z.string().optional(),
  /** Deploy environment this stage targets (DORA deploy attribution, `pb.deploys`). */
  environment: z.string().min(1).max(64).optional(),
  steps: z.array(StageStepSchema).min(1),
}).passthrough();

// ---------------------------------------------------------------------------
// IAM role configuration (pipeline-core `RoleConfig`, core/role-types.ts)
// ---------------------------------------------------------------------------

/**
 * AWS-managed policies that grant administrator-equivalent reach. Attaching one
 * to a tenant-defined role turns "a pipeline that deploys my app" into "a
 * principal that can do anything in the account" — including minting more of
 * itself (IAMFullAccess is admin by one CreatePolicy away).
 */
export const BROAD_AWS_MANAGED_POLICY_NAMES = ['AdministratorAccess', 'PowerUserAccess', 'IAMFullAccess'] as const;

const BROAD_MANAGED_POLICY_ARN = new RegExp(
  `^arn:[^:]+:iam::aws:policy/(?:[^/]+/)*(?:${BROAD_AWS_MANAGED_POLICY_NAMES.join('|')})$`,
);

/** One reason a role's permissions are too broad, with the path to the offending value. */
export interface BroadPermissionIssue {
  path: (string | number)[];
  message: string;
}

/** The permission-bearing part of a role's options (pipeline-core `OidcRoleOptions`). */
export interface RolePermissionOptions {
  readonly policyStatements?: ReadonlyArray<{ readonly effect?: string; readonly actions: readonly string[]; readonly resources: readonly string[] }>;
  readonly managedPolicyArns?: readonly string[];
}

/**
 * Find admin-equivalent grants in a role's permissions. Pure, so the API schema
 * and pipeline-core's synth-time check (core/role.ts) apply the SAME rule:
 *
 *  - an Allow statement whose action is `*` or `*:*` (any resource);
 *  - an Allow statement with a service-wide action (`<svc>:*`) on resource `*`;
 *  - a managed policy ARN naming {@link BROAD_AWS_MANAGED_POLICY_NAMES}.
 *
 * Deny statements are never broad — a wide Deny narrows. Callers skip this when
 * the role sets `allowBroadPermissions: true` explicitly.
 */
export function findBroadRolePermissions(options: RolePermissionOptions): BroadPermissionIssue[] {
  const issues: BroadPermissionIssue[] = [];
  (options.policyStatements ?? []).forEach((stmt, i) => {
    if (stmt.effect === 'Deny') return;
    const anyResource = stmt.resources.some((r) => r.trim() === '*');
    stmt.actions.forEach((raw, j) => {
      const action = raw.trim();
      if (action === '*' || action === '*:*') {
        issues.push({ path: ['policyStatements', i, 'actions', j], message: `Action '${action}' grants every AWS action` });
      } else if (anyResource && /^[A-Za-z0-9-]+:\*$/.test(action)) {
        issues.push({ path: ['policyStatements', i, 'actions', j], message: `Action '${action}' on Resource '*' grants the whole service account-wide` });
      }
    });
  });
  (options.managedPolicyArns ?? []).forEach((arn, i) => {
    if (BROAD_MANAGED_POLICY_ARN.test(arn.trim())) {
      issues.push({ path: ['managedPolicyArns', i], message: `Managed policy ${arn} grants administrator-equivalent access` });
    }
  });
  return issues;
}

/** The message every broad-permission refusal carries, so callers learn the escape hatch. */
export const BROAD_PERMISSIONS_HINT =
  'Scope the actions and resources to what the pipeline needs, or set `allowBroadPermissions: true` '
  + 'on the role options to accept the risk explicitly.';

const RoleMutableSchema = z.boolean().optional();

const RoleArnConfigSchema = z.object({
  type: z.literal('roleArn'),
  options: z.object({
    roleArn: z.string().min(1).max(2048),
    mutable: RoleMutableSchema,
  }).strict(),
}).strict();

const RoleNameConfigSchema = z.object({
  type: z.literal('roleName'),
  options: z.object({
    roleName: z.string().min(1).max(64),
    mutable: RoleMutableSchema,
  }).strict(),
}).strict();

const CodeBuildDefaultRoleConfigSchema = z.object({
  type: z.literal('codeBuildDefault'),
  options: z.object({
    roleName: z.string().min(1).max(64).optional(),
  }).strict().default({}),
}).strict();

const ConditionMapSchema = z.record(z.string().min(1), z.union([z.string(), z.array(z.string())]));

/**
 * An inline policy statement (pipeline-core `OidcPolicyStatement`). Strict:
 * `NotAction`, `NotResource` and `Condition` are not supported by the role
 * builder, and silently dropping a `NotAction` would turn an allow-list into
 * something else entirely.
 */
const OidcPolicyStatementSchema = z.object({
  effect: z.enum(['Allow', 'Deny']).optional(),
  actions: z.array(z.string().min(1)).min(1),
  resources: z.array(z.string().min(1)).min(1),
}).strict();

const isWildcardOnly = (value: string | string[]): boolean => {
  const values = Array.isArray(value) ? value : [value];
  return values.length === 0 || values.every((v) => /^\*+$/.test(v.trim()));
};

const OidcRoleConfigSchema = z.object({
  type: z.literal('oidc'),
  options: z.object({
    providerArn: z.string().min(1).optional(),
    issuer: z.string().url().optional(),
    clientIds: z.array(z.string().min(1)).optional(),
    thumbprints: z.array(z.string().min(1)).optional(),
    conditions: ConditionMapSchema.optional(),
    conditionsLike: ConditionMapSchema.optional(),
    roleName: z.string().min(1).max(64).optional(),
    description: z.string().max(1000).optional(),
    maxSessionDuration: z.number().int().min(3600).max(43200).optional(),
    permissionsBoundaryArn: z.string().min(1).optional(),
    managedPolicyArns: z.array(z.string().min(1)).optional(),
    policyStatements: z.array(OidcPolicyStatementSchema).optional(),
    /** Accept admin-equivalent grants (see {@link findBroadRolePermissions}). Must be `true` literally. */
    allowBroadPermissions: z.boolean().optional(),
  }).strict().superRefine((opts, ctx) => {
    if (opts.providerArn && opts.issuer) {
      ctx.addIssue({ code: 'custom', path: ['issuer'], message: 'Specify either providerArn or issuer, not both' });
    } else if (!opts.providerArn && !opts.issuer) {
      ctx.addIssue({ code: 'custom', path: ['providerArn'], message: 'OIDC role requires either providerArn or issuer' });
    }
    // Same fail-closed rule as pipeline-core's trust builder: an OIDC trust with
    // no scoped subject lets ANY identity the issuer serves assume the role.
    const subs = [...Object.entries(opts.conditions ?? {}), ...Object.entries(opts.conditionsLike ?? {})]
      .filter(([key]) => key.endsWith(':sub'));
    if (subs.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['conditions'],
        message: "OIDC role must restrict the token subject with a '<issuer-host>:sub' condition "
          + "(e.g. 'token.actions.githubusercontent.com:sub': 'repo:acme/app:ref:refs/heads/main')",
      });
    } else if (subs.every(([, v]) => isWildcardOnly(v))) {
      ctx.addIssue({ code: 'custom', path: ['conditions'], message: "OIDC ':sub' condition must not be a bare '*' wildcard" });
    }
    if (opts.allowBroadPermissions !== true) {
      for (const issue of findBroadRolePermissions(opts)) {
        ctx.addIssue({ code: 'custom', path: issue.path, message: `${issue.message}. ${BROAD_PERMISSIONS_HINT}` });
      }
    }
  }),
}).strict();

/**
 * The pipeline-level IAM role (pipeline-core `RoleConfig`): an existing role by
 * ARN or name, a CodeBuild default role, or an OIDC-federated role. Validated
 * here rather than passed through, because a tenant-supplied role is IAM the
 * platform deploys into the tenant's account.
 */
export const RoleConfigSchema = z.discriminatedUnion('type', [
  RoleArnConfigSchema,
  RoleNameConfigSchema,
  CodeBuildDefaultRoleConfigSchema,
  OidcRoleConfigSchema,
]);

/**
 * BuilderProps schema — structural validation for pipeline configuration.
 * Uses passthrough() to allow additional fields without rejecting them.
 */
const BuilderPropsSchema = z.object({
  project: z.string().min(1),
  organization: z.string().min(1),
  pipelineName: z.string().optional(),
  global: z.record(z.string(), z.unknown()).optional(),
  defaults: z.record(z.string(), z.unknown()).optional(),
  role: RoleConfigSchema.optional(),
  /**
   * Cost-allocation tags applied to the pipeline's stack. Reserved keys are
   * refused rather than dropped, so a caller learns which key it may not set;
   * `PipelineBuilder` drops them again at synth for callers that bypass the API.
   */
  tags: z.record(z.string(), z.string()).optional(),
  synth: z.object({
    source: z.record(z.string(), z.unknown()).optional(),
    plugin: PluginOptionsSchema,
  }).passthrough(),
  stages: z.array(StageSchema).optional(),
  /** Toolchain release pin (see {@link PipelineToolchainPinSchema}). */
  toolchain: PipelineToolchainPinSchema.optional(),
}).passthrough().superRefine((props, ctx) => {
  for (const key of Object.keys((props as { tags?: Record<string, string> }).tags ?? {})) {
    if (!isReservedTagKey(key)) continue;
    ctx.addIssue({
      code: 'custom',
      path: ['tags', key],
      message:
        `\`${key}\` is a reserved tag key and cannot be set. Reserved: `
        + `${RESERVED_TAG_KEYS.join(', ')}, and anything starting with `
        + `${RESERVED_TAG_PREFIXES.join(' or ')}. These carry pipeline tenancy and `
        + 'deploy attribution, so the platform owns them.',
    });
  }
});

/**
 * Pipeline creation schema
 */
export const PipelineCreateSchema = z.object({
  ...CatalogMetadataShape,
  project: z.string().min(1, 'Project is required'),
  organization: z.string().min(1, 'Organization is required'),
  pipelineName: z.string().min(1).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  visibility: VisibilitySchema.optional(),
  /**
   * Create the pipeline paused. Declared here because it used to be stripped:
   * the schema is strict-by-default, so the CLI's `--no-active` was silently
   * dropped and every pipeline came up active.
   *
   * There is no `isDefault` counterpart. `pipeline_project_org_unique` allows
   * exactly one pipeline per (project, organization, org), so the row created in
   * a slot IS that slot's default — a `false` could not be honoured.
   */
  isActive: BooleanQuerySchema.optional(),
  props: BuilderPropsSchema,
});

/**
 * Pipeline update schema
 */
export const PipelineUpdateSchema = z.object({
  ...CatalogMetadataShape,
  pipelineName: z.string().min(1).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  props: BuilderPropsSchema.optional(),
  isActive: BooleanQuerySchema.optional(),
  isDefault: BooleanQuerySchema.optional(),
  visibility: VisibilitySchema.optional(),
  /**
   * The pipeline's plugin security fixes election (pipelines.remediation_upgrades).
   * The route refuses `apply` with 403 PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED
   * when the root org disallows it (pipelineElectionAllowed) and audits
   * pipeline.remediation-upgrades.update with before / after.
   */
  remediationUpgrades: z.enum(PIPELINE_REMEDIATION_ELECTIONS).optional(),
});
