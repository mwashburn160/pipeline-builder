// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * framer-motion's `domAnimation` feature bundle (animate / exit / hover / tap /
 * focus / in-view — no layout or drag), in its own module so `_app`'s
 * `<LazyMotion>` can load it with a dynamic `import()`. That keeps the animation
 * engine out of every route's first-load JS: the `m.*` components that render
 * in the meantime are plain elements, and they start animating once this chunk
 * arrives (a few ms after hydration).
 */
import { domAnimation } from 'framer-motion';

export default domAnimation;
