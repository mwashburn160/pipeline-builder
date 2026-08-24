// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId, type ReactNode } from 'react';
import { Switch } from './Switch';

interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** The control (input/select/switch/button) — right-aligned on `md+`. */
  control?: ReactNode;
  children?: ReactNode;
  /** Vertical padding between stacked rows. Rows are separated by the parent's divide. */
  className?: string;
}

/**
 * A settings list-row: label + description on the left, control on the right
 * (stacked on mobile, two-column on `md+`). The modern settings pattern —
 * replaces the ad-hoc label/control layouts across settings + notifications.
 */
export function SettingRow({ label, description, control, children, className = '' }: SettingRowProps) {
  return (
    <div className={['flex flex-col gap-2 py-4 md:flex-row md:items-center md:justify-between', className].filter(Boolean).join(' ')}>
      <div className="min-w-0 md:pr-6">
        <div className="text-sm font-medium text-[var(--pb-text)]">{label}</div>
        {description && <p className="mt-0.5 text-sm text-[var(--pb-text-muted)]">{description}</p>}
      </div>
      {(control ?? children) && <div className="shrink-0">{control ?? children}</div>}
    </div>
  );
}

interface ToggleRowProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** A {@link SettingRow} whose control is a {@link Switch}. The whole label is the
 *  switch's accessible name (wired via `aria-labelledby`). */
export function ToggleRow({ label, description, checked, onChange, disabled, className }: ToggleRowProps) {
  const labelId = useId();
  return (
    <SettingRow
      className={className}
      label={<span id={labelId}>{label}</span>}
      description={description}
      control={<Switch checked={checked} onChange={onChange} disabled={disabled} aria-labelledby={labelId} />}
    />
  );
}
