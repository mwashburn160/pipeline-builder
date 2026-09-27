// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What KIND of thing broke.
 *
 * "34 failures this week" is not actionable. "18 of them were dependency
 * resolution, and they are all in one pipeline" is. That is the whole reason this
 * exists — and it is also why the classification happens at INGEST rather than at
 * read time: error text is scrubbed of AWS identifiers at the persistence boundary
 * and eventually swept by retention, so a category derived later would have
 * nothing left to read.
 *
 * THE RULES ARE DATA. A category is a provider/action match plus an ordered list
 * of patterns over the error text, in one table below, so the taxonomy can grow
 * from real misses without touching the classifier. Anything unmatched lands in
 * `other` and is counted, so the size of `other` is the measure of how good the
 * rules are.
 *
 * THE CATEGORIES OVERLAP THE PLUGIN-BUILD TAXONOMY ON PURPOSE. A dependency
 * failure is a dependency failure whether it happened building a plugin or running
 * one; two vocabularies for the same thing would make the report and the build
 * queue disagree about the same incident.
 *
 * WHAT THE AI EVER SEES is the category, never the raw error. Error text from a
 * customer's build is the last thing that should reach a model.
 */

import type { FailureCategory } from '../../database/schema/reporting-analytics.js';

/** One classification rule: the category, and how to recognise it. */
interface Rule {
  category: FailureCategory;
  /**
   * Ordered patterns over the lowercased error text. First rule with any match
   * wins, so the table's ORDER is part of its meaning: the specific cases come
   * before the general ones.
   */
  patterns: RegExp[];
  /** When set, the rule only applies to an action/stage name matching this. */
  action?: RegExp;
}

/**
 * The rules, most specific first.
 *
 * Read this as the taxonomy itself. Each entry answers "what would somebody DO
 * about this", which is why e.g. `permissions` and `authentication` are separate:
 * one is a policy change, the other is a credential.
 */
const RULES: Rule[] = [
  // Credentials and policy first: their messages often also contain words that
  // would otherwise match `external_service` or `configuration`.
  {
    category: 'permissions',
    patterns: [
      /accessdenied/, /access denied/, /not authorized to perform/, /forbidden/,
      /explicit deny/, /assumerole.*denied/, /iam.*permission/, /insufficient privileges/,
    ],
  },
  {
    category: 'authentication',
    patterns: [
      /unauthorized/, /401/, /authentication failed/, /invalid credentials/,
      /expired token/, /token.*expired/, /no basic auth/, /bad credentials/,
      /could not be authenticated/,
    ],
  },
  {
    category: 'source_checkout',
    patterns: [
      /could not resolve host: github/, /repository not found/, /fatal: could not read/,
      /git clone.*failed/, /reference is not a tree/, /unable to access.*\.git/,
      /source.*checkout.*failed/, /codecommit.*not found/,
    ],
  },
  {
    category: 'dependency',
    patterns: [
      /npm err!.*(?:e404|etarget|eresolve)/, /could not resolve dependency/,
      /no matching version found/, /unable to resolve dependency tree/,
      /could not find a version that satisfies/, /pip.*could not find/,
      /go: .*: unknown revision/, /maven.*could not resolve dependencies/,
      /bundler.*could not find/, /cargo.*failed to select a version/,
      /peer dep/, /lockfile.*out of sync/,
    ],
  },
  {
    category: 'unit_test',
    patterns: [/tests? failed/, /assertion(?:error)? failed/, /\d+ (?:tests?|specs?) failed/, /jest.*fail/, /pytest.*failed/],
    action: /test|spec|jest|pytest|junit/i,
  },
  {
    category: 'integration_test',
    patterns: [/tests? failed/, /assertion(?:error)? failed/, /connection refused/],
    action: /integration|e2e|smoke|acceptance|contract/i,
  },
  {
    category: 'security_scan',
    patterns: [
      /vulnerabilit/, /cve-\d{4}/, /grype/, /trivy/, /sast/, /dependency check failed/,
      /secret detected/, /license violation/, /policy violation.*scan/,
    ],
  },
  {
    category: 'timeout',
    patterns: [
      /timed? ?out/, /etimedout/, /deadline exceeded/, /exceeded the.*timeout/,
      /build.*exceeded.*minutes/, /context deadline/,
    ],
  },
  {
    category: 'resource_exhaustion',
    patterns: [
      /out of memory/, /oomkilled/, /cannot allocate memory/, /no space left on device/,
      /disk quota exceeded/, /enospc/, /too many open files/, /killed.*signal 9/,
      /javascript heap out of memory/,
    ],
  },
  {
    category: 'deployment',
    patterns: [
      /cloudformation.*rollback/, /stack.*rollback_complete/, /create_failed/, /update_rollback/,
      /cdk deploy.*failed/, /ecs.*deployment.*failed/, /deployment.*circuit breaker/,
      /health check.*failed.*target group/,
    ],
  },
  {
    category: 'infrastructure',
    patterns: [
      /throttl/, /rate exceeded/, /limitexceeded/, /servicequotaexceeded/,
      /capacity/, /insufficientinstancecapacity/, /host.*unreachable/,
      /internal service error/, /5\d\d.*aws/,
    ],
  },
  {
    category: 'external_service',
    patterns: [
      /could not resolve host/, /enotfound/, /econnrefused/, /econnreset/,
      /getaddrinfo/, /socket hang up/, /bad gateway/, /502|503|504/,
      /upstream.*unavailable/, /registry.*unreachable/,
    ],
  },
  {
    category: 'configuration',
    patterns: [
      /is not defined/, /no such file or directory/, /enoent/, /invalid.*configuration/,
      /missing required.*(?:variable|parameter|input)/,
      // Both orders: "yaml parse error" and "error parsing YAML".
      /yaml.*(?:parse|parsing|syntax)/, /(?:parse|parsing|syntax).*yaml/,
      /unexpected token.*json/, /buildspec/, /command not found/,
    ],
  },
  {
    category: 'build',
    patterns: [
      /compilation (?:failed|error)/, /error ts\d+/, /syntax error/, /cannot find module/,
      /undefined reference/, /build failed/, /webpack.*error/, /tsc.*error/,
      /docker build.*failed/, /failed to solve/,
    ],
  },
];

