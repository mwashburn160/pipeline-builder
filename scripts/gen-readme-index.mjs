#!/usr/bin/env node
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate the GitHub Pages landing page (`index.md`) from `README.md`, so the
 * two stop drifting apart: README.md is the one place the overview, feature
 * sections, deploy table and docs index are written.
 *
 * Transformations, README → index.md:
 *   - the README's centered HTML banner (everything before `## Overview`) is
 *     replaced by the Jekyll front matter, a page title and the link bar;
 *   - repo-relative links become site links: `docs/x.md` → `{{ '/docs/x.html' |
 *     relative_url }}` (a directory README → its directory), and any other
 *     repo path (deploy/…, LICENSE) → its GitHub blob/tree URL;
 *   - text containing `{{ … }}` (the synth-time template syntax) is wrapped in
 *     `{% raw %}` so Liquid leaves it alone.
 *
 * Usage:
 *   node scripts/gen-readme-index.mjs           # rewrite index.md
 *   node scripts/gen-readme-index.mjs --check   # exit 1 if index.md is stale (CI)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/mwashburn160/pipeline-builder';

const HEADER = `---
layout: default
title: Self-Service CI/CD for AWS
description: Self-hosted, self-service AWS CodePipelines. Developers ship compliant pipelines in minutes from a dashboard, CLI, CDK, or AI prompt; platform teams govern them with policy-as-code, golden paths, and a signed plugin ecosystem.
permalink: /
---

<!-- GENERATED from README.md by scripts/gen-readme-index.mjs. Edit README.md, then regenerate. -->

# Self-Service CI/CD for AWS

**Golden paths for developers, guardrails for platform teams.**

[**View on GitHub**](${REPO_URL}) · [**Documentation**]({{ '/docs/' | relative_url }}) · [**Plugin Catalog**]({{ '/docs/plugins/' | relative_url }}) · [**API Reference**]({{ '/docs/api-reference.html' | relative_url }})

`;

/** A repo-relative link target as a site (docs) or GitHub URL. */
function siteLink(target) {
  const [path, anchor] = target.split('#');
  const hash = anchor ? `#${anchor}` : '';
  if (path.startsWith('docs/')) {
    const page = path.endsWith('README.md') ? path.slice(0, -'README.md'.length)
      : path.endsWith('.md') ? `${path.slice(0, -3)}.html` : path;
    return `{{ '/${page}${hash}' | relative_url }}`;
  }
  return `${REPO_URL}/${path.endsWith('/') ? 'tree' : 'blob'}/main/${path}${hash}`;
}

/** Wrap every `{{ … }}` outside the links we generate: fenced blocks whole, inline spans alone. */
function protectLiquid(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    if (fence) {
      fence.push(line);
      if (/^```/.test(line)) {
        const block = fence.join('\n');
        out.push(block.includes('{{') ? `{% raw %}\n${block}\n{% endraw %}` : block);
        fence = null;
      }
      continue;
    }
    if (/^```/.test(line)) { fence = [line]; continue; }
    out.push(line.replace(/`[^`]*\{\{[^`]*`/g, (span) => `{% raw %}${span}{% endraw %}`));
  }
  if (fence) out.push(...fence);
  return out.join('\n');
}

export function render(readme) {
  const start = readme.indexOf('## Overview');
  if (start < 0) throw new Error('README.md: no "## Overview" heading to start the page from');
  let body = readme.slice(start);
  body = protectLiquid(body);
  // Links last, so the generated {{ … | relative_url }} is not raw-wrapped.
  body = body.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_m, target) => `](${siteLink(target)})`);
  return HEADER + body;
}

function main() {
  const want = render(readFileSync(join(ROOT, 'README.md'), 'utf8'));
  const path = join(ROOT, 'index.md');
  const have = readFileSync(path, 'utf8');
  if (have === want) return;
  if (process.argv.includes('--check')) {
    console.error('index.md is stale: edit README.md, then run node scripts/gen-readme-index.mjs');
    process.exit(1);
  }
  writeFileSync(path, want);
  console.log('wrote index.md');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
