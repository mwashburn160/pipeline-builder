// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Starter rule templates for new orgs.
 * These are org-scoped rule suggestions (not published rules) that orgs can
 * opt into during onboarding. Each template creates an org-scoped rule.
 */

import type { RuleOperator, RuleSeverity, RuleTarget } from '@pipeline-builder/pipeline-data';

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  target: RuleTarget;
  /**
   * The stored rule's severity/operator types, NOT widened copies. A template
   * is inserted verbatim as a rule, so anything the schema won't accept is a
   * template that silently fails to apply at runtime — a widened `string` (plus
   * an `as unknown as` at the apply site) would hide exactly that, including any
   * later rename of an operator.
   */
  severity: RuleSeverity;
  field: string;
  operator: RuleOperator;
  value?: unknown;
  priority: number;
  tags: string[];
  category: string;
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'tpl-require-description',
    name: 'require-description',
    description: 'Require all plugins to have a non-empty description',
    target: 'plugin',
    severity: 'warning',
    field: 'description',
    operator: 'exists',
    priority: 10,
    tags: ['quality', 'documentation'],
    category: 'quality',
  },
  {
    id: 'tpl-block-latest-tag',
    name: 'block-latest-tag',
    description: 'Block plugins whose version is the literal string "latest" (mutable tag)',
    target: 'plugin',
    severity: 'error',
    field: 'version',
    operator: 'neq',
    value: 'latest',
    priority: 90,
    tags: ['security', 'docker'],
    category: 'security',
  },
  {
    id: 'tpl-enforce-semver',
    name: 'enforce-semver',
    description: 'Require plugin versions to follow semantic versioning (MAJOR.MINOR.PATCH)',
    target: 'plugin',
    severity: 'error',
    field: 'version',
    operator: 'regex',
    value: '^\\d+\\.\\d+\\.\\d+$',
    priority: 50,
    tags: ['versioning', 'quality'],
    category: 'quality',
  },
  {
    id: 'tpl-pipeline-naming',
    name: 'pipeline-naming-convention',
    description: 'Enforce lowercase alphanumeric pipeline names with hyphens',
    target: 'pipeline',
    severity: 'warning',
    // `pipelineName`, the actual column. The entity handed to the engine is the
    // row's own keys (`toComplianceAttributes` only redacts secrets, it never
    // renames), and a pipeline row has no `name` — so this matched `undefined`
    // on every pipeline and warned about all of them.
    field: 'pipelineName',
    operator: 'regex',
    value: '^[a-z][a-z0-9-]{2,63}$',
    priority: 20,
    tags: ['naming', 'convention'],
    category: 'convention',
  },
  // REMOVED: `max-pipeline-timeout`, which asserted `timeoutInMinutes <= 120`.
  // No such field exists — not on the pipeline row, not in `props`. `timeout` is
  // a per-STEP metadata passthrough key (see metadata-builder), never a
  // pipeline-level value, so there is nothing for this rule to read. It matched
  // `undefined` at `error` severity, which meant applying this starter template
  // blocked EVERY pipeline in the org. Re-add it if a pipeline-level timeout
  // ever exists; there is no field to point it at today.
];
