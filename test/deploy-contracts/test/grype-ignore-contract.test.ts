// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The repo-root `.grype.yaml` stays narrow and temporary.
 *
 * CI's smoke build and the release gate run grype from the repo root, which
 * loads `.grype.yaml` automatically — so a rule there silences a finding for
 * every image those jobs scan. That is only acceptable when each rule:
 *
 *   - names ONE advisory and ONE exact package version, so a later version of
 *     the package (or any other advisory against it) still fails the scan;
 *   - carries an `# expires: YYYY-MM-DD` line directly above it, because grype
 *     has no expiry of its own and a rule nobody revisits is a permanent hole.
 *
 * Past its date this test fails, which forces the rule to be removed (the fix
 * shipped) or re-justified with a new date — never silently kept.
 */

import { describe, it, expect } from '@jest/globals';
import { parse } from 'yaml';
import { read } from '../src/index.js';

interface IgnoreRule {
  vulnerability?: string;
  package?: { name?: string; version?: string; type?: string };
}

const raw = read('.grype.yaml');
const rules = ((parse(raw) as { ignore?: IgnoreRule[] }).ignore ?? []);

/** `expires:` comments in file order, one per rule. */
const expiries = [...raw.matchAll(/^\s*#\s*expires:\s*(\d{4}-\d{2}-\d{2})\s*$/gm)].map((m) => m[1]);

describe('.grype.yaml ignore rules', () => {
  it('scopes every rule to one advisory and one exact package version', () => {
    for (const r of rules) {
      expect({ rule: r, scoped: Boolean(r.vulnerability && r.package?.name && r.package?.version) })
        .toEqual({ rule: r, scoped: true });
    }
  });

  it('gives every rule an expiry date', () => {
    expect(expiries).toHaveLength(rules.length);
  });

  it('has no rule past its expiry', () => {
    const today = new Date().toISOString().slice(0, 10);
    const expired = rules
      .map((r, i) => ({ vulnerability: r.vulnerability, expires: expiries[i] }))
      .filter((r) => r.expires !== undefined && r.expires < today);
    expect(expired).toEqual([]);
  });
});
