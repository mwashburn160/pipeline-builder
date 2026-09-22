#!/usr/bin/env node
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate every deploy target's `.env.example` from ONE template,
 * `deploy/shared/env/env.example.in`, so a knob added, renamed or re-documented
 * lands on all four targets at once instead of drifting per copy.
 *
 * Template format — plain `.env` text plus block directives on their own lines:
 *
 *   #@only <target> [<target> …]   lines up to the matching `#@end` are emitted
 *   …                              only for the listed targets
 *   #@end
 *
 * Every other line is emitted for every target. Blocks do not nest. Targets:
 * docker, minikube, ec2, eks.
 *
 * Usage:
 *   node scripts/gen-env-examples.mjs           # rewrite the four .env.example files
 *   node scripts/gen-env-examples.mjs --check   # exit 1 if any file is stale (CI)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE = 'deploy/shared/env/env.example.in';

/** target id → the .env.example it produces. */
export const TARGETS = {
  docker: 'deploy/local/docker/.env.example',
  minikube: 'deploy/local/minikube/.env.example',
  ec2: 'deploy/aws/ec2/.env.example',
  eks: 'deploy/aws/eks/.env.example',
};

/** Render the template for one target. Throws on a malformed directive. */
export function render(template, target) {
  if (!(target in TARGETS)) throw new Error(`unknown target: ${target}`);
  const out = [];
  let only = null; // null = outside any block; otherwise the block's target list
  template.split('\n').forEach((line, i) => {
    if (line.startsWith('#@only ')) {
      if (only) throw new Error(`${TEMPLATE}:${i + 1}: nested #@only`);
      only = line.slice('#@only '.length).trim().split(/\s+/);
      for (const t of only) if (!(t in TARGETS)) throw new Error(`${TEMPLATE}:${i + 1}: unknown target "${t}"`);
      return;
    }
    if (line === '#@end') {
      if (!only) throw new Error(`${TEMPLATE}:${i + 1}: #@end without #@only`);
      only = null;
      return;
    }
    if (line.startsWith('#@')) throw new Error(`${TEMPLATE}:${i + 1}: unknown directive "${line}"`);
    if (!only || only.includes(target)) out.push(line);
  });
  if (only) throw new Error(`${TEMPLATE}: unterminated #@only block`);
  return out.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const template = readFileSync(join(ROOT, TEMPLATE), 'utf8');
  const stale = [];
  for (const [target, file] of Object.entries(TARGETS)) {
    const want = render(template, target);
    const path = join(ROOT, file);
    let have = null;
    try { have = readFileSync(path, 'utf8'); } catch { /* missing = stale */ }
    if (have === want) continue;
    if (check) stale.push(file);
    else { writeFileSync(path, want); console.log(`wrote ${file}`); }
  }
  if (stale.length) {
    console.error(`stale (edit ${TEMPLATE}, then run node scripts/gen-env-examples.mjs):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
