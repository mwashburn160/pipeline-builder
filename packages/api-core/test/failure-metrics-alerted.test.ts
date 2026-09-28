// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Alert-drift guard for failure counters.
 *
 * A survey found 42 failure-class metrics with no alert rule. Fixing them one at a time
 * would have been a backlog that silently refilled, so this is the rule instead: a metric
 * whose NAME says something broke must either have an alert, or say here why it does not.
 *
 * THE NAMING SPLIT IS THE WHOLE IDEA, and it is not cosmetic:
 *
 *  - `*_failed_total` / `*_dropped_total` / `*_lost_total` mean WE failed. Nobody finds
 *    out from a log line, so these alert unless there is a stated reason.
 *  - `*_refused_total` / `*_rejected_total` / `*_denied_total` mean a CONTROL WORKED. A
 *    non-zero value is the system doing its job — `system_org_guard_refused_total` counts
 *    refusals of cross-org access, and alerting on it would page somebody every time the
 *    guard held. Those are dashboard material, and are deliberately out of scope here.
 *
 * Reading `deploy/aws/eks` only: `prometheus-contract.test.ts` already pins the three
 * Kubernetes rule files as byte-identical and docker as that set minus the two Istio
 * alerts, so one file is the whole fleet's answer.
 *
 * Every exemption carries a REASON CODE from a closed set, not free text. "We decided not
 * to" is not a reason; "the consumer retries and the terminal case has its own alert" is,
 * and it can be checked by reading the code it names.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';

/** Repo root, from `packages/api-core`. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const RULES = join(REPO_ROOT, 'deploy', 'aws', 'eks', 'config', 'prometheus', 'alert-rules.yml');

/** "We broke something" — alert, or state a reason below. */
const BROKE = /_(?:failed|failures|dropped|drop|lost)_total$/;

/**
 * Why a failure counter legitimately has no alert.
 *
 * - `retried`        the operation is retried; a TERMINAL counter carries the alert.
 * - `self-healing`   a sweep or later pass repairs it without human action.
 * - `caller-error`   the failure belongs to the caller (a bad credential, a bad request),
 *                    so it is the control working rather than our outage.
 * - `owner-notified` the one person who can act is told directly, per occurrence.
 * - `non-blocking`   the authoritative write succeeded; this was a best-effort follow-up
 *                    whose failure does not change what the product reports.
 */
type ExemptReason = 'retried' | 'self-healing' | 'caller-error' | 'owner-notified' | 'non-blocking';

interface Exemption { reason: ExemptReason; why: string }

const EXEMPT: Record<string, Exemption> = {
  event_bus_handler_failed_total: {
    reason: 'retried',
    why: 'A CONSUMER throwing. The message is left pending (no XACK) and XAUTOCLAIM redelivers it after minIdle, so a transient failure is normal traffic. The terminal case is `event_bus_dead_lettered_total`, which has EventBusDeadLettered. Alerting here would page on every redelivery.',
  },
  ecosystem_notification_failed_total: {
    reason: 'retried',
    why: 'Advisory fan-out is resumed by the maintenance pass (services/ecosystem/advisories.ts says so at the catch), which re-reads who has not been told. The orgs still get the advisory, later.',
  },
  ecosystem_stats_refresh_failed_total: {
    reason: 'self-healing',
    why: 'Listing stats are recomputed by the ecosystem sweep; a review write deliberately never fails on its stats (services/ecosystem/stats.ts). The only symptom is a rating that lags until the next pass.',
  },
  ecosystem_auto_approval_failed_total: {
    reason: 'self-healing',
    why: 'The request is transitioned back to `pending` and left for a manager, so it rejoins the human queue rather than being lost — and a growing queue is what EcosystemStandardLaneSLABreach already watches.',
  },
  ecosystem_registry_retag_failed_total: {
    reason: 'non-blocking',
    why: 'Re-tagging `public/*` after an unyank. The catalog row is authoritative and deployed pipelines pull by DIGEST, so a failed re-tag changes nothing a user can observe (services/ecosystem/execute.ts).',
  },
  ecosystem_registry_yank_failed_total: {
    reason: 'non-blocking',
    why: 'Removing the `public/*` tag during a yank. The version is yanked in the catalog regardless and resolution goes through the catalog, so the tag is a tidy-up.',
  },
  ecosystem_review_verified_use_failed_total: {
    reason: 'non-blocking',
    why: '`verifiedUse()` in services/ecosystem/reviews.ts is documented "Fails closed (unverified)" and returns false on any probe error, so the review publishes WITHOUT the verified-use badge. A missing badge is the safe outcome; the rating, the review body and the integrity rules are all unaffected.',
  },
  report_run_failed_total: {
    reason: 'owner-notified',
    why: 'Emitted right after the run failure is pushed to the definition owner in-app AND by email (services/report-delivery.ts), so the one person who can act already knows. The fleet-wide rate is ReportRunsFailing, on report_run_error_total + report_run_refused_total.',
  },
  report_claim_lost_total: {
    reason: 'caller-error',
    why: 'Not a failure at all: a second scheduler replica found the definition already claimed and skipped it. That is the concurrency guard working, and it is EXPECTED with more than one replica — the counter exists to show the guard is exercised.',
  },
  platform_api_key_auth_failed_total: {
    reason: 'caller-error',
    why: 'middleware/auth.ts answers 401 when apiKeyService.exchange() rejects — a revoked or expired key, or one presented from outside its IP allowlist. The refusal IS the control working. A brute-force pattern belongs to the rate limiter and its own alerts, not to a counter that increments once per bad credential.',
  },
  platform_api_key_exchange_failed_total: {
    reason: 'caller-error',
    why: 'The presented key did not resolve, so by definition the actor is unknown. Platform is healthy — the caller\'s credential is not. `api_key_exchange_failures_total{reason=~"throttled|server_error"}` is the half that means OUR trouble, and it is alerted.',
  },
  platform_api_key_rotate_failed_total: {
    reason: 'caller-error',
    why: 'A rotate naming a key/keyId pair that does not resolve. Audited as `org.service-account.key.rotate.failed`, which is where a repeated attempt should be read from.',
  },
};

