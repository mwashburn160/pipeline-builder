// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
}

/**
 * Thin wrapper over the `.card` CSS layer (glassy surface + border + padding).
 * Just `<div className="card …">` — use it so callers stop hand-typing the
 * class string. Extra `className` is appended, and any div props pass through.
 */
export function Card({ className = '', children, ...props }: CardProps) {
  return (
    <div className={['card', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </div>
  );
}
