// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards the help corpus after the docs→help single-sourcing: every topic is
 * well-formed and renderable, ids are unique, and each GENERATED topic declares
 * the docs/*.md it came from (so the help↔docs link is explicit, not a silent
 * hand-copy). Regenerate with `npm run generate:help`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadHelpGroups, loadHelpTopics, type HelpTopic, type HelpTopicGroup } from '../src/lib/help';

describe('help corpus', () => {
  // The corpus is a dynamic import (it is ~1 MB of generated source and must
  // not sit in the shared bundle), so every case loads it first. `loadHelpGroups`
  // memoizes, so this is one evaluation for the whole file.
  let HELP_TOPICS: HelpTopic[];
  let HELP_GROUPS: HelpTopicGroup[];
  beforeAll(async () => {
    [HELP_TOPICS, HELP_GROUPS] = await Promise.all([loadHelpTopics(), loadHelpGroups()]);
  });
  it('every topic is well-formed (id, title, icon, non-empty sections)', () => {
    for (const t of HELP_TOPICS) {
      expect(typeof t.id).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.icon).toBeTruthy();
      expect(Array.isArray(t.sections)).toBe(true);
      expect(t.sections.length).toBeGreaterThan(0);
      // Every section has at least one content block.
      for (const s of t.sections) expect(s.blocks.length).toBeGreaterThan(0);
    }
  });

  it('topic ids are unique', () => {
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('generated topics declare a docs/ source (the single source of truth)', () => {
    // The topics generated from docs carry `sourceDoc`; there must be several.
    const generated = HELP_TOPICS.filter((t) => t.sourceDoc);
    expect(generated.length).toBeGreaterThanOrEqual(10);
    for (const t of generated) expect(t.sourceDoc).toMatch(/^docs\/.+\.md$/);
  });

  it('every group topic is also in the flat list', () => {
    const flat = new Set(HELP_TOPICS.map((t) => t.id));
    for (const g of HELP_GROUPS) for (const t of g.topics) expect(flat.has(t.id)).toBe(true);
  });

  // DRIFT GUARD. A new doc under docs/ is invisible in the help center until the
  // generator's MANIFEST maps it AND `loadHelpGroups` puts it in a category — two
  // edits nothing else forces. This fails on the first of them that is missed, so
  // the answer is either "map it" or "add it to the exclusion list below, with a
  // reason". Sub-directory docs (plugins/, runbooks/) are out of scope by the
  // same decision recorded in the generator.
  const NOT_IN_HELP = new Set([
    'README.md',           // the docs index — a list of links to the topics below
    'content-index.md',    // the A–Z keyword index — likewise all links
    'testing.md',          // repo-contributor conventions (mocks, coverage ratchets)
    'permission-contract.md', // hand-maintained review artifact, paired with a test
  ]);

  it('every product doc under docs/ is a help topic (or explicitly excluded)', () => {
    const docs = readdirSync(join(__dirname, '..', '..', 'docs')).filter((f) => f.endsWith('.md'));
    const sourced = new Set(HELP_TOPICS.map((t) => t.sourceDoc?.replace(/^docs\//, '')).filter(Boolean));
    const unmapped = docs.filter((d) => !NOT_IN_HELP.has(d) && !sourced.has(d));
    expect(unmapped).toEqual([]);
  });

  it('every generated topic is reachable from a category group', () => {
    const grouped = new Set(HELP_GROUPS.flatMap((g) => g.topics.map((t) => t.id)));
    const orphans = HELP_TOPICS.filter((t) => !grouped.has(t.id)).map((t) => t.id);
    expect(orphans).toEqual([]);
  });

  /**
   * FRESHNESS, as opposed to the shape checks above. Nothing re-runs
   * `generate:help` automatically, so a docs edit that skipped it shipped help
   * that disagreed with the product — the deploy topic went on telling operators
   * to use the dev password `SecurePassword123!` after the platform had started
   * refusing it as breached, because `docs/aws-deployment.md` was fixed and the
   * generated copy was not. A stale file is perfectly well-formed, so none of the
   * shape checks can see it.
   *
   * Compares the `SOURCE-SHA256` the generator stamps into each file against a
   * fresh hash of the doc it names — a string comparison, not a regeneration.
   * These live HERE rather than in a suite of their own on purpose: the frontend
   * jest run sits right at its parallel resource limit, and adding a 237th suite
   * reliably pushed unrelated render-heavy suites past their timeouts.
   */
  const GENERATED = join(__dirname, '..', 'src', 'lib', 'help', 'generated');
  const REPO = join(__dirname, '..', '..');

  /** The two header lines the generator stamps: which doc, and its digest. */
  const stamped = (file: string): { doc: string; sha: string } => {
    const head = readFileSync(join(GENERATED, file), 'utf8').slice(0, 512);
    const doc = /^\/\/ GENERATED FROM (\S+) /m.exec(head)?.[1];
    const sha = /^\/\/ SOURCE-SHA256: ([0-9a-f]{64})$/m.exec(head)?.[1];
    if (!doc || !sha) throw new Error(`${file} has no generator stamp — run \`npm run generate:help\``);
    return { doc, sha };
  };

  it('every generated topic records the digest of the doc it came from', () => {
    // Guards the guard: a file written by an older generator carries no stamp
    // and would otherwise be silently exempt from the freshness check below.
    const files = readdirSync(GENERATED).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) expect(() => stamped(f)).not.toThrow();
  });

  it('no generated topic is stale with respect to its source doc', () => {
    const stale = readdirSync(GENERATED).filter((f) => f.endsWith('.ts')).filter((f) => {
      const { doc, sha } = stamped(f);
      return createHash('sha256').update(readFileSync(join(REPO, doc))).digest('hex') !== sha;
    }).sort();
    expect({ stale, fix: 'npm run generate:help' }).toEqual({ stale: [], fix: 'npm run generate:help' });
  });
});
