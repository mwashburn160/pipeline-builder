#!/usr/bin/env node
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-route first-load JS budget, enforced after `next build` (projen
 * `post-compile`, so every `build` — local and CI — runs it).
 *
 * FIRST-LOAD JS for a pages-router route is every `.js` chunk the browser must
 * fetch before the page can hydrate: the `/_app` chunks plus the page's own,
 * each counted once, as `.next/build-manifest.json` lists them (this app has no
 * `app/` directory, so there is no app-build-manifest; `rootMainFiles` is empty
 * for the pages router but is counted for completeness). CSS is not JS and the
 * `nomodule` polyfills are never fetched by a modern browser, so neither counts.
 * Sizes are GZIPPED — what crosses the wire — with zlib's default level.
 *
 * Budgets live in `bundle-budgets.json` as gzipped BYTES per route. A route
 * over budget fails; so does a route with NO budget, so a new page cannot ship
 * unmeasured. After an intentional size change, re-baseline with
 *   node scripts/check-bundle-budget.mjs --update
 * which writes every route at its current size plus 10% headroom, rounded up
 * to a whole KiB — and review the diff like any other.
 *
 * Usage: check-bundle-budget.mjs [--next-dir .next] [--budgets bundle-budgets.json] [--update]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEADROOM = 1.1;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const nextDir = resolve(arg('--next-dir', join(FRONTEND, '.next')));
const budgetsFile = resolve(arg('--budgets', join(FRONTEND, 'bundle-budgets.json')));
const update = process.argv.includes('--update');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const manifestFile = join(nextDir, 'build-manifest.json');
if (!existsSync(manifestFile)) {
  fail(`check-bundle-budget: ${manifestFile} not found — run \`next build\` first.`);
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const pages = manifest.pages ?? {};

const gzCache = new Map();
function gzBytes(file) {
  if (!gzCache.has(file)) {
    const full = join(nextDir, file);
    if (!existsSync(full)) fail(`check-bundle-budget: ${file} is listed in build-manifest.json but missing on disk.`);
    gzCache.set(file, gzipSync(readFileSync(full)).length);
  }
  return gzCache.get(file);
}

const shared = [...(pages['/_app'] ?? []), ...(manifest.rootMainFiles ?? [])];
/** route -> gzipped first-load JS bytes, in route order. */
const sizes = Object.keys(pages)
  // `/_app` is in every route already; a route with a file extension
  // (`/robots.txt`, `/sitemap.xml`) is server-rendered text that loads no JS.
  .filter((route) => route !== '/_app' && !/\.[a-z]+$/.test(route))
  .sort()
  .map((route) => {
    const files = new Set([...shared, ...pages[route]].filter((f) => f.endsWith('.js')));
    let bytes = 0;
    for (const f of files) bytes += gzBytes(f);
    return [route, bytes];
  });

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

if (update) {
  const routes = Object.fromEntries(sizes.map(([route, bytes]) => [route, Math.ceil((bytes * HEADROOM) / 1024) * 1024]));
  writeFileSync(budgetsFile, `${JSON.stringify({
    $comment: 'Gzipped first-load JS budget per route, in bytes (scripts/check-bundle-budget.mjs). Re-baseline with `node scripts/check-bundle-budget.mjs --update` after an intentional change.',
    routes,
  }, null, 2)}\n`);
  process.stdout.write(`check-bundle-budget: wrote ${sizes.length} budgets to ${budgetsFile}\n`);
  process.exit(0);
}

if (!existsSync(budgetsFile)) fail(`check-bundle-budget: ${budgetsFile} not found — create it with --update.`);
const budgets = JSON.parse(readFileSync(budgetsFile, 'utf8')).routes ?? {};

const over = [];
const missing = [];
const width = Math.max(...sizes.map(([r]) => r.length), 5);
for (const [route, bytes] of sizes) {
  const budget = budgets[route];
  if (typeof budget !== 'number') {
    missing.push(route);
    continue;
  }
  const line = `  ${route.padEnd(width)}  ${kb(bytes).padStart(10)} / ${kb(budget).padStart(10)}`;
  if (bytes > budget) over.push(`${line}  (+${kb(bytes - budget)})`);
  else process.stdout.write(`${line}\n`);
}

if (over.length || missing.length) {
  const parts = [];
  if (over.length) parts.push(`First-load JS over budget (gzipped):\n${over.join('\n')}`);
  if (missing.length) parts.push(`Routes with no budget in ${budgetsFile}:\n${missing.map((r) => `  ${r}`).join('\n')}`);
  parts.push('Shrink the route (next/dynamic, lighter imports — `npx next analyze` shows what is in it), or, for an intentional change, re-baseline with `node scripts/check-bundle-budget.mjs --update` and commit the diff.');
  fail(parts.join('\n\n'));
}
process.stdout.write(`check-bundle-budget: ${sizes.length} routes within budget.\n`);
