// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The remediation notices' copy (N36–N40), as owners, pipeline writers and
 * publishers read it: what was fixed, why a fix waits, why a rollout paused,
 * what is left and the level a fix would need, and the caps on long lists.
 */

import { describe, it, expect } from '@jest/globals';

const {
  NOTICE_FINDINGS_MAX, NOTICE_PATCH_MAX, remainingLine, remainingText, renderFixPublished, renderOwnerRequest, renderPublisherFixRequest,
  renderRollback, renderRollout,
} = await import('../src/services/remediation-notices.js');

const left = (over: Record<string, unknown> = {}): any => ({
  id: 'CVE-1',
  severity: 'high',
  purl: 'pkg:npm/lodash@4.17.0',
  packageName: 'lodash',
  packageType: 'npm',
  packageVersion: '4.17.0',
  fixedIn: ['4.17.21'],
  reason: 'beyond_upgrade_level',
  ...over,
});
const cleared = (over: Record<string, unknown> = {}): any => ({
  id: 'CVE-2', purl: 'pkg:deb/debian/tar@1.34', packageName: 'tar', packageType: 'deb', fromVersion: '1.34', toVersion: '1.35', method: 'source_patch', ...over,
});
const base = { orgId: 'org-1', remediationId: 'rem-1', pluginName: 'lint', fromVersion: '1.0.0' };

describe('the remaining-finding lines', () => {
  it('say what fix exists, why it was not applied and the level it needs', () => {
    expect(remainingLine(left({ requiredLevel: 'major' }))).toBe('- CVE-1 (high) in lodash 4.17.0 [npm]: fixed in 4.17.21. Not fixed: '
      + `${remainingLine(left()).split('Not fixed: ')[1]!.replace(/\.$/, '')}; a fix needs a major upgrade.`);
    expect(remainingLine(left({ requiredLevel: 'owner' }))).toContain('a fix needs a new module path (owner change)');
    expect(remainingLine(left({ fixedIn: [], kev: true, reason: 'no_fix' }))).toMatch(/\(high, known exploited\).*no fixed version yet/);
  });

  it(`caps the list at ${NOTICE_FINDINGS_MAX} and counts the rest`, () => {
    const text = remainingText(Array.from({ length: NOTICE_FINDINGS_MAX + 3 }, (_, i) => left({ id: `CVE-${i}` })));
    expect(text.split('\n')).toHaveLength(NOTICE_FINDINGS_MAX + 1);
    expect(text).toContain('…and 3 more.');
  });
});

describe('N36 fix published / awaiting approval', () => {
  it('published: the fix version, what it cleared by package (a rebuild names no target version), what is still open', () => {
    const n = renderFixPublished({
      code: 'N36',
      ...base,
      toVersion: '1.0.1',
      awaitingApproval: false,
      cleared: [cleared(), cleared({ id: 'CVE-3' }), cleared({ id: 'CVE-4', purl: '', packageName: 'perl', fromVersion: '5.36', toVersion: null, method: 'rebuild' })],
      remaining: [left()],
    });
    expect(n.subject).toBe('Fix published: lint 1.0.1 clears 3 findings in lint@1.0.0');
    expect(n.text).toContain('- tar 1.34 → 1.35 [source patch]: CVE-2, CVE-3');
    expect(n.text).toContain('- perl 5.36 (removed by the rebuild) [rebuild]: CVE-4');
    expect(n.text).toContain('Still open (1;');
    expect(n.text).toContain('remediation=rem-1');
  });

  it('awaiting approval: says why it waits; one finding is singular; no version yet reads "a new version"', () => {
    const n = renderFixPublished({ code: 'N36', ...base, awaitingApproval: true, cleared: [cleared()], remaining: [], proposeReasons: ['org_mode', 'no_smoke_test'] });
    expect(n.subject).toBe('Fix ready for approval: lint a new version clears 1 finding in lint@1.0.0');
    expect(n.text).toContain('because your organization reviews fixes before they are published, and the plugin declares no smokeTest');
    expect(n.text).not.toContain('Still open');
    expect(renderFixPublished({ code: 'N36', ...base, awaitingApproval: true, cleared: [], remaining: [] }).text).not.toContain('It waits for approval because');
  });

  it('lists at most the cap of packages and counts the rest', () => {
    const many = Array.from({ length: NOTICE_FINDINGS_MAX + 2 }, (_, i) => cleared({ purl: `pkg:npm/p${i}@1`, packageName: `p${i}` }));
    expect(renderFixPublished({ code: 'N36', ...base, awaitingApproval: false, cleared: many, remaining: [] }).text).toContain('…and 2 more packages.');
  });
});

