// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The social cards must carry the CURRENT positioning, and every page must
 * point at a card that exists.
 *
 * Nothing in the build reads `assets/*.png`, `_config.yml` or a page's `image:`
 * front matter, so a stale card survives a green `nx run-many -t build --all`
 * indefinitely. One did: the README, index.md, every doc and the projen
 * keywords were repositioned from "Self-Service CI/CD for AWS" to software
 * factories, while `assets/og-image.png` — the card rendered for EVERY shared
 * link to the docs site, the landing page, the register page and the public
 * plugin directory — kept the retired headline. The most-seen surface was the
 * last one to change, and the `_config.yml` comment above it even asserted it
 * already matched.
 *
 * The cards are produced by `scripts/gen-og-images.mjs`, which needs headless
 * Chrome, so this cannot re-render them to compare pixels. It checks the things
 * that actually went wrong instead: the headline text in the generator (the
 * source the PNGs come from), that every referenced card exists at the right
 * size, and that the retired framing is gone from the surfaces that quote it.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

const GENERATOR = 'scripts/gen-og-images.mjs';

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

/** Card name -> its two headline lines, parsed out of the generator's CARDS map. */
function cards(): Map<string, string[]> {
  const src = read(GENERATOR);
  const out = new Map<string, string[]>();
  const re = /'(og-image[\w-]*)':\s*\{\s*title:\s*\[([^\]]+)\]/g;
  for (const m of src.matchAll(re)) {
    out.set(m[1], [...m[2].matchAll(/'([^']*)'/g)].map((t) => t[1]));
  }
  return out;
}

/** The `image:` front-matter value of every Jekyll page that sets one. */
function pageImages(): Array<{ page: string; image: string }> {
  const out: Array<{ page: string; image: string }> = [];
  for (const dir of ['', 'docs']) {
    const abs = dir ? join(REPO_ROOT, dir) : REPO_ROOT;
    for (const f of readdirSync(abs)) {
      if (!f.endsWith('.md')) continue;
      const rel = dir ? `${dir}/${f}` : f;
      const m = /^image:\s*(\S+)\s*$/m.exec(read(rel));
      if (m) out.push({ page: rel, image: m[1] });
    }
  }
  return out;
}

/** Width and height from a PNG's IHDR, which is always the first chunk. */
function pngSize(rel: string): { w: number; h: number } {
  const b = readFileSync(join(REPO_ROOT, rel));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe('social cards', () => {
  const CARDS = cards();

  it('parses the generator (guards a vacuous pass)', () => {
    // Every assertion below is driven off this map; a parse failure would make
    // all of them pass by checking nothing.
    expect(CARDS.size).toBeGreaterThanOrEqual(7);
    expect(CARDS.get('og-image')).toHaveLength(2);
  });

  it('headlines the default card with the site title', () => {
    // This is the pairing that broke. `_config.yml`'s `title` is what the page
    // says; the default card is what a shared link SHOWS. They have to agree,
    // because the card is the one most people see first.
    const title = /^title:\s*(.+)$/m.exec(read('_config.yml'))![1].trim();
    expect(CARDS.get('og-image')!.join(' ')).toBe(title);
  });

  it('keeps the retired CI/CD positioning out of the cards and their metadata', () => {
    // The surfaces that quote the headline: the generator the PNGs come from,
    // and the pages whose <meta> sits beside the card in a link preview.
    const retired = /Self-Service CI\/CD|Production-Ready CI\/CD|self-service[^.\n]{0,30}CI\/CD|AWS CI\/CD/i;
    const surfaces = [
      GENERATOR, '_config.yml', 'README.md', 'index.md',
      'frontend/pages/index.tsx',
      'frontend/pages/auth/register.tsx',
      'frontend/pages/invite/accept.tsx',
    ];
    const bad: string[] = [];
    for (const s of surfaces) {
      read(s).split('\n').forEach((line, i) => {
        if (retired.test(line)) bad.push(`${s}:${i + 1} ${line.trim().slice(0, 80)}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('commits a PNG for every card the generator defines', () => {
    const missing = [...CARDS.keys()].filter((n) => !existsSync(join(REPO_ROOT, 'assets', `${n}.png`)));
    expect(missing).toEqual([]);
  });

  it('points every page at a card that exists', () => {
    const images = pageImages();
    expect(images.length).toBeGreaterThanOrEqual(10); // guards a vacuous pass
    const broken = images
      .filter((p) => !existsSync(join(REPO_ROOT, p.image.replace(/^\//, ''))))
      .map((p) => `${p.page} -> ${p.image}`);
    expect(broken).toEqual([]);
  });

  it('keeps every card at the 1200x630 Open Graph size', () => {
    // Off-size cards are cropped by the scrapers rather than rejected, so this
    // degrades silently too.
    const wrong = [...CARDS.keys()]
      .map((n) => ({ n, ...pngSize(`assets/${n}.png`) }))
      .filter((c) => c.w !== 1200 || c.h !== 630)
      .map((c) => `${c.n}: ${c.w}x${c.h}`);
    expect(wrong).toEqual([]);
  });

  it('keeps the frontend copies in sync with assets/', () => {
    // gen-og-images.mjs copies these two into frontend/public; a card
    // regenerated without re-running the copy leaves the dashboard on the old
    // art while the docs site moves on.
    const copies = [...read(GENERATOR).matchAll(/FRONTEND_COPIES = \[([^\]]+)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]));
    expect(copies.length).toBeGreaterThan(0);
    const drifted: string[] = [];
    for (const n of copies) {
      const a = join(REPO_ROOT, 'assets', `${n}.png`);
      const b = join(REPO_ROOT, 'frontend', 'public', `${n}.png`);
      if (!existsSync(b)) { drifted.push(`${n}: missing in frontend/public`); continue; }
      if (statSync(a).size !== statSync(b).size || !readFileSync(a).equals(readFileSync(b))) {
        drifted.push(`${n}: frontend/public copy differs from assets/`);
      }
    }
    expect(drifted).toEqual([]);
  });
});
