// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Does this user ask for reduced motion?
 *
 * The CSS `prefers-reduced-motion` block in globals.css covers declarative
 * animations and the `<MotionConfig reducedMotion="user">` wrapper covers
 * framer-motion — but neither reaches a scripted `scrollIntoView({ behavior:
 * 'smooth' })`, which is exactly the kind of long, unrequested movement the
 * setting exists to stop. SSR-safe: returns false when there's no `window`.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** `scrollIntoView` options that fall back to an instant jump under reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
