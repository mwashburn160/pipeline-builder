// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';

type CardOwnProps<E extends ElementType> = {
  /**
   * The element (or component) to render as. Defaults to `div`.
   *
   * Roughly half the surfaces that want a card are NOT divs — a grid item is an
   * `li`, a landmark is a `section`, a listing is an `article`, a settings panel
   * is a `form`, an animated one is a `motion.div`. Without this they hand-typed
   * `className="card …"` and the `.card` layer had 23 call sites outside the
   * component that exists to own it.
   */
  as?: E;
  children: ReactNode;
  className?: string;
};

type CardProps<E extends ElementType> =
  CardOwnProps<E> & Omit<ComponentPropsWithoutRef<E>, keyof CardOwnProps<E>>;

/**
 * Thin wrapper over the `.card` CSS layer (opaque surface + hairline border +
 * padding).
 *
 * Just `<div className="card …">` — use it so callers stop hand-typing the
 * class string. Extra `className` is appended, and any props of the rendered
 * element pass through.
 */
export function Card<E extends ElementType = 'div'>({ as, className = '', children, ...props }: CardProps<E>) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag className={['card', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </Tag>
  );
}
