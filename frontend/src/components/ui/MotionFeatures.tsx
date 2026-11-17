// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { LazyMotion } from 'framer-motion';

/** Fetched after hydration (see src/lib/motion-features.ts); module-level so the loader is stable. */
const loadMotionFeatures = () => import('@/lib/motion-features').then((mod) => mod.default);

/**
 * Animation support for the subtree: every animated element in the app is an
 * `m.*` component, which carries no animation code of its own and animates only
 * under a `LazyMotion`. The features (`domAnimation`) load asynchronously, off
 * the critical path.
 *
 * Mounted by the two shells that animate — `DashboardLayout` and the landing
 * page — and deliberately NOT in `_app`: `LazyMotion`'s feature loader pulls in
 * ~11 KB gzip of motion-dom, which every public/auth route would otherwise pay
 * for nothing (they use CSS reveals instead).
 *
 * `strict`: a full `motion.*` component rendered inside throws in development,
 * so a stray import cannot silently drag the whole engine back into a route.
 */
export function MotionFeatures({ children }: { children: ReactNode }) {
  return <LazyMotion features={loadMotionFeatures} strict>{children}</LazyMotion>;
}
