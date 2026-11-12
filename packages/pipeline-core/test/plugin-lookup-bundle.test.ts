// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The PluginLookup Lambda is built ONCE, at release, and shipped prebuilt —
 * three files have to agree on it, and nothing else ties them together:
 *
 *  1. the release bundle (`post-compile` esbuild `--outfile`),
 *  2. what the construct deploys (`Code.fromAsset(.../handlers/bundle)` +
 *     `handler: 'index.handler'`), and
 *  3. what the package actually publishes (`.npmignore`).
 *
 * `plugin-lookup.test.ts` mocks `Code.fromAsset`, so moving the outfile,
 * renaming the handler or narrowing the published files all still pass there
 * while every deploy fails — the same silent shape as the `NodejsFunction`
 * lock file the old build depended on and `pnpm pack` stripped. These checks
 * read the real files instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';

const PKG = join(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(join(PKG, rel), 'utf-8');

const postCompile: string[] = (
  JSON.parse(read('.projen/tasks.json')).tasks['post-compile'].steps as Array<{ exec?: string }>
).map((s) => s.exec ?? '');
const bundleStep = postCompile.find((e) => e.startsWith('esbuild ') && e.includes('plugin-lookup-handler'));
const outfile = bundleStep && /--outfile=(\S+)/.exec(bundleStep)?.[1];
const construct = read('src/pipeline/plugin-lookup.ts');

describe('PluginLookup ships a prebuilt Lambda the construct can deploy', () => {
  it('is bundled at release by post-compile', () => {
    expect(bundleStep).toBeDefined();
    expect(bundleStep).toContain('--bundle');
    // aws-cdk-lib in a Lambda bundle is hundreds of MB and OOM-kills esbuild.
    expect(bundleStep).toContain('--external:aws-cdk-lib');
  });

  it('writes the bundle where the construct points Code.fromAsset, under the handler name it names', () => {
    expect(construct).toMatch(/Code\.fromAsset\(join\(MODULE_DIR, '\/\.\.\/handlers\/bundle'\)\)/);
    expect(construct).toMatch(/handler: 'index\.handler'/);
    // MODULE_DIR is lib/pipeline at runtime, so the asset dir is lib/handlers/bundle.
    expect(outfile).toMatch(/^lib\/handlers\/bundle\/index\.m?js$/);
  });

  it('names an ESM bundle .mjs — the asset directory carries no package.json to say "module"', () => {
    // Lambda decides the module system from the file: an ESM bundle saved as
    // `index.js` beside no `"type": "module"` is loaded as CommonJS and dies at
    // init on its first `import`.
    expect(bundleStep).toContain('--format=esm');
    expect(outfile).toBe('lib/handlers/bundle/index.mjs');
  });

  it('is published: .npmignore excludes nothing under lib/', () => {
    // Every line that is not a comment or a re-include must leave lib/ alone;
    // a `/lib/` or `*.mjs` rule here would ship a package whose asset is gone.
    const rules = read('.npmignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
    const hitsBundle = rules.filter((r) => /^\/?lib(\/|$)|\*\.mjs$|^\*$|^\/?\*\*$|bundle/.test(r));
    expect(hitsBundle).toEqual([]);
  });
});
