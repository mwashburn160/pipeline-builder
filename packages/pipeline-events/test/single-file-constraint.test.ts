// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards the deployment constraint documented at the top of `src/index.ts`.
 *
 * `pipeline-manager infra setup-events` ships this Lambda by copying the
 * compiled `lib/index.js` as ONE file into the zip
 * (`commands/setup-events.ts`: `copyFileSync(handlerSrc, index.mjs)` then
 * `zip -j <zip> index.mjs`). `zip -j` FLATTENS — nothing else from `lib/` is in
 * the archive, and nothing bundles the handler. So the moment `src/index.ts`
 * gains a relative import of a sibling module, the emitted `lib/index.js`
 * references a file that isn't in the zip and the Lambda dies at init with
 * "Cannot find module './…'".
 *
 * That failure is invisible to `tsc`, to `jest` (which resolves from `src/`),
 * and to code review — it only appears on the next deploy, in production. The
 * file's header comment says so, but a comment can't fail a build. This can.
 *
 * If this genuinely needs splitting, add a bundling step (esbuild → one
 * self-contained `lib/index.js`, with `@aws-sdk/*` left external) to the build
 * FIRST, then delete this test along with the header comment.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('single-file deployment constraint', () => {
  it('keeps src/ to exactly one module', () => {
    const modules = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    expect(modules).toEqual(['index.ts']);
  });

  it('has no relative import — the zip contains index.mjs and nothing else', () => {
    const source = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    // Static `import … from './x'` / `'../x'` and dynamic `import('./x')`.
    const relative = source.match(/(?:from|import)\s*\(?\s*['"]\.{1,2}\//g) ?? [];
    expect(relative).toEqual([]);
  });
});
