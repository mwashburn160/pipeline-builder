#!/usr/bin/env node
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Emit the promtail `replace` stages that implement ingest-time masking (L3)
 * from api-core's SENSITIVE_VALUE_PATTERNS — the single source of truth shared
 * with the logger and platform's log-read path.
 *
 * L3 is the authoritative masking layer: read-time masking only hides the
 * display, leaving the secret searchable and turning search into an oracle.
 * See packages/api-core/src/utils/sensitive-patterns.ts.
 *
 * Usage:
 *   node scripts/gen-promtail-masking.mjs            # print the YAML block
 *   node scripts/gen-promtail-masking.mjs --write    # rewrite the block in every config
 *   node scripts/gen-promtail-masking.mjs --check    # verify configs are current
 *
 * Run --write after editing SENSITIVE_VALUE_PATTERNS, having rebuilt api-core
 * (this reads its BUILT lib, so a source-only edit will not be picked up).
 *
 * The block is delimited in each promtail config by BEGIN/END markers; --check
 * (run in CI) fails if a config has drifted from this generator.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export const BEGIN = '# BEGIN generated-masking (scripts/gen-promtail-masking.mjs) — do not edit by hand';
export const END = '# END generated-masking';

export const CONFIGS = [
  'deploy/local/docker/config/promtail/promtail-config.yml',
  'deploy/local/minikube/config/promtail/promtail-config.yml',
  'deploy/aws/eks/config/promtail/promtail-config.yml',
  'deploy/aws/ec2/config/promtail/promtail-config.yml',
];

/** YAML single-quoted scalar: the only escape is a doubled quote. */
function yamlQuote(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

export async function renderBlock(indent = '      ') {
  const { SENSITIVE_VALUE_PATTERNS } = await import(
    join(ROOT, 'packages/api-core/lib/utils/sensitive-patterns.js')
  );
  const lines = [BEGIN];
  for (const p of SENSITIVE_VALUE_PATTERNS) {
    if (p.re2 === null) {
      lines.push(`# ${p.name}: Node-side only (needs lookaround / spans lines; RE2 cannot express it)`);
      continue;
    }
    lines.push(`# ${p.name}`);
    lines.push('- replace:');
    lines.push(`    expression: ${yamlQuote(p.re2)}`);
    lines.push(`    replace: ${yamlQuote(p.replacement)}`);
  }
  lines.push(END);
  return lines.map((l) => indent + l).join('\n');
}

function extractBlock(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1) return null;
  return text.slice(start, end + END.length);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const block = await renderBlock();
  if (process.argv.includes('--write')) {
    for (const rel of CONFIGS) {
      const path = join(ROOT, rel);
      const text = readFileSync(path, 'utf8');
      const start = text.indexOf(BEGIN);
      const end = text.indexOf(END);
      if (start === -1 || end === -1) {
        console.error(`no generated-masking block to replace in ${rel} — insert one first`);
        process.exitCode = 1;
        continue;
      }
      // Preserve the block's existing indentation rather than assuming a depth.
      const lineStart = text.lastIndexOf('\n', start) + 1;
      const indent = text.slice(lineStart, start);
      const rendered = (await renderBlock(indent)).slice(indent.length);
      const next = text.slice(0, start) + rendered + text.slice(end + END.length);
      if (next !== text) {
        writeFileSync(path, next);
        console.log('rewrote', rel);
      } else {
        console.log('unchanged', rel);
      }
    }
  } else if (process.argv.includes('--check')) {
    const expected = extractBlock(block.split('\n').map((l) => l.trimStart()).join('\n'));
    let failed = 0;
    for (const rel of CONFIGS) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      const found = extractBlock(text.split('\n').map((l) => l.trimStart()).join('\n'));
      if (found === null) {
        console.error(`MISSING generated-masking block: ${rel}`);
        failed++;
      } else if (found !== expected) {
        console.error(`STALE generated-masking block: ${rel} (re-run scripts/gen-promtail-masking.mjs)`);
        failed++;
      }
    }
    if (failed) process.exit(1);
    console.log(`generated-masking block is current in ${CONFIGS.length} promtail configs`);
  } else {
    console.log(block);
  }
}
