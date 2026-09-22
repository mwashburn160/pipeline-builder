// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Docs-drift guard for configuration.
 *
 * Config is read through one set of readers (`envInt` / `envBool` / `envStr`
 * in `utils/env.ts`). A variable read through them MUST appear in
 * `docs/environment-variables.md`, so an operator-facing knob can't be added in
 * code and silently stay undocumented.
 *
 * Scope is deliberately the shared readers, not every `process.env.*` access:
 * those also cover third-party/runtime variables the platform merely observes
 * (`NODE_ENV`, `AWS_*`, `OTEL_*`, `SHELL`, …), which this document does not own.
 * Reading a new knob through the shared readers is the documented convention,
 * so the rule is "if it is config, it is documented".
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';

/** Repo root, from `packages/api-core`. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'environment-variables.md');

/** Source trees whose config knobs this document covers. */
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

/** `envInt('NAME'` / `envBool("NAME"` / `envStr('NAME'` — literal names only.
 *  A computed name (`QUOTA_TIER_${tier}_PLUGINS`) can't be checked statically;
 *  those families are documented as a pattern instead. */
const READER = /\benv(?:Int|Bool|Str)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g;

function collectEnvVars(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const root of sourceRoots()) {
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(READER)) {
        const name = match[1];
        const sites = found.get(name) ?? [];
        sites.push(file.slice(REPO_ROOT.length + 1));
        found.set(name, sites);
      }
    }
  }
  return found;
}

describe('docs/environment-variables.md', () => {
  const found = collectEnvVars();
  const doc = readFileSync(DOC_PATH, 'utf8');

  it('finds the env vars read through the shared readers', () => {
    // Guards the scanner itself: a broken glob/regex would make the real
    // assertion below vacuously pass.
    expect(found.size).toBeGreaterThan(50);
    expect(found.has('COMPLIANCE_REGEX_TIMEOUT_MS')).toBe(true);
  });

  it('documents every env var read through envInt/envBool/envStr', () => {
    const undocumented = [...found.entries()]
      .filter(([name]) => !doc.includes(`\`${name}\``))
      .map(([name, sites]) => `${name} (read in ${sites[0]})`)
      .sort();

    expect(undocumented).toEqual([]);
  });

  it('documents the five knobs the config survey found missing', () => {
    for (const name of [
      'ASK_HTTP_TIMEOUT_MS',
      'AUDIT_RETENTION_DAYS',
      'ALERT_WEBHOOK_LIMITER_MAX',
      'BILLING_ENTITLEMENT_DRIFT_INTERVAL_MS',
      'AUTH_VERIFICATION_TOKEN_TTL_MS',
    ]) {
      expect(doc).toContain(`\`${name}\``);
    }
  });
});
