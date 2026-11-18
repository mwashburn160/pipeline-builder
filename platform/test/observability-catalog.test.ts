// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import {
  canQueryCatalogKey,
  QUERIES,
  substituteOrg,
  stepForRange,
  rangeSeconds,
} from '../src/observability/catalog.js';

describe('observability catalog', () => {
  describe('QUERIES', () => {
    it('has the dashboards we ship in this PR', () => {
      // Plugin Builds
      expect(QUERIES).toHaveProperty('plugin_builds_per_min');
      expect(QUERIES).toHaveProperty('plugin_build_success_rate_5m');
      expect(QUERIES).toHaveProperty('plugin_queue_depth');
      expect(QUERIES).toHaveProperty('plugin_build_p95_duration_sec');
      expect(QUERIES).toHaveProperty('plugin_builds_total_24h');
      // Plugin autoscaling visibility
      expect(QUERIES).toHaveProperty('plugin_replicas');
      expect(QUERIES).toHaveProperty('plugin_keda_trigger_queue');
      expect(QUERIES).toHaveProperty('plugin_pod_cpu_seconds_rate');
      expect(QUERIES).toHaveProperty('plugin_pod_memory_bytes');
      // Audit Activity
      expect(QUERIES).toHaveProperty('audit_events_per_hour_by_event');
      expect(QUERIES).toHaveProperty('audit_recent_events');
      expect(QUERIES).toHaveProperty('audit_top_actors_24h');
    });

    it('keeps every entry well-formed', () => {
      const allowedVars = new Set(['event', 'actor', 'requestId']);
      for (const [key, entry] of Object.entries(QUERIES)) {
        expect(['prometheus-instant', 'prometheus-range', 'audit-store']).toContain(entry.source);
        expect(entry.query.trim().length).toBeGreaterThan(0);
        expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
        if (entry.source === 'audit-store') {
          for (const v of entry.allowedVars ?? []) expect(allowedVars.has(v)).toBe(true);
        } else {
          // `$ORG` is the only PromQL placeholder — nothing user-supplied is
          // ever spliced into a query string.
          expect(entry.query.replaceAll('$ORG', '')).not.toContain('$');
        }
      }
    });

    it('confines every audit-store entry to the caller\'s org and to admins', () => {
      // Tenancy invariant: the audit trail is an admin surface (GET /audit is
      // admin-gated) and must never be served unscoped to an org member.
      const auditEntries = Object.values(QUERIES).filter(e => e.source === 'audit-store');
      expect(auditEntries.length).toBeGreaterThan(0);
      for (const entry of auditEntries) {
        expect(entry.orgScoped).toBe(true);
        expect(entry.adminOnly).toBe(true);
        expect(['events_by_action', 'top_actors_24h', 'recent_events']).toContain(entry.query);
      }
    });
  });

  describe('substituteOrg (server-driven $ORG)', () => {
    it('substitutes a regex wildcard for sysadmins', () => {
      const out = substituteOrg('foo{a="b"$ORG}', { isSuperAdmin: true });
      expect(out).toBe('foo{a="b",org_id=~".+"}');
    });

    it('substitutes a literal match for non-sysadmins with a valid org', () => {
      const out = substituteOrg('foo{a="b"$ORG}', { org: 'org-acme', isSuperAdmin: false });
      expect(out).toBe('foo{a="b",org_id="org-acme"}');
    });

    it('substitutes a never-match clause when non-sysadmin has no org', () => {
      const out = substituteOrg('foo{a="b"$ORG}', { isSuperAdmin: false });
      expect(out).toBe('foo{a="b",org_id="__no_org__"}');
    });

    it('rejects a hostile org value (regex injection)', () => {
      const out = substituteOrg('foo{$ORG}', { org: 'foo".+",other="bar', isSuperAdmin: false });
      // Invalid org chars → empty-match selector instead of injection
      expect(out).toBe('foo{,org_id="__no_org__"}');
    });

    it('substitutes EVERY $ORG occurrence, not just the first', () => {
      // Regression: ratio-style panels reference $ORG twice. A first-only
      // replace left the second `$ORG` literal, which Prometheus rejects
      // with "unexpected character inside braces: '$'" (HTTP 400 → 500).
      const out = substituteOrg('a{x="1"$ORG} / b{y="2"$ORG}', { isSuperAdmin: true });
      expect(out).toBe('a{x="1",org_id=~".+"} / b{y="2",org_id=~".+"}');
      expect(out).not.toContain('$ORG');
    });

    it('divides the success-rate by the raw (>0-filtered) build rate, never a clamp to 1/s', () => {
      const q = QUERIES.plugin_build_success_rate_5m.query;
      expect(q).not.toContain('clamp_min');
      expect(q).toMatch(/\/ \(sum\(rate\(plugin_builds_total\{status!=""\$ORG\}\[5m\]\)\) > 0\)$/);
    });

    it('renders the real success-rate panel query with no leftover placeholder', () => {
      const rendered = substituteOrg(QUERIES.plugin_build_success_rate_5m.query, { isSuperAdmin: true });
      expect(rendered).not.toContain('$');
    });
  });

  describe('stepForRange', () => {
    it('returns the documented step for each preset', () => {
      expect(stepForRange('1h')).toBe('15s');
      expect(stepForRange('6h')).toBe('60s');
      expect(stepForRange('24h')).toBe('300s');
    });

    it('defaults to 60s for unknown range', () => {
      expect(stepForRange('whatever')).toBe('60s');
    });
  });

  describe('canQueryCatalogKey', () => {
    const member = { isSuperAdmin: false, isOrgAdmin: false };
    const orgAdmin = { isSuperAdmin: false, isOrgAdmin: true };
    const sysadmin = { isSuperAdmin: true, isOrgAdmin: false };

    it('lets any org member run an orgScoped key ($ORG confines it)', () => {
      expect(canQueryCatalogKey('plugin_builds_per_min', member)).toBe(true);
      expect(canQueryCatalogKey('plugin_builds_per_min', sysadmin)).toBe(true);
    });

    it('lets an org admin — but not a plain member — run the org-scoped audit trail', () => {
      expect(canQueryCatalogKey('audit_recent_events', orgAdmin)).toBe(true);
      expect(canQueryCatalogKey('audit_recent_events', member)).toBe(false);
      expect(canQueryCatalogKey('audit_recent_events', sysadmin)).toBe(true);
    });

    it('restricts fleet-wide keys to sysadmins, even for org admins', () => {
      expect(canQueryCatalogKey('platform_orgs_total', orgAdmin)).toBe(false);
      expect(canQueryCatalogKey('platform_orgs_total', sysadmin)).toBe(true);
    });

    it('rejects unknown keys and inherited Object.prototype names, even for sysadmins', () => {
      expect(canQueryCatalogKey('nope', sysadmin)).toBe(false);
      expect(canQueryCatalogKey('toString', sysadmin)).toBe(false);
    });
  });

  describe('rangeSeconds', () => {
    it('returns the documented seconds per preset', () => {
      expect(rangeSeconds('1h')).toBe(3600);
      expect(rangeSeconds('6h')).toBe(21600);
      expect(rangeSeconds('24h')).toBe(86400);
    });
  });
});