/** Source trees whose metrics the fleet's alert rules cover. */
function sourceRoots(): string[] {
  const roots = [join(REPO_ROOT, 'platform', 'src')];
  for (const group of ['api', 'packages']) {
    const dir = join(REPO_ROOT, group);
    for (const entry of readdirSync(dir)) {
      const src = join(dir, entry, 'src');
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch { /* no src dir — not a source project */ }
    }
  }
  return roots;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every metric name emitted through the shared emitters, with where it came from. */
function emittedMetrics(): Map<string, string> {
  const found = new Map<string, string>();
  const EMIT = /(?:emitCounter|incCounter|observe|setGauge)\(\s*'([a-z][a-z0-9_]*)'/g;
  for (const root of sourceRoots()) {
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(EMIT)) {
        if (!found.has(m[1]!)) found.set(m[1]!, file.slice(REPO_ROOT.length + 1));
      }
    }
  }
  return found;
}

/**
 * The metric names that actually drive an alert.
 *
 * Only `expr:` lines count. The rules file is heavily commented — several comments name a
 * neighbouring counter to explain why THIS alert watches a different one — so a plain
 * substring search over the file reports a metric as alerted when a comment merely
 * mentions it. That is not a hypothetical: this guard's own first run passed
 * `event_bus_handler_failed_total` because the EventBusPublishFailing comment names it.
 */
function alertedMetrics(rules: string): string {
  return [...rules.matchAll(/^\s*expr:\s*(.+)$/gm)].map((m) => m[1]).join('\n');
}

describe('every failure counter is alerted or exempt with a reason', () => {
  const rules = alertedMetrics(readFileSync(RULES, 'utf8'));
  const emitted = emittedMetrics();
  const brokeSomething = [...emitted.keys()].filter((n) => BROKE.test(n)).sort();

  it('finds the failure counters at all (guards the guard)', () => {
    // A regex or emitter rename that matched nothing would make every assertion below
    // vacuously true, which is the failure mode of a rule like this.
    expect(brokeSomething.length).toBeGreaterThan(20);
    expect(emitted.size).toBeGreaterThan(100);
  });

  it('alerts on it, or says why not', () => {
    const unhandled = brokeSomething
      .filter((n) => !rules.includes(n) && !EXEMPT[n])
      .map((n) => `${n}  (emitted in ${emitted.get(n)})`);
    expect({
      unhandled,
      fix: 'This counter says something broke and nobody would find out. Add an alert to all four '
        + 'deploy/*/config/prometheus/alert-rules.yml copies, or add it to EXEMPT here with a reason '
        + 'code. If it counts a control REFUSING something (a bad credential, a blocked cross-org '
        + 'read), the name should say `refused`/`rejected` rather than `failed` — then it is out of '
        + 'scope by naming rather than by exemption.',
    }).toEqual({ unhandled: [], fix: expect.any(String) });
  });

  it('has no exemption for a metric that is now alerted, or no longer exists', () => {
    // A stale exemption is worse than none: it reads as a considered decision while the
    // thing it describes has moved on.
    const stale = Object.keys(EXEMPT)
      .filter((n) => !emitted.has(n) || rules.includes(n))
      .map((n) => `${n} (${!emitted.has(n) ? 'no longer emitted' : 'now alerted — drop the exemption'})`);
    expect(stale).toEqual([]);
  });

  it('gives every exemption a reason that names something checkable', () => {
    // A reason has to point at code, a counter or an alert a reader can go and look at,
    // or the exemption is just a longer way of writing "ignore this".
    const vague = Object.entries(EXEMPT)
      .filter(([, e]) => e.why.length < 80 || !/[a-z-]+\.ts|_total|[A-Z][a-zA-Z]{6,}/.test(e.why))
      .map(([n]) => n);
    expect(vague).toEqual([]);
  });

  it('leaves control-refusal counters out of scope by NAME, not by exemption', () => {
    // The split only holds if `refused`/`rejected` names stay outside BROKE. If one is
    // ever renamed to `*_failed_total` it lands in the list above and has to be argued
    // for — which is the intended pressure.
    const refusals = [...emitted.keys()].filter((n) => /_(?:refused|rejected|denied|blocked)_total$/.test(n));
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.filter((n) => BROKE.test(n))).toEqual([]);
    // And none of them is sitting in EXEMPT, which would mean the naming rule was bypassed.
    expect(refusals.filter((n) => EXEMPT[n])).toEqual([]);
  });
});
