// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The docs site (Jekyll, GitHub Pages) and the app (Next.js) share a palette but
 * no code: `assets/css/style.scss` PORTS the `--pb-*` tokens out of
 * `frontend/src/styles/globals.css` because the two build systems cannot import
 * from each other.
 *
 * A duplicated constant with no guard is the failure mode this repo keeps
 * hitting — a value gets bumped in one place, the copy is forgotten, and nothing
 * fails until someone looks. This compares them directly, so a colour changed in
 * the app fails here naming the token rather than quietly drifting the docs.
 */

import { describe, it, expect } from '@jest/globals';
import { read } from '../src/index.js';

/** `--pb-name: value;` pairs inside the first `{ … }` after `selector`. */
function tokensIn(css: string, selector: RegExp): Record<string, string> {
  const at = css.search(selector);
  if (at === -1) return {};
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--pb-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** The colour tokens only — fonts and shadows are delivered differently on each
 *  side (self-hosted vs CDN), so comparing them would fail for a real reason. */
const COLOUR = /^--pb-(bg|surface|surface-muted|border|text|text-muted|text-subtle|brand|brand-strong|accent|success|danger)$/;
const coloursOf = (t: Record<string, string>) =>
  Object.fromEntries(Object.entries(t).filter(([k]) => COLOUR.test(k)));

describe('docs site theme tracks the app palette', () => {
  const app = read('frontend/src/styles/globals.css');
  const site = read('assets/css/style.scss');

  it('ships the stylesheet with Jekyll front matter, or Sass never runs', () => {
    // Without leading front matter Jekyll copies the file verbatim: the
    // `@import "{{ site.theme }}"` is served as literal text and the site
    // renders unstyled with a 200. Nothing else catches that.
    expect(site.startsWith('---\n')).toBe(true);
    expect(site).toContain('@import "{{ site.theme }}"');
  });

  it('uses the same LIGHT palette as the app', () => {
    const appLight = coloursOf(tokensIn(app, /:root\s*\{/));
    const siteLight = coloursOf(tokensIn(site, /^:root\s*\{/m));
    expect(Object.keys(appLight).length).toBeGreaterThan(5);
    expect(siteLight).toEqual(appLight);
  });

  it('uses the same DARK palette as the app', () => {
    // The app switches on a `.dark` class (app state); the docs switch on
    // `prefers-color-scheme` plus a `[data-theme]` override. Different trigger,
    // same values — that is what is compared.
    const appDark = coloursOf(tokensIn(app, /\.dark\s*\{/));
    const siteDark = coloursOf(tokensIn(site, /:root\[data-theme="dark"\]\s*\{/));
    expect(Object.keys(appDark).length).toBeGreaterThan(5);
    expect(siteDark).toEqual(appDark);
  });

  it('keeps the two dark blocks in the stylesheet identical to each other', () => {
    // `prefers-color-scheme` and the explicit `[data-theme="dark"]` override
    // must not disagree, or the toggle would change colours as well as mode.
    const media = coloursOf(tokensIn(site, /:root:not\(\[data-theme="light"\]\)\s*\{/));
    const explicit = coloursOf(tokensIn(site, /:root\[data-theme="dark"\]\s*\{/));
    expect(media).toEqual(explicit);
  });

  it('neutralises the theme rules that hardcode a LIGHT colour', () => {
    // jekyll-theme-minimal is a light theme: it hardcodes #e5e5e5 rules and a
    // white body. Porting a dark palette on top is not enough — anything the
    // override misses stays light and draws grey lines across a dark page,
    // which is exactly what shipped. Each of these was a visible defect.
    for (const rule of [
      /^\s*section\s*\{[^}]*border:\s*0/m, // theme: border:1px solid #e5e5e5
      /^\s*body\s*\{[^}]*padding:\s*0/m, // theme: padding:50px
      /^hr\s*\{[^}]*background:\s*var\(--pb-border\)/m, // theme uses a background, not a border
    ]) {
      expect(site).toMatch(rule);
    }
  });

  it('keeps a bold link looking like a link', () => {
    // `[**text**](url)` renders as <a><strong>, and a `strong { color }` rule
    // beats the inherited link colour — the intro nav row came out plain white.
    expect(site).toMatch(/a strong,\s*\n?\s*strong a\s*\{[^}]*color:\s*inherit/);
  });

  it('renders diagrams in the page\'s colour scheme, not mermaid\'s light default', () => {
    // `theme: 'default'` is mermaid's LIGHT theme; on the dark canvas it drew
    // pale boxes with dark-on-light text.
    const head = read('_includes/head-custom.html');
    expect(head).toContain('prefers-color-scheme: dark');
    expect(head).toMatch(/theme:\s*dark\s*\?\s*'dark'\s*:\s*'default'/);
    expect(head).not.toMatch(/mermaid\.initialize\(\{[^}]*theme:\s*'default'\s*\}/);
  });

  it('loads the same typefaces the app self-hosts', () => {
    // frontend/src/lib/fonts.ts is the source of truth for which faces the
    // product uses; the docs take them from the CDN but must not drift to a
    // different pairing.
    const fonts = read('frontend/src/lib/fonts.ts');
    expect(fonts).toContain('Fraunces');
    expect(fonts).toContain('IBM_Plex_Sans');
    const head = read('_includes/head-custom.html');
    expect(head).toContain('family=Fraunces');
    expect(head).toContain('IBM+Plex+Sans');
    expect(head).toContain('display=swap');
  });
});
