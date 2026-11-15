// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The curated rule library under `deploy/compliance` only reads fields the
 * platform establishes.
 *
 * The library once shipped dozens of rules on fields no plugin or pipeline has
 * (`timeoutInMinutes`, `encryptionEnabled`, `privileged` at the top level, …).
 * A missing field fails every positive check and passes every negative one, so
 * activating a library blocked every entity on some rules and gave false
 * assurance on others. `load-compliance.sh` imports the files unchecked, so
 * this suite is the gate: every field, in every rule and condition, must be one
 * the rule API would accept.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect } from '@jest/globals';
import { RULE_FIELDS, RULE_OPERATORS, RULE_TARGETS, ruleFieldError } from '@pipeline-builder/api-core';
import { STEP_FACTS_KEY, STEP_FACT_FIELDS } from '../src/helpers/pipeline-step-facts.js';

const LIBRARY = new URL('../../../deploy/compliance/', import.meta.url);

interface RuleFile {
  name: string;
  target: string;
  field?: string;
  operator?: string;
  conditions?: Array<{ field: string; operator: string }>;
}

/** Every `<dir>/<name>/<file>` under `dir`, recursively. */
function filesNamed(dir: URL, file: string): URL[] {
  const out: URL[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = new URL(`${entry.name}/`, dir);
    try {
      statSync(new URL(file, child));
      out.push(new URL(file, child));
    } catch {
      out.push(...filesNamed(child, file));
    }
  }
  return out;
}

const read = <T>(u: URL): T => JSON.parse(readFileSync(u, 'utf8')) as T;
const rules = filesNamed(LIBRARY, 'rule.json').map((u) => ({ url: u, rule: read<RuleFile>(u) }));
const policies = filesNamed(LIBRARY, 'policy.json').map((u) => ({ url: u, policy: read<{ name: string; rules: string[] }>(u) }));

/** The set a file belongs to: `standard`, or `advanced/<framework>`. */
const setOf = (u: URL): string => {
  const rel = u.pathname.slice(LIBRARY.pathname.length).split('/');
  return rel[0] === 'advanced' ? `advanced/${rel[1]}` : rel[0]!;
};

describe('deploy/compliance rule library', () => {
  it('has rules and policies to check', () => {
    expect(rules.length).toBeGreaterThan(40);
    expect(policies.length).toBeGreaterThan(5);
  });

  it.each(rules.map(({ rule }) => [rule.name, rule] as const))('%s reads only fields its target has', (_name, rule) => {
    expect(RULE_TARGETS).toContain(rule.target);
    const target = rule.target as (typeof RULE_TARGETS)[number];
    const reads = [
      ...(rule.field ? [{ field: rule.field, operator: rule.operator }] : []),
      ...(rule.conditions ?? []),
    ];
    expect(reads.length).toBeGreaterThan(0);
    for (const { field, operator } of reads) {
      expect(ruleFieldError(target, field)).toBeNull();
      expect(RULE_OPERATORS).toContain(operator);
    }
  });

  it('every policy lists rules of its own set, and every rule is in a policy', () => {
    const bySet = new Map<string, Set<string>>();
    for (const { url, rule } of rules) {
      const set = setOf(url);
      bySet.set(set, (bySet.get(set) ?? new Set()).add(rule.name));
    }
    const listed = new Set<string>();
    for (const { url, policy } of policies) {
      const own = bySet.get(setOf(url)) ?? new Set();
      for (const name of policy.rules) {
        expect({ policy: policy.name, rule: name, exists: own.has(name) }).toEqual({ policy: policy.name, rule: name, exists: true });
        listed.add(name);
      }
    }
    expect(rules.map(({ rule }) => rule.name).filter((n) => !listed.has(n))).toEqual([]);
  });

  it("each framework README states its policy's rule count", () => {
    for (const { url, policy } of policies.filter((p) => setOf(p.url).startsWith('advanced/'))) {
      const readme = readFileSync(new URL('../../README.md', url), 'utf8');
      expect(readme).toContain(`These ${policy.rules.length} rules`);
    }
  });
});

describe('the rule field catalog', () => {
  it('lists exactly the step facts the compliance service derives', () => {
    const listed = RULE_FIELDS.pipeline.filter((f) => f.path.startsWith(`${STEP_FACTS_KEY}.`)).map((f) => f.path.slice(STEP_FACTS_KEY.length + 1));
    expect([...listed].sort()).toEqual([...STEP_FACT_FIELDS].sort());
  });
});
