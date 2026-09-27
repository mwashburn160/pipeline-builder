// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The failure classifier.
 *
 * "34 failures this week" is not actionable; "18 were dependency resolution, all
 * in one pipeline" is. These tests are the taxonomy's specification: each case is
 * a real error string and the category somebody would act on.
 *
 * Two properties beyond the mapping itself:
 *
 *  - ORDER IS MEANING. Credential and policy messages routinely also contain words
 *    that would match `external_service` or `configuration`, so the specific rules
 *    come first and the tests pin that.
 *  - `other` IS COUNTED, NOT HIDDEN. An unmatched failure is labelled rather than
 *    dropped, so the share of `other` measures how good the rules are.
 */

import { describe, it, expect } from '@jest/globals';
import {
  classifyFailure,
  isTeamActionable,
  FAILURE_CATEGORY_LABELS,
} from '../src/api/reporting/failure-classifier.js';
import { FAILURE_CATEGORIES } from '../src/database/schema/reporting-analytics.js';

/** Classify a failed action from its error text. */
const of = (errorMessage: string, over: { actionName?: string; stageName?: string } = {}) =>
  classifyFailure({ status: 'FAILED', errorMessage, ...over });

describe('classifyFailure', () => {
  it('labels nothing that did not fail — a category always means "this broke"', () => {
    for (const status of ['SUCCEEDED', 'SUCCESS', 'IN_PROGRESS', 'STARTED', 'CANCELED']) {
      expect(classifyFailure({ status, errorMessage: 'npm ERR! ETARGET' })).toBeNull();
    }
  });

  it.each([
    ['FAILED'], ['FAILURE'], ['ERROR'], ['TIMED_OUT'], ['failed'],
  ])('labels a %s action', (status) => {
    expect(classifyFailure({ status, errorMessage: 'something' })).toBe('other');
  });

  // ── The taxonomy, as real messages ────────────────────────────────────────

  it.each([
    // Credentials and policy FIRST: these messages also contain words that would
    // otherwise match configuration or external_service.
    ['AccessDenied: User is not authorized to perform: s3:PutObject', 'permissions'],
    ['An explicit deny in a service control policy', 'permissions'],
    ['401 Unauthorized', 'authentication'],
    ['authentication failed: bad credentials', 'authentication'],
    ['expired token, please re-authenticate', 'authentication'],

    ['fatal: repository not found', 'source_checkout'],
    ['fatal: could not read Username for https://github.com', 'source_checkout'],

    ['npm ERR! code ETARGET  No matching version found for lodash@^99', 'dependency'],
    ['ERROR: Could not find a version that satisfies the requirement boto3', 'dependency'],
    ['maven could not resolve dependencies for project acme:web', 'dependency'],
    ['error: cargo failed to select a version for `serde`', 'dependency'],

    ['found 4 vulnerabilities, CVE-2026-1234 in openssl', 'security_scan'],
    ['grype: 2 critical findings', 'security_scan'],

    ['Error: build timed out after 60 minutes', 'timeout'],
    ['context deadline exceeded', 'timeout'],

    ['Container killed: OOMKilled', 'resource_exhaustion'],
    ['ENOSPC: no space left on device', 'resource_exhaustion'],
    ['FATAL ERROR: JavaScript heap out of memory', 'resource_exhaustion'],

    ['Stack acme-web is in UPDATE_ROLLBACK_COMPLETE', 'deployment'],
    ['ECS deployment failed: circuit breaker triggered', 'deployment'],

    ['Rate exceeded (ThrottlingException)', 'infrastructure'],
    ['InsufficientInstanceCapacity in us-east-1a', 'infrastructure'],

    ['getaddrinfo ENOTFOUND registry.internal', 'external_service'],
    ['504 Gateway Timeout from upstream', 'timeout'],
    ['socket hang up', 'external_service'],

    ['bash: line 3: terraform: command not found', 'configuration'],
    ['ENOENT: no such file or directory, open \'buildspec.yml\'', 'configuration'],
    ['error parsing YAML: did not find expected key', 'configuration'],

    ['error TS2345: Argument of type string is not assignable', 'build'],
    ['Cannot find module \'./missing\'', 'build'],
    ['failed to solve: process did not complete successfully', 'build'],
  ])('classifies %j as %s', (message, expected) => {
    expect(of(message)).toBe(expected);
  });

  /**
   * ORDER IS MEANING. An access-denied message from a registry contains
   * "registry" and "denied"; classified by the registry word it would read as an
   * external-service blip and nobody would fix the policy.
   */
  it('prefers permissions over external_service when a message says both', () => {
    expect(of('AccessDenied pulling from registry.internal: forbidden')).toBe('permissions');
  });

  it('prefers a credential failure over a generic build error', () => {
    expect(of('build failed: 401 Unauthorized from the package registry')).toBe('authentication');
  });

  // ── The action-scoped rules ───────────────────────────────────────────────

  /**
   * "Tests failed" means different things in a unit stage and an e2e stage: one is
   * usually a code change, the other is usually an environment. The rule is scoped
   * to the action name for exactly that reason.
   */
  it('separates unit from integration tests by which action ran', () => {
    expect(of('12 tests failed', { actionName: 'jest-unit' })).toBe('unit_test');
    expect(of('12 tests failed', { actionName: 'e2e-suite' })).toBe('integration_test');
    expect(of('12 tests failed', { stageName: 'Integration' })).toBe('integration_test');
  });

  it('does not claim a test failure for an action that is not a test', () => {
    // Same words, a deploy action: `unit_test` here would send someone looking at
    // a test suite that never ran.
    expect(of('assertion failed', { actionName: 'cdk-deploy' })).toBe('other');
  });

  // ── The `other` bucket ────────────────────────────────────────────────────

  it('labels an unmatched failure `other` rather than dropping it', () => {
    expect(of('the frobnicator declined to frobnicate')).toBe('other');
  });

  it('labels a failure with no error text at all', () => {
    expect(classifyFailure({ status: 'FAILED' })).toBe('other');
    expect(classifyFailure({ status: 'FAILED', errorMessage: null })).toBe('other');
    expect(classifyFailure({ status: 'FAILED', errorMessage: '' })).toBe('other');
  });

  it('is case-insensitive about the error text', () => {
    expect(of('NPM ERR! CODE ETARGET')).toBe('dependency');
    expect(of('OOMKILLED')).toBe('resource_exhaustion');
  });
});

