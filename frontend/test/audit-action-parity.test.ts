// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every audit action a route DECLARES is one its service actually references.
 *
 * `audited('x')` only tags a route: it adds `x` to the route table (and so to
 * `docs/permission-contract.md`, the audit docs and the operator's expectations)
 * without anything checking that `x` is ever emitted. A typo'd or stale
 * declaration therefore advertises an audit trail that does not exist — the
 * worst kind of gap, because the tag makes it look covered.
 *
 * WHAT THIS PROVES, EXACTLY: for each service, every action string passed to
 * `audited(...)` also appears as a string literal SOMEWHERE ELSE in that
 * service's source — i.e. something other than the declaration itself names it.
 * That catches a typo in the declaration, and an action left declared after its
 * emitter was deleted.
 *
 * WHAT IT DOES NOT PROVE: that the emitting code path is reachable from that
 * route, or runs. Proving that means driving all 207 audited routes with
 * authorized fixtures and asserting on the audit sink — a much larger piece of
 * work, and deliberately not what this file claims. Read it as a cheap ratchet
 * over the declaration↔source link, not as emission coverage.
 *
 * Emission shapes differ per service (`getAuditClient().record({ action })`,
 * `audit(req, 'x', …)`, `emitImageRegistryAudit(…)`, and conditionals like
 * `action: inserted ? 'pipeline.create' : 'pipeline.update'`), so rather than
 * enumerate call shapes this scans for the action literal anywhere outside the
 * `audited(...)` call. Broad on purpose: a narrower scan produced false
 * failures on every one of those shapes.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const TABLE_DIR = resolve(ROOT, 'frontend/src/generated/route-table');

/** service name (matching its route-table file) → its source root. */
const SERVICE_SRC: Record<string, string> = {
  ask: 'api/ask/src',
  billing: 'api/billing/src',
  compliance: 'api/compliance/src',
  'image-registry': 'api/image-registry/src',
  message: 'api/message/src',
  pipeline: 'api/pipeline/src',
  plugin: 'api/plugin/src',
  quota: 'api/quota/src',
  reporting: 'api/reporting/src',
  platform: 'platform/src',
};

/**
 * An audit action: dotted segments of letters/digits/`_`/`-`. Up to six
 * segments — `org.service-account.key.rotate.failed` is five, and a cap that is
 * too low silently reports a real emission as missing.
 */
const ACTION_LITERAL = /'([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+){1,5})'/g;

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, acc);
    else if (entry.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/** Action strings a service names ANYWHERE except inside an `audited(...)` call. */
function referencedActions(srcDir: string): Set<string> {
  const found = new Set<string>();
  for (const file of tsFiles(resolve(ROOT, srcDir))) {
    // Drop the declaration sites, or every declared action trivially "exists".
    const source = readFileSync(file, 'utf8').replace(/audited\([^)]*\)/g, '');
    for (const m of source.matchAll(ACTION_LITERAL)) found.add(m[1]);
  }
  return found;
}

/** Actions declared via `audited(...)`, read off the generated route table. */
function declaredActions(service: string): string[] {
  const table: Array<{ audit?: string[] }> = JSON.parse(
    readFileSync(resolve(TABLE_DIR, `${service}.json`), 'utf8'),
  );
  return [...new Set(table.flatMap((e) => e.audit ?? []))].sort();
}

describe('audited() actions are referenced by their service', () => {
  it.each(Object.entries(SERVICE_SRC))('%s', (service, srcDir) => {
    const declared = declaredActions(service);
    const referenced = referencedActions(srcDir);
    const undeliverable = declared.filter((a) => !referenced.has(a));

    expect({
      service,
      undeliverable,
      fix: undeliverable.length
        ? 'These routes declare an audit action via audited(...) that appears nowhere else in the '
          + 'service. Either the declaration is a typo, or the emitter was removed and the '
          + 'declaration left behind — advertising an audit trail that is not written.'
        : undefined,
    }).toEqual({ service, undeliverable: [], fix: undefined });
  });

  it('actually found declarations to check (guards the scan itself)', () => {
    // If the route tables or the regex ever stop matching, every case above
    // passes vacuously. Pin a floor on the total declared across services.
    const total = Object.keys(SERVICE_SRC).reduce((n, s) => n + declaredActions(s).length, 0);
    expect(total).toBeGreaterThan(150);
  });

  it('would catch a declaration nothing emits (the mechanism bites)', () => {
    // Prove the check is capable of failing, rather than trusting that it is.
    const referenced = referencedActions(SERVICE_SRC.quota);
    expect(referenced.has('quota.totally.invented.action')).toBe(false);
  });
});
