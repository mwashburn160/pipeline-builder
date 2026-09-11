// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * URL-contract test for buildAuditLogLink. RecentActionsPanel emits URLs
 * via this helper; the Audit Activity dashboard parses them. Both sides depend
 * on the param shape staying stable — these assertions are the contract.
 */

import { buildAuditLogLink } from '../src/lib/registry-audit-link';

const paramsOf = (href: string) => new URLSearchParams(href.split('?')[1]);

describe('buildAuditLogLink', () => {
  it('targets the native Audit Activity page', () => {
    expect(buildAuditLogLink('copy').startsWith('/dashboard/observability/audit-activity?')).toBe(true);
  });

  it('encodes `event=registry.image.copy` for copies', () => {
    expect(paramsOf(buildAuditLogLink('copy')).get('event')).toBe('registry.image.copy');
  });

  it('encodes `event=registry.image.delete` for deletes', () => {
    expect(paramsOf(buildAuditLogLink('delete')).get('event')).toBe('registry.image.delete');
  });

  it('carries only the event filter the dashboard honours', () => {
    expect([...paramsOf(buildAuditLogLink('copy')).keys()]).toEqual(['event']);
  });
});
