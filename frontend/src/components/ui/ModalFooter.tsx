// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode, Ref } from 'react';
import { Button, type ButtonVariant } from './Button';
import { TAP_TARGET } from './responsive';

interface ModalFooterProps {
  /** Secondary action (usually closes the modal). */
  onCancel: () => void;
  /** Primary action. Omit when `confirmType="submit"` and a wrapping `<form>`'s
   *  `onSubmit` drives the action instead. */
  onConfirm?: () => void;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** Spinner + disables both buttons while the action is in flight. */
  loading?: boolean;
  /** Disable confirm independent of `loading` (e.g. invalid form). */
  confirmDisabled?: boolean;
  confirmVariant?: Extract<ButtonVariant, 'primary' | 'danger' | 'success'>;
  /** Use `submit` when the confirm button submits a wrapping `<form>`. */
  confirmType?: 'button' | 'submit';
  /** Optional left-aligned content (a tertiary action or a note). */
  children?: ReactNode;
  /** Handle on the Cancel button, for a dialog that gives it initial focus so a
   *  stray Enter can't confirm. */
  cancelRef?: Ref<HTMLButtonElement>;
}

/**
 * The `Cancel + primary` modal footer repeated ~40× across the dashboard.
 * Drops into `<Modal footer={…}>` (Modal already provides the sticky footer
 * region) and standardises the loading label + disabled wiring.
 */
export function ModalFooter({
  onCancel, onConfirm, confirmLabel = 'Save', cancelLabel = 'Cancel',
  loading = false, confirmDisabled = false, confirmVariant = 'primary',
  confirmType = 'button', children, cancelRef,
}: ModalFooterProps) {
  return (
    // On a phone the two actions split the full-width footer as 44px targets,
    // with any left-hand note on a row of its own above them.
    <div className="flex flex-wrap items-center justify-end gap-2">
      {children && <div className="mr-auto max-sm:w-full">{children}</div>}
      <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={loading} className={`max-sm:flex-1 ${TAP_TARGET}`}>{cancelLabel}</Button>
      <Button
        className={`max-sm:flex-1 ${TAP_TARGET}`}
        variant={confirmVariant}
        type={confirmType}
        onClick={onConfirm}
        loading={loading}
        disabled={confirmDisabled}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}
