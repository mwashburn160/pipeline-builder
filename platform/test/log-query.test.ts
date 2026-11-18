// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The log query compiler is the security boundary for the Logs surface: the
 * browser sends a filter, this turns it into LogQL and a Loki tenant header.
 * Loki enforces the tenant, so these tests guard the two things that could
 * still go wrong — a tenant resolving to something broader than the caller, and
 * user text escaping into the query.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ observability: { get lokiBaseSelector() { return process.env.LOKI_BASE_SELECTOR || 'service_name=~".+"'; } } }));

const {
  buildLogQL,
  buildLogVolumeQL,
  INFRA_TENANT,
  LogQueryError,
  MAX_TENANTS_PER_QUERY,
  parseLogQuery,
  resolveTenants,
} = await import('../src/observability/log-query.js');

describe('resolveTenants', () => {
  it('confines a member to their own org', () => {
    expect(resolveTenants({ isSuperAdmin: false, orgId: 'acme' })).toBe('acme');
  });

  it('ignores any tenants a member asks for', () => {
    // A member naming other orgs must not widen their own scope.
    expect(resolveTenants({ isSuperAdmin: false, orgId: 'acme' }, ['other', '_infra'])).toBe('acme');
  });

  it('refuses a member with no org rather than falling back to something broader', () => {
    expect(() => resolveTenants({ isSuperAdmin: false })).toThrow(LogQueryError);
    expect(() => resolveTenants({ isSuperAdmin: false, orgId: '   ' })).toThrow(LogQueryError);
  });

  it('rejects an org id that could break out of the header', () => {
    expect(() => resolveTenants({ isSuperAdmin: false, orgId: 'acme|other' })).toThrow(LogQueryError);
  });

  it('defaults a sysadmin to _infra, not an implicit firehose', () => {
    expect(resolveTenants({ isSuperAdmin: true })).toBe(INFRA_TENANT);
  });

  it('lets a sysadmin name several tenants, de-duplicated', () => {
    expect(resolveTenants({ isSuperAdmin: true }, ['a', 'b', 'a'])).toBe('a|b');
  });

  it('caps how many tenants one query may enumerate', () => {
    const many = Array.from({ length: MAX_TENANTS_PER_QUERY + 1 }, (_, i) => `org${i}`);
    expect(() => resolveTenants({ isSuperAdmin: true }, many)).toThrow(/narrow the selection/);
  });
});

describe('parseLogQuery', () => {
  it('parses an empty query', () => {
    expect(parseLogQuery(undefined)).toEqual({ labels: {}, fields: {}, terms: [] });
  });

  it('parses labels, fields, phrases, exclusions and regex', () => {
    const f = parseLogQuery('level:error service_name:platform trace_id:abc "connection refused" -healthz /timed? out/');
    expect(f.labels).toEqual({ level: 'error', service_name: 'platform' });
    expect(f.fields).toEqual({ trace_id: 'abc' });
    expect(f.terms).toEqual([
      { kind: 'include', value: 'connection refused' },
      { kind: 'exclude', value: 'healthz' },
      { kind: 'regex', value: 'timed? out' },
    ]);
  });

  it('rejects an unknown field instead of silently dropping it', () => {
    // A dropped filter reads as "no matches" and sends people hunting a
    // nonexistent bug, so this must be loud.
    expect(() => parseLogQuery('secretLabel:x')).toThrow(/Unknown filter/);
  });

  it('rejects a search term that is itself a credential', () => {
    // Closes the masking oracle: a hit would confirm the secret even though the
    // line comes back [REDACTED].
    expect(() => parseLogQuery('sk_live_51H8xQ2abcdefGHIJ')).toThrow(/credential/);
  });

  it('rejects an over-long query and over-long regex', () => {
    expect(() => parseLogQuery('x'.repeat(1001))).toThrow(/too long/i);
    expect(() => parseLogQuery(`/${'a'.repeat(201)}/`)).toThrow(/too long/i);
  });
});

describe('buildLogQL', () => {
  it('uses the portable anchor when no label is constrained', () => {
    expect(buildLogQL(parseLogQuery(''))).toBe('{service_name=~".+"}');
  });

  it('emits label matchers and line filters', () => {
    expect(buildLogQL(parseLogQuery('level:error "boom" -noise')))
      .toBe('{level="error"} |= "boom" != "noise"');
  });

  it('never interpolates an org predicate — isolation is the tenant header', () => {
    // If a predicate ever appears here it means someone re-introduced
    // filter-based tenancy alongside the tenant header; they must not diverge.
    expect(buildLogQL(parseLogQuery('level:error'))).not.toMatch(/orgId/);
  });

  it('quotes values so user text cannot escape the query', () => {
    // SAFE_VALUE rejects quotes outright, so the compiler never sees one; this
    // asserts the defence rather than the happy path.
    expect(() => parseLogQuery('service_name:"pl\\"atform"')).toThrow();
    expect(() => parseLogQuery('level:err"or')).toThrow();
  });

  it('wraps the selector for the volume query so the step applies to the pipeline', () => {
    expect(buildLogVolumeQL(parseLogQuery('level:error'), '30s'))
      .toBe('sum by (level) (count_over_time(({level="error"})[30s]))');
  });
});
