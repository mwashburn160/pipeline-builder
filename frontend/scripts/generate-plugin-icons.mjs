// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Copy the curated plugin icon set into the frontend's static assets.
 *
 * Source: `deploy/plugins/_icons/<key>.svg` (one file per vendor/tool key) plus `SOURCES.md`, which records each
 * icon's source, licence and brand colour.
 *
 * Output:
 *   - `public/plugin-icons/<key>.<hash>.svg` — content-hashed, so the URL can be
 *     cached forever (`next.config.js` sends `immutable` for the prefix) and a
 *     changed logo is a new URL. The directory is emptied first, so a dropped
 *     key (a vendor's removal request) disappears from the build.
 *   - `src/generated/plugin-icons.ts` — the manifest `key → { url, hex, name }`
 *     the icon component resolves against. Icons are rendered by URL (`<img>` /
 *     CSS `mask-image`), never inlined, so none of them enter the JS bundle and
 *     an SVG can never run script.
 *
 * Every SVG is refused (the script exits non-zero) if it carries anything that
 * could execute or phone home: `<script>`, `on*=` handlers, `<foreignObject>`,
 * or an external `href`. The deploy-side SVG lint is the real gate; this is the
 * last check before a file is served from our origin.
 *
 * A missing `_icons/` directory is not an error: the manifest is simply empty
 * and every plugin falls back to its monogram or category glyph.
 *
 * Run: `node scripts/generate-plugin-icons.mjs` (from frontend/). Idempotent.
 * `PLUGIN_ICONS_SRC`, `PLUGIN_ICONS_PUBLIC_DIR` and `PLUGIN_ICONS_MANIFEST`
 * redirect input/output (the drift test regenerates into a temp dir).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..');
const SRC = process.env.PLUGIN_ICONS_SRC
  ? resolve(process.env.PLUGIN_ICONS_SRC)
  : join(FRONTEND, '..', 'deploy', 'plugins', '_icons');
const PUBLIC_DIR = process.env.PLUGIN_ICONS_PUBLIC_DIR
  ? resolve(process.env.PLUGIN_ICONS_PUBLIC_DIR)
  : join(FRONTEND, 'public', 'plugin-icons');
const MANIFEST = process.env.PLUGIN_ICONS_MANIFEST
  ? resolve(process.env.PLUGIN_ICONS_MANIFEST)
  : join(FRONTEND, 'src', 'generated', 'plugin-icons.ts');

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Anything in an SVG that could run, embed a document, or load from elsewhere. */
const UNSAFE = [
  [/<script\b/i, '<script>'],
  [/\son[a-z]+\s*=/i, 'an on* event handler'],
  [/<foreignObject\b/i, '<foreignObject>'],
  [/(?:xlink:)?href\s*=\s*["']\s*(?!#)[^"']*/i, 'an external href'],
  [/url\(\s*["']?\s*(?!#)[a-z]+:/i, 'an external url()'],
  [/<!ENTITY/i, 'an XML entity declaration'],
];

/**
 * `SOURCES.md` rows → key → { hex, name }. Tolerant of column order: the key is
 * the first cell (backticks and a `.svg` suffix stripped), the brand colour is
 * the first `#RRGGBB` in the row (or a cell that is exactly six hex digits), and
 * the display name is the second cell when it isn't the colour.
 */
function parseSources(file) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim().replace(/`/g, ''));
    if (cells.length < 2 || /^:?-+:?$/.test(cells[0])) continue;
    const key = cells[0].replace(/\.svg$/i, '').toLowerCase();
    if (!KEY_RE.test(key)) continue;
    let hex = null;
    const hashed = /#([0-9a-fA-F]{6})\b/.exec(line);
    if (hashed) hex = `#${hashed[1].toLowerCase()}`;
    else {
      const bare = cells.find((c) => /^[0-9a-fA-F]{6}$/.test(c));
      if (bare) hex = `#${bare.toLowerCase()}`;
    }
    const second = cells[1];
    const name = second && !/^#?[0-9a-fA-F]{6}$/.test(second) && !/^https?:/i.test(second) ? second : null;
    out.set(key, { hex, name });
  }
  return out;
}

function main() {
  const sources = parseSources(join(SRC, 'SOURCES.md'));
  const files = existsSync(SRC)
    ? readdirSync(SRC).filter((f) => f.endsWith('.svg')).sort()
    : [];

  rmSync(PUBLIC_DIR, { recursive: true, force: true });
  mkdirSync(PUBLIC_DIR, { recursive: true });

  const entries = [];
  const problems = [];
  for (const file of files) {
    const key = file.slice(0, -'.svg'.length);
    if (!KEY_RE.test(key)) { problems.push(`${file}: key must match ${KEY_RE}`); continue; }
    const svg = readFileSync(join(SRC, file));
    const text = svg.toString('utf8');
    const bad = UNSAFE.find(([re]) => re.test(text));
    if (bad) { problems.push(`${file}: contains ${bad[1]}`); continue; }
    if (!/<svg\b/i.test(text)) { problems.push(`${file}: not an SVG document`); continue; }
    const hash = createHash('sha256').update(svg).digest('hex').slice(0, 10);
    const name = `${key}.${hash}.svg`;
    writeFileSync(join(PUBLIC_DIR, name), svg);
    const meta = sources.get(key) ?? { hex: null, name: null };
    entries.push({ key, url: `/plugin-icons/${name}`, hex: meta.hex, name: meta.name });
  }

  if (problems.length) {
    console.error(`generate-plugin-icons: refusing ${problems.length} icon(s):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  const body = entries
    .map((e) => `  ${JSON.stringify(e.key)}: { url: ${JSON.stringify(e.url)}, hex: ${JSON.stringify(e.hex)}, name: ${JSON.stringify(e.name)} },`)
    .join('\n');
  const out = `// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED by scripts/generate-plugin-icons.mjs from deploy/plugins/_icons/.
// Do not edit by hand — run \`node scripts/generate-plugin-icons.mjs\`.

/** One curated vendor/tool icon: its content-hashed URL, brand colour and vendor name. */
export interface PluginIconAsset {
  url: string;
  /** Brand colour from SOURCES.md (\`#rrggbb\`), or null when none is recorded. */
  hex: string | null;
  /** Vendor/tool display name from SOURCES.md, or null. */
  name: string | null;
}

export const PLUGIN_ICONS: Readonly<Record<string, PluginIconAsset>> = {
${body}${body ? '\n' : ''}};
`;
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, out);
  console.log(`generate-plugin-icons: ${entries.length} icon(s) → ${PUBLIC_DIR}`);
}

main();