/**
 * The category for a failed action.
 *
 * `null` for anything that is not a failure — the caller stores nothing rather
 * than labelling a success, so a category's presence always means "this broke".
 */
export function classifyFailure(input: {
  status: string;
  errorMessage?: string | null;
  actionName?: string | null;
  stageName?: string | null;
}): FailureCategory | null {
  const failed = /^(FAILED|FAILURE|ERROR|TIMED_OUT)$/i.test(input.status);
  if (!failed) return null;

  const text = (input.errorMessage ?? '').toLowerCase();
  const where = `${input.actionName ?? ''} ${input.stageName ?? ''}`;

  for (const rule of RULES) {
    if (rule.action && !rule.action.test(where)) continue;
    if (rule.patterns.some((p) => p.test(text))) return rule.category;
  }

  // Nothing matched. `other` rather than a guess, and counted, so the share of
  // `other` measures how good the rules are and names the gap to close.
  return 'other';
}

/**
 * A human label for a category, for the report and the UI.
 *
 * Phrased as what broke rather than as an enum: a manager reading
 * "Dependency resolution" understands it, and `integration_test` does not.
 */
export const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  source_checkout: 'Source checkout',
  dependency: 'Dependency resolution',
  build: 'Build / compile',
  unit_test: 'Unit tests',
  integration_test: 'Integration tests',
  security_scan: 'Security scan',
  infrastructure: 'Cloud infrastructure',
  deployment: 'Deployment',
  authentication: 'Authentication',
  permissions: 'Permissions',
  configuration: 'Configuration',
  timeout: 'Timeout',
  resource_exhaustion: 'Out of resources',
  external_service: 'External service',
  other: 'Unclassified',
};

/**
 * Whether a category is something the TEAM can act on, as opposed to something
 * that happened to them.
 *
 * Used by the failure-analysis section to separate the two, because a week whose
 * failures were all cloud throttling is a different conversation from one whose
 * failures were all broken tests — and presenting them in one ranked list invites
 * exactly the wrong conclusion.
 */
export function isTeamActionable(category: FailureCategory): boolean {
  return !['infrastructure', 'external_service'].includes(category);
}
