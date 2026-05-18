// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * URL-contract test for buildAuditLogLink. RecentActionsPanel emits URLs
 * via this helper; the Audit Activity page parses them. Both sides depend
 * on the param shape staying stable — these assertions are the contract.
 */

import { buildAuditLogLink } from '../src/lib/registry-audit-link';

const AT = '2026-05-18T02:07:00.000Z';
const DIGEST = 'sha256:' + 'a'.repeat(64);

describe('buildAuditLogLink', () => {
  it('returns null when `at` is missing', () => {
    expect(buildAuditLogLink({ kind: 'copy', at: '' })).toBeNull();
  });

  it('targets the native Audit Activity page (not Grafana)', () => {
    const href = buildAuditLogLink({ kind: 'copy', at: AT, digest: DIGEST });
    expect(href).not.toBeNull();
    expect(href!.startsWith('/dashboard/observability/audit-activity?')).toBe(true);
    expect(href).not.toContain('/grafana/');
  });

  it('encodes `event=registry.tag.copy` for copy specs', () => {
    const href = buildAuditLogLink({ kind: 'copy', at: AT });
    const params = new URLSearchParams(href!.split('?')[1]);
    expect(params.get('event')).toBe('registry.tag.copy');
  });

  it('encodes `event=registry.tag.delete` for delete specs', () => {
    const href = buildAuditLogLink({ kind: 'delete', at: AT });
    const params = new URLSearchParams(href!.split('?')[1]);
    expect(params.get('event')).toBe('registry.tag.delete');
  });

  it('encodes a ±5min ISO window around `at`', () => {
    const href = buildAuditLogLink({ kind: 'copy', at: AT });
    const params = new URLSearchParams(href!.split('?')[1]);
    const since = params.get('since')!;
    const until = params.get('until')!;
    // 5 minutes either side
    expect(new Date(since).toISOString()).toBe('2026-05-18T02:02:00.000Z');
    expect(new Date(until).toISOString()).toBe('2026-05-18T02:12:00.000Z');
  });

  it('encodes the digest when present', () => {
    const href = buildAuditLogLink({ kind: 'copy', at: AT, digest: DIGEST });
    const params = new URLSearchParams(href!.split('?')[1]);
    expect(params.get('digest')).toBe(DIGEST);
  });

  it('omits the digest param when absent', () => {
    const href = buildAuditLogLink({ kind: 'copy', at: AT });
    const params = new URLSearchParams(href!.split('?')[1]);
    expect(params.has('digest')).toBe(false);
  });
});
