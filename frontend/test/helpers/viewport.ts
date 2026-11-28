// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * jsdom has no `matchMedia`, so every media query reads as "no match" — the
 * desktop layout. `mockViewport(390)` installs one that answers `max-width` /
 * `min-width` queries for that width, the way a phone would; `resetViewport()`
 * removes it again.
 */
export function mockViewport(width: number): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const max = /max-width:\s*([\d.]+)px/.exec(query);
      const min = /min-width:\s*([\d.]+)px/.exec(query);
      const matches = (!max || width <= Number(max[1])) && (!min || width >= Number(min[1])) && !!(max || min);
      return {
        matches, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      };
    },
  });
}

/** Back to jsdom's default: no `matchMedia` at all. */
export function resetViewport(): void {
  delete (window as { matchMedia?: unknown }).matchMedia;
}
