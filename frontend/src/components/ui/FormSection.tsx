// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { FormEvent, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { SectionCard } from './SectionCard';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { SuccessAlert } from './SuccessAlert';

interface FormSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  /** Header actions (right side). */
  actions?: ReactNode;
  /** Error / success banners rendered above the fields. */
  error?: string | null;
  success?: string | null;
  onSubmit: (e: FormEvent) => void;
  /** Submit button label. Omit to render no submit row (caller supplies its own). */
  submitLabel?: string;
  submitDisabled?: boolean;
  submitLoading?: boolean;
  /** Extra content on the left of the submit row. */
  footerExtra?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * A {@link SectionCard} wrapping a `<form>`: header + error/success banners +
 * fields + a submit row. Standardizes the "titled section + fields + Save" shape
 * repeated ad hoc across the Settings page (profile / password / org). The submit
 * button lives INSIDE the form so native submit + Enter-to-submit both work.
 */
export function FormSection({
  title, description, icon, actions, error, success, onSubmit,
  submitLabel, submitDisabled, submitLoading, footerExtra, children, className,
}: FormSectionProps) {
  return (
    <SectionCard title={title} description={description} icon={icon} actions={actions} className={className} bodyClassName="p-0">
      <form onSubmit={onSubmit} className="space-y-4 p-5">
        {error && <ErrorAlert message={error} />}
        {success && <SuccessAlert message={success} />}
        {children}
        {submitLabel && (
          <div className="-mx-5 -mb-5 mt-5 flex items-center justify-end gap-2 border-t border-[var(--pb-border)] bg-[var(--pb-surface-muted)] px-5 py-3">
            {footerExtra && <div className="mr-auto">{footerExtra}</div>}
            <Button type="submit" loading={submitLoading} disabled={submitDisabled}>{submitLabel}</Button>
          </div>
        )}
      </form>
    </SectionCard>
  );
}
