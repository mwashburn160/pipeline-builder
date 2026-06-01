// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  QUERIES,
  substituteVars,
  stepForRange,
  rangeSeconds,
} from '../src/observability/catalog';

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

    it('only declares template vars from the allow-list', () => {
      // `digest` was dropped from the catalog — it had no live callers.
      const allowed = new Set(['event', 'actor', 'plugin']);
      for (const [key, entry] of Object.entries(QUERIES)) {
        for (const v of entry.allowedVars) {
          expect(allowed.has(v)).toBe(true);
        }
        // catalog source must be one of the three supported kinds
        expect(['prometheus-instant', 'prometheus-range', 'loki-range'])
          .toContain(entry.source);
        // catalog query non-empty
        expect(entry.query.trim().length).toBeGreaterThan(0);
        // Sanity: key matches snake_case
        expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });
  });

  describe('substituteVars', () => {
    it('substitutes a valid event into the EVENT placeholder', () => {
      const out = substituteVars(
        '{eventCategory="audit"$EVENT}',
        { event: 'registry.tag.copy' },
        ['event'],
      );
      expect(out).toBe('{eventCategory="audit",event="registry.tag.copy"}');
    });

    it('drops the EVENT placeholder when not in allowedVars', () => {
      const out = substituteVars(
        '{eventCategory="audit"$EVENT}',
        { event: 'registry.tag.copy' },
        [],
      );
      expect(out).toBe('{eventCategory="audit"}');
    });

    it('rejects a hostile event value (rune injection)', () => {
      const out = substituteVars(
        '{eventCategory="audit"$EVENT}',
        { event: 'foo"} or 1=1 //' },
        ['event'],
      );
      // Invalid characters → placeholder dropped, not injected.
      expect(out).toBe('{eventCategory="audit"}');
    });

    // `$DIGEST` placeholder + `digest` var were dropped from the catalog —
    // no live dashboard used them. Tests removed alongside the source.

    it('substitutes a valid actor into the ACTOR placeholder', () => {
      const out = substituteVars(
        '{eventCategory="audit"$ACTOR}',
        { actor: 'user@example.com' },
        ['actor'],
      );
      expect(out).toBe('{eventCategory="audit",actor="user@example.com"}');
    });

    it('drops all placeholders when no vars supplied', () => {
      const out = substituteVars(
        '{eventCategory="audit"$EVENT$ACTOR}',
        {},
        ['event', 'actor'],
      );
      expect(out).toBe('{eventCategory="audit"}');
    });

    it('audit_recent_events template renders with all vars omitted', () => {
      const out = substituteVars(
        QUERIES.audit_recent_events.query,
        {},
        QUERIES.audit_recent_events.allowedVars,
      );
      expect(out).toBe('{eventCategory="audit"}');
    });
  });

  describe('substituteVars: $ORG (server-driven, not from allowedVars)', () => {
    it('substitutes a regex wildcard for sysadmins', () => {
      const out = substituteVars('foo{a="b"$ORG}', { isSuperAdmin: true }, []);
      expect(out).toBe('foo{a="b",org_id=~".+"}');
    });

    it('substitutes a literal match for non-sysadmins with a valid org', () => {
      const out = substituteVars('foo{a="b"$ORG}', { org: 'org-acme', isSuperAdmin: false }, []);
      expect(out).toBe('foo{a="b",org_id="org-acme"}');
    });

    it('substitutes a never-match clause when non-sysadmin has no org', () => {
      const out = substituteVars('foo{a="b"$ORG}', { isSuperAdmin: false }, []);
      expect(out).toBe('foo{a="b",org_id="__no_org__"}');
    });

    it('rejects a hostile org value (regex injection)', () => {
      const out = substituteVars('foo{$ORG}', { org: 'foo".+",other="bar', isSuperAdmin: false }, []);
      // Invalid org chars → empty-match selector instead of injection
      expect(out).toBe('foo{,org_id="__no_org__"}');
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

  describe('rangeSeconds', () => {
    it('returns the documented seconds per preset', () => {
      expect(rangeSeconds('1h')).toBe(3600);
      expect(rangeSeconds('6h')).toBe(21600);
      expect(rangeSeconds('24h')).toBe(86400);
    });
  });
});
