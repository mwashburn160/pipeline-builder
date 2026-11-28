// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/check-bundle-budget.mjs`: the per-route first-load JS budget the
 * frontend build enforces (projen `post-compile`, after `next build`).
 *
 * First-load JS for a pages-router route is every `.js` chunk the browser must
 * fetch before it can hydrate that page: the `/_app` chunks plus the page's own,
 * de-duplicated, as `.next/build-manifest.json` lists them. Sizes are GZIPPED,
 * because that is what crosses the wire. Budgets live in `bundle-budgets.json`;
 * a route over its budget, or a route with no budget at all, fails the build.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const FRONTEND = resolve(__dirname, '..');
const SCRIPT = join(FRONTEND, 'scripts', 'check-bundle-budget.mjs');

/** A fake `.next` with incompressible chunks of known size. */
function fakeBuild(chunks: Record<string, number>, pages: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-budget-'));
  mkdirSync(join(dir, 'static', 'chunks'), { recursive: true });
  const gz: Record<string, number> = {};
  for (const [name, bytes] of Object.entries(chunks)) {
    const body = randomBytes(bytes);
    writeFileSync(join(dir, 'static', 'chunks', name), body);
    gz[name] = gzipSync(body).length;
  }
  const manifest = {
    pages: Object.fromEntries(Object.entries(pages).map(([r, files]) => [r, files.map((f) => `static/chunks/${f}`)])),
    polyfillFiles: [], lowPriorityFiles: [], rootMainFiles: [],
  };
  writeFileSync(join(dir, 'build-manifest.json'), JSON.stringify(manifest));
  return { dir, gz };
}

function run(nextDir: string, budgets: string, ...extra: string[]) {
  return spawnSync(process.execPath, [SCRIPT, '--next-dir', nextDir, '--budgets', budgets, ...extra], { encoding: 'utf8' });
}

const PAGES = {
  '/_app': ['app.js', 'shared.js', 'app.css'],
  '/': ['index.js', 'shared.js'],
  '/dashboard/pipelines/[id]': ['pipeline.js'],
};
const CHUNKS = { 'app.js': 40_000, 'shared.js': 10_000, 'index.js': 5_000, 'pipeline.js': 20_000, 'app.css': 30_000 };

describe('check-bundle-budget', () => {
  it('passes when every route is within budget, counting _app + page chunks once each, gzipped, JS only', () => {
    const { dir, gz } = fakeBuild(CHUNKS, PAGES);
    const indexBytes = gz['app.js']! + gz['shared.js']! + gz['index.js']!; // shared.js once; app.css not JS
    const budgets = join(dir, 'budgets.json');
    writeFileSync(budgets, JSON.stringify({ routes: { '/': indexBytes, '/dashboard/pipelines/[id]': gz['app.js']! + gz['shared.js']! + gz['pipeline.js']! } }));
    const r = run(dir, budgets);
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain('/dashboard/pipelines/[id]');
  });

  it('fails, naming the route and both sizes, when a route exceeds its budget', () => {
    const { dir, gz } = fakeBuild(CHUNKS, PAGES);
    const budgets = join(dir, 'budgets.json');
    const indexBytes = gz['app.js']! + gz['shared.js']! + gz['index.js']!;
    writeFileSync(budgets, JSON.stringify({ routes: { '/': indexBytes - 1, '/dashboard/pipelines/[id]': 1_000_000 } }));
    const r = run(dir, budgets);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/over budget/i);
    expect(r.stderr).toContain(`/ `);
    expect(r.stderr).not.toContain('/dashboard/pipelines/[id]');
  });

  it('fails when a route has no budget, so a new page cannot ship unmeasured', () => {
    const { dir } = fakeBuild(CHUNKS, PAGES);
    const budgets = join(dir, 'budgets.json');
    writeFileSync(budgets, JSON.stringify({ routes: { '/': 1_000_000 } }));
    const r = run(dir, budgets);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('/dashboard/pipelines/[id]');
    expect(r.stderr).toMatch(/no budget/i);
  });

  it('--update writes every route at current size plus 10% headroom (rounded up to 1 KB)', () => {
    const { dir, gz } = fakeBuild(CHUNKS, PAGES);
    const budgets = join(dir, 'budgets.json');
    const r = run(dir, budgets, '--update');
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(budgets, 'utf8')) as { routes: Record<string, number> };
    const index = gz['app.js']! + gz['shared.js']! + gz['index.js']!;
    expect(written.routes['/']).toBe(Math.ceil((index * 1.1) / 1024) * 1024);
    expect(Object.keys(written.routes).sort()).toEqual(['/', '/dashboard/pipelines/[id]']);
    // …and the build it was written from passes it.
    expect(run(dir, budgets).status).toBe(0);
  });

  it('skips server-rendered text routes (robots.txt, sitemap.xml), which load no JS', () => {
    const { dir } = fakeBuild(CHUNKS, { ...PAGES, '/robots.txt': ['index.js'], '/sitemap.xml': ['index.js'] });
    const budgets = join(dir, 'budgets.json');
    expect(run(dir, budgets, '--update').status).toBe(0);
    const written = JSON.parse(readFileSync(budgets, 'utf8')) as { routes: Record<string, number> };
    expect(Object.keys(written.routes).sort()).toEqual(['/', '/dashboard/pipelines/[id]']);
  });

  it('fails loudly when there is no build to measure', () => {
    const r = run(join(tmpdir(), 'pb-budget-missing'), join(FRONTEND, 'bundle-budgets.json'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/build-manifest\.json/);
  });

  it('the checked-in budget file covers every frontend page', () => {
    const budgets = JSON.parse(readFileSync(join(FRONTEND, 'bundle-budgets.json'), 'utf8')) as { routes: Record<string, number> };
    expect(Object.keys(budgets.routes)).toEqual(expect.arrayContaining(['/', '/dashboard', '/dashboard/pipelines/[id]', '/login']));
    for (const v of Object.values(budgets.routes)) expect(v).toBeGreaterThan(0);
  });
});
