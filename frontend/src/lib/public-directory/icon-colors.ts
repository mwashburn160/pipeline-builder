// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Colour decisions for plugin icons (§6a.1), all pure and deterministic so the
 * server-rendered HTML and the hydrated page agree.
 */

/** Card backgrounds per theme — `--pb-surface` in globals.css. */
export const SURFACE_LIGHT = '#ffffff';
export const SURFACE_DARK = '#111827';

/** Minimum contrast (WCAG non-text) for a brand-coloured mark against its card. */
export const MIN_ICON_CONTRAST = 3;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** `#rrggbb` → relative luminance, or null when it isn't a 6-digit hex colour. */
export function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two hex colours (null if either is unparseable). */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The fill for a brand-coloured mask icon in each theme: the brand colour where
 * it clears 3:1 against the card, else the theme's text colour. So a teal mark
 * stays teal in both themes, and a near-black one (GitHub, Rust) inverts in dark.
 */
export function iconFills(hex: string | null | undefined): { light: string; dark: string } {
  const text = 'var(--pb-text)';
  if (!hex || luminance(hex) === null) return { light: text, dark: text };
  const color = hex.startsWith('#') ? hex.toLowerCase() : `#${hex.toLowerCase()}`;
  return {
    light: (contrastRatio(color, SURFACE_LIGHT) ?? 0) >= MIN_ICON_CONTRAST ? color : text,
    dark: (contrastRatio(color, SURFACE_DARK) ?? 0) >= MIN_ICON_CONTRAST ? color : text,
  };
}

/**
 * Monogram tile colours. Each clears 4.5:1 against white text, so the letters
 * stay legible in both themes without a per-theme variant.
 */
export const MONOGRAM_PALETTE = [
  '#1d4ed8', '#0f766e', '#7c3aed', '#b91c1c', '#c2410c',
  '#15803d', '#a21caf', '#0e7490', '#4338ca', '#be123c',
] as const;

/** FNV-1a 32-bit — tiny, stable across runtimes, no dependency. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 1–2 uppercase letters from a plugin name: `snyk-python` → `SP`, `trivy` → `TR`. */
export function monogramLetters(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** The monogram tile colour for a name (deterministic). */
export function monogramColor(name: string): string {
  return MONOGRAM_PALETTE[hashString(name) % MONOGRAM_PALETTE.length];
}
