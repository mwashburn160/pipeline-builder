// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface SectionCardProps {
  /** Section heading (the shared `.h2` heading style). */
  title?: ReactNode;
  /** Muted one-liner under the title. */
  description?: ReactNode;
  /** Optional leading icon in a soft tile. */
  icon?: LucideIcon;
  /** Right-aligned header actions (buttons, links). */
  actions?: ReactNode;
  /** Optional footer row (e.g. a Save button), separated + muted. */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Body padding override — e.g. `'p-0'` for a flush table/list. Default `'p-5'`. */
  bodyClassName?: string;
  /** Drop the divider under the header (for compact/among-siblings cards). */
  flushHeader?: boolean;
}

/**
 * The dashboard's structured content card: a header row (icon + title +
 * description + actions), a padded body, and an optional footer. Token-driven
 * (`--pb-*`, dark-mode correct) and replaces the ad-hoc `<Card>` + hand-rolled
 * `flex items-center gap-2` + drifting `h2/h3` headers repeated across settings,
 * incident, api-catalog, notifications, tokens, and roles pages.
 *
 * The title uses the shared `.h2` heading style — 16px sans, which is what
 * keeps a card title below the 24px serif page title without competing with the
 * data inside the card.
 */
export function SectionCard({
  title, description, icon: Icon, actions, footer, children,
  className = '', bodyClassName = 'p-5', flushHeader = false,
}: SectionCardProps) {
  const hasHeader = Boolean(title || description || actions || Icon);
  return (
    <section
      className={['rounded-2xl border border-default bg-surface shadow-[var(--pb-shadow)] overflow-hidden', className].filter(Boolean).join(' ')}
    >
      {hasHeader && (
        <header className={['flex items-start gap-3 px-5 py-4', flushHeader ? '' : 'border-b border-default'].filter(Boolean).join(' ')}>
          {Icon && (
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-muted text-brand">
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            {title && (
              <h2 className="h2 leading-tight">
                {title}
              </h2>
            )}
            {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {children != null && <div className={bodyClassName}>{children}</div>}
      {footer && (
        <div className="flex items-center justify-end gap-2 border-t border-default bg-surface-muted px-5 py-3">
          {footer}
        </div>
      )}
    </section>
  );
}