describe('N37 rollout', () => {
  const summary = (over: Record<string, unknown> = {}): any => ({
    status: 'done',
    toVersion: '1.0.1',
    waves: [],
    updatedAt: 'now',
    counts: { eligible: 9, proposed: 1, changeRequested: 1, moved: 5, failed: 0, rolledBack: 1, skippedOptOut: 1, skippedRunner: 0 },
    ...over,
  });

  it('finished: the counts of every outcome', () => {
    const n = renderRollout({ code: 'N37', ...base, summary: summary() });
    expect(n.subject).toBe('Rollout finished: lint 1.0.1');
    expect(n.text).toContain('5 moved, 1 offered the upgrade, 1 change requests, 0 failed, 1 rolled back, 1 opted out, 0 skipped (runner unhealthy), of 9 eligible');
  });

  it.each([
    ['canary_failed', 'a canary pipeline failed'],
    ['rollbacks', 'two pipelines were rolled back'],
    ['rollback_target_deleted', 'its previous version was deleted'],
  ])('paused (%s): says why', (reason, why) => {
    const n = renderRollout({ code: 'N37', ...base, summary: summary({ status: 'paused', pausedReason: reason }) });
    expect(n.subject).toBe('Rollout paused: lint 1.0.1');
    expect(n.text).toContain(why);
    expect(n.text).toContain('needs review');
  });

  it('a rollout that never started (given up): says why and how to restart it, without pipeline counts', () => {
    const exhausted = renderRollout({ code: 'N37', ...base, summary: summary({ status: 'paused' }), startFailure: { reason: 'exhausted', attempts: 5, lastStatus: '503' } });
    expect(exhausted.subject).toBe('Rollout paused: lint 1.0.1');
    expect(exhausted.text).toContain('did not start: the pipeline service answered HTTP 503 (5 attempts)');
    expect(exhausted.text).toContain('Retry on the remediation starts the rollout again');
    expect(exhausted.text).not.toContain('Pipelines:');
    expect(exhausted.text).not.toContain('needs review');
    const refused = renderRollout({ code: 'N37', ...base, summary: summary({ status: 'paused' }), startFailure: { reason: 'permanent', attempts: 1, lastStatus: 'unreachable' } });
    expect(refused.text).toContain('did not start: the pipeline service could not be reached. It is no longer retried');
  });

  it('paused with no recorded reason still reads cleanly', () => {
    expect(renderRollout({ code: 'N37', ...base, summary: summary({ status: 'paused' }) }).text).toMatch(/fixing lint@1\.0\.0\) paused\. The version/);
  });
});

describe('N38 rollback', () => {
  const n = { code: 'N38' as const, ...base, toVersion: '1.0.1', pipelineId: 'p-1', pipelineOrgId: 'org-1', at: 'now' };

  it('rolled back: names the pipeline and the version it went back to', () => {
    expect(renderRollback({ ...n, kind: 'rolled_back', pipelineName: 'web', rolledBackTo: '0.9.0' } as never).subject).toBe('Pipeline "web" rolled back to lint 0.9.0');
    expect(renderRollback({ ...n, kind: 'rolled_back' } as never).subject).toBe('Pipeline p-1 rolled back to lint 1.0.0');
  });

  it('blocked: the previous version is gone; lists the live versions to choose', () => {
    const r = renderRollback({ ...n, kind: 'rollback_blocked', liveVersions: ['1.0.1', '1.1.0'] } as never);
    expect(r.subject).toBe('Pipeline p-1 could not be rolled back from lint 1.0.1');
    expect(r.text).toContain('Live versions you can choose: 1.0.1, 1.1.0.');
    expect(renderRollback({ ...n, kind: 'rollback_blocked' } as never).text).not.toContain('Live versions');
  });
});

describe('N39 owner request and N40 publisher fix request', () => {
  it('owner request: counts, KEV, and the fix version that covers the rest', () => {
    const r = renderOwnerRequest({ code: 'N39', ...base, toVersion: '1.0.1', remaining: [left({ kev: true }), left({ id: 'CVE-9' })] });
    expect(r.subject).toBe('Remediation request: 2 findings in lint@1.0.0 need your fix');
    expect(r.text).toContain('(1 known exploited)');
    expect(r.text).toContain('lint 1.0.1 fixes the rest.');
    expect(renderOwnerRequest({ code: 'N39', ...base, remaining: [left()] }).subject).toBe('Remediation request: 1 finding in lint@1.0.0 needs your fix');
  });

  it('publisher fix request: a truncated suggested patch for the publisher, and a plain notice for installers', () => {
    const r = renderPublisherFixRequest('acme/lint', { code: 'N40', listingId: 'l-1', version: '2.0.0', remaining: [left()], suggestedPatch: 'x'.repeat(NOTICE_PATCH_MAX + 10) } as never);
    expect(r.publisher.subject).toBe('Fix request: 1 vulnerability in acme/lint 2.0.0');
    expect(r.publisher.text).toContain('…(truncated)');
    expect(r.installers.subject).toBe('Fix requested from the publisher of acme/lint');
    expect(r.installers.text).not.toContain('Suggested patch');
    expect(renderPublisherFixRequest('acme/lint', { code: 'N40', listingId: 'l-1', version: '2.0.0', remaining: [left(), left()], suggestedPatch: null } as never).publisher.text).not.toContain('Suggested patch');
  });
});
