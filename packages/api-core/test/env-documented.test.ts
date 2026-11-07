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
 * Reading a new knob through the shared readers is the documented convention,
 * so the rule is "if it is config, it is documented".
 *
 * THE READERS ARE NOT ENOUGH, and this file used to say they were. Two classes
 * of knob never pass through them and both shipped undocumented for months:
 *
 *  - read straight off `process.env` — `PLUGIN_VULN_WAIVERS` survived several
 *    review passes this way, with the format an operator has to get exactly
 *    right written down nowhere;
 *  - built from a key rather than written as a literal, so no scanner matching
 *    names can see them (`BILLING_PLAN_${tier}_MONTHLY`, the OAuth endpoint
 *    overrides). These are documented as a PATTERN row, which `documentedNames`
 *    expands, and the family is additionally declared in code and checked by
 *    `api/billing/test/plan-env-documented.test.ts`.
 *
 * So there are three sweeps below: the readers, every raw `process.env` literal
 * in the roots this document owns, and every variable a deployment's
 * `.env.example` actually sets. The last one is what catches a knob that exists
 * only as a deploy-time value, and it needs no allowlist — presence in the file
 * IS the claim that an operator sets it.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { VALID_TIERS } from '../src/types/quota-tiers.js';

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

// ---------------------------------------------------------------------------
// Raw `process.env` reads, and the deploy env files
// ---------------------------------------------------------------------------

/** `process.env.NAME` and `process.env['NAME']` — literal names only. */
const RAW_READ = /process\.env\.([A-Z][A-Z0-9_]{2,})|process\.env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g;

/**
 * Names that are NOT this platform's configuration, so the document does not
 * own them. Each is here for a stated reason — the list is the argument, not a
 * place to silence a failure.
 */
const NOT_OUR_CONFIG = new Set([
  // The AWS SDK credential/region chain. We PROBE these to decide whether a
  // provider is usable; the SDK and the environment set them, never us.
  'AWS_ACCESS_KEY_ID', 'AWS_DEFAULT_REGION', 'AWS_PROFILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  // Set by the Lambda runtime; read to detect that we are inside one.
  'AWS_LAMBDA_FUNCTION_NAME',
  // Injected by the kubelet into every pod; read to detect in-cluster.
  'KUBERNETES_SERVICE_HOST', 'KUBERNETES_SERVICE_PORT',
  // OpenTelemetry's own convention, honoured by the SDK whether we read it or not.
  'OTEL_SERVICE_NAME',
  // A PREFIX for dynamically built names (`LIMITER_MULT_<ROUTE>`), not a
  // variable. The family it belongs to is documented as a pattern.
  'LIMITER_MULT_',
  // Developer tooling inside `src/testing`: opts into rewriting the route
  // tables when running the suite. Never set on a deployment.
  'UPDATE_ROUTE_TABLES',
  // Injected into the build container by the pipeline that runs it, so it is
  // execution context rather than something an operator configures.
  'PIPELINE_ID',
]);

/** Placeholders a pattern row may use, and what they stand for. */
const PLACEHOLDERS: Record<string, readonly string[]> = {
  '{TIER}': VALID_TIERS.map((t) => t.toUpperCase()),
  '{PROVIDER}': ['GOOGLE', 'GITHUB', 'GITLAB', 'MICROSOFT', 'FACEBOOK', 'LINKEDIN'],
};

/**
 * Every name the document covers, with pattern rows expanded.
 *
 * A row may read `` `BILLING_PLAN_{TIER}_MONTHLY` / `_ANNUAL` `` — one pattern
 * plus a bare suffix for the sibling. So after expanding placeholders, each
 * pattern's base (everything up to its last `_`) is also combined with every
 * bare `_SUFFIX` the document mentions.
 */
