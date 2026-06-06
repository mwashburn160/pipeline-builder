import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders `children` into `document.body` via a portal.
 *
 * Modal overlays use `position: fixed` to cover the viewport, but a `transform`,
 * `filter`, or `backdrop-filter` on any ancestor creates a containing block that
 * clamps "fixed" to that ancestor's box. The dashboard shell wraps content in
 * framer-motion (`transform`) and a `backdrop-blur` header, so a backdrop
 * rendered inline would only cover the content column — showing up as dark side
 * bands instead of a full-screen overlay. Portaling to `<body>` escapes those
 * ancestors. `mounted` guards SSR (no `document` on the server).
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? createPortal(children, document.body) : null;
}