describe('the taxonomy itself', () => {
  it('every category has a manager-readable label', () => {
    for (const c of FAILURE_CATEGORIES) {
      expect(FAILURE_CATEGORY_LABELS[c]).toBeTruthy();
      // Phrased as what broke, not as an enum: a manager reads "Dependency
      // resolution" and understands it; `integration_test` they do not.
      expect(FAILURE_CATEGORY_LABELS[c]).not.toMatch(/_/);
    }
  });

  it('labels exactly the categories that exist — no extras, none missing', () => {
    expect(Object.keys(FAILURE_CATEGORY_LABELS).sort()).toEqual([...FAILURE_CATEGORIES].sort());
  });

  /**
   * A week whose failures were all cloud throttling is a different conversation
   * from one whose failures were all broken tests. Presenting them in one ranked
   * list invites exactly the wrong conclusion, so the section can separate them.
   */
  it('marks the two categories that happened TO the team as not theirs to fix', () => {
    expect(isTeamActionable('infrastructure')).toBe(false);
    expect(isTeamActionable('external_service')).toBe(false);
    for (const c of FAILURE_CATEGORIES) {
      if (c === 'infrastructure' || c === 'external_service') continue;
      expect(isTeamActionable(c)).toBe(true);
    }
  });

  it('only ever returns a category the schema allows', () => {
    const allowed = new Set<string>(FAILURE_CATEGORIES);
    const samples = [
      'AccessDenied', '401', 'repository not found', 'npm ERR! ETARGET', 'tests failed',
      'CVE-2026-1', 'timed out', 'OOMKilled', 'UPDATE_ROLLBACK', 'Rate exceeded',
      'ENOTFOUND', 'command not found', 'error TS1', 'nothing matches this',
    ];
    for (const s of samples) {
      const c = classifyFailure({ status: 'FAILED', errorMessage: s, actionName: 'test' });
      expect(c === null || allowed.has(c)).toBe(true);
    }
  });
});