function documentedNames(doc: string): Set<string> {
  const names = new Set<string>();
  const bases = new Set<string>();
  const suffixes = new Set<string>();
  for (const [, token] of doc.matchAll(/`([A-Z{][A-Z0-9_{}]{2,})`/g)) {
    const placeholder = Object.keys(PLACEHOLDERS).find((ph) => token.includes(ph));
    if (placeholder) {
      for (const value of PLACEHOLDERS[placeholder]) names.add(token.replaceAll(placeholder, value));
      // The stem is the prefix THROUGH the placeholder, not up to the last
      // `_`: for `{PROVIDER}_AUTHORIZE_URL` the sibling `_TOKEN_URL` replaces
      // everything after `{PROVIDER}`, and taking the last `_` would have built
      // `{PROVIDER}_AUTHORIZE_TOKEN_URL`.
      bases.add(token.slice(0, token.indexOf(placeholder) + placeholder.length));
    } else {
      names.add(token);
    }
  }
  for (const [, suffix] of doc.matchAll(/`(_[A-Z][A-Z0-9_]*)`/g)) suffixes.add(suffix);
  for (const base of bases) {
    const placeholder = Object.keys(PLACEHOLDERS).find((ph) => base.includes(ph));
    for (const suffix of suffixes) {
      const name = `${base}${suffix}`;
      if (!placeholder) { names.add(name); continue; }
      for (const value of PLACEHOLDERS[placeholder]) names.add(name.replaceAll(placeholder, value));
    }
  }
  return names;
}

/** The four deployment targets' example env files. */
const ENV_FILES = [
  join('deploy', 'local', 'docker', '.env.example'),
  join('deploy', 'local', 'minikube', '.env.example'),
  join('deploy', 'aws', 'eks', '.env.example'),
  join('deploy', 'aws', 'ec2', '.env.example'),
];

describe('raw process.env reads are documented too', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const documented = documentedNames(doc);

  function rawReads(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const root of sourceRoots()) {
      // The CLI (`pipeline-manager`) configures a developer's workstation, not a
      // deployment, so its env is documented by `--help` rather than here.
      if (root.includes(join('packages', 'pipeline-manager'))) continue;
      for (const file of walk(root)) {
        for (const match of readFileSync(file, 'utf8').matchAll(RAW_READ)) {
          const name = match[1] ?? match[2];
          const sites = found.get(name) ?? [];
          sites.push(file.slice(REPO_ROOT.length + 1));
          found.set(name, sites);
        }
      }
    }
    return found;
  }

  it('finds the raw reads at all', () => {
    // Guards a vacuous pass, and pins one known raw read so a regex change that
    // stops matching `process.env.X` cannot read as "nothing undocumented".
    const found = rawReads();
    expect(found.size).toBeGreaterThan(100);
    expect(found.has('PLUGIN_VULN_WAIVERS')).toBe(true);
  });

  it('expands pattern rows, so a documented family covers its members', () => {
    // The check below is only sound if expansion works; assert it directly.
    expect(documented.has('BILLING_PLAN_PRO_MONTHLY')).toBe(true);
    expect(documented.has('BILLING_PLAN_UNLIMITED_ANNUAL')).toBe(true);
    expect(documented.has('GITLAB_AUTHORIZE_URL')).toBe(true);
    expect(documented.has('LINKEDIN_USERINFO_URL')).toBe(true);
    // And is not a wildcard that would make everything pass.
    expect(documented.has('BILLING_PLAN_NOPE_MONTHLY')).toBe(false);
  });

  it('documents every raw process.env read, or states why it is not ours', () => {
    const undocumented = [...rawReads().entries()]
      .filter(([name]) => !documented.has(name) && !NOT_OUR_CONFIG.has(name))
      .map(([name, sites]) => `${name} (read in ${sites[0]})`)
      .sort();

    expect(undocumented).toEqual([]);
  });

  it('keeps the not-ours list honest — every entry is still read somewhere', () => {
    // A name that no longer appears in the source is a stale exemption, and a
    // stale exemption is how a real knob gets silently excused later.
    const read = new Set(rawReads().keys());
    expect([...NOT_OUR_CONFIG].filter((name) => !read.has(name))).toEqual([]);
  });
});

describe('every variable a deployment actually sets is documented', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const documented = documentedNames(doc);

  it.each(ENV_FILES)('%s', (relative) => {
    const text = readFileSync(join(REPO_ROOT, relative), 'utf8');
    const set = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    // Guards a vacuous pass: an unreadable or renamed file would otherwise
    // report nothing undocumented.
    expect(set.length).toBeGreaterThan(200);
    const undocumented = [...new Set(set)]
      .filter((name) => !documented.has(name) && !NOT_OUR_CONFIG.has(name))
      .sort();
    expect(undocumented).toEqual([]);
  });
});
