/**
 * Feature #9: Starter rule templates for new orgs.
 * These are org-scoped rule suggestions (not published rules) that orgs can
 * opt into during onboarding. Each template creates an org-scoped rule.
 */

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  target: 'plugin' | 'pipeline';
  severity: 'warning' | 'error' | 'critical';
  field: string;
  operator: string;
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
    description: 'Block plugins using the "latest" Docker image tag',
    target: 'plugin',
    severity: 'error',
    field: 'imageTag',
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
    field: 'name',
    operator: 'regex',
    value: '^[a-z][a-z0-9-]{2,63}$',
    priority: 20,
    tags: ['naming', 'convention'],
    category: 'convention',
  },
  {
    id: 'tpl-max-timeout',
    name: 'max-pipeline-timeout',
    description: 'Limit pipeline timeout to 120 minutes to prevent runaway builds',
    target: 'pipeline',
    severity: 'error',
    field: 'timeoutInMinutes',
    operator: 'lte',
    value: 120,
    priority: 70,
    tags: ['cost', 'reliability'],
    category: 'cost',
  },
];
