// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRef, type ReactNode } from 'react';
import { LoadingSpinner } from './Loading';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  /** Dialog heading — state the action ("Discard changes?", "Reduce seats?"). */
  title: string;
  /** Body: what is about to happen and what it costs. */
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for anything destructive or irreversible. */
  tone?: 'primary' | 'danger';
  /** Disables both buttons and spins the confirm while the action is in flight. */
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Generic yes/no confirmation, the non-delete sibling of {@link DeleteConfirmModal}.
 *
 * Exists to retire `window.confirm`, which the app used for discarding an edit
 * and for CONFIRMING A BILLING CHARGE: a native dialog is unstyled, ignores dark
 * mode, can't show formatted prices, and on some browsers is suppressible — a bad
 * place for "that's $240/yr". Cancel takes initial focus, so a stray Enter never
 * confirms.
 *
 * NOT for an action the server STEP-UP gates. Those are one dialog:
 * `StepUpModal` takes the heading and the "what is lost" copy as `title` +
 * `details` and collects the factor in the same place. Putting this in front of
 * it asks the same person the same question twice and teaches them to click
 * through both without reading either — `test/one-dialog-rule.test.ts` fails the
 * build when the two are chained for one action.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      title={title}
      onClose={() => { if (!loading) onCancel(); }}
      initialFocusRef={cancelRef}
      maxWidth="max-w-md"
      footer={(
        // Buttons rendered directly (not ModalFooter) so Cancel can hold the ref
        // that takes initial focus — `Button` doesn't forward refs. Mirrors
        // DeleteConfirmModal.
        <div className="flex justify-end space-x-3">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={loading} className="btn btn-secondary">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
          >
            {loading ? <><LoadingSpinner size="sm" className="mr-2" label={null} />Working…</> : confirmLabel}
          </button>
        </div>
      )}
    >
      <div className="text-sm text-gray-600 dark:text-gray-300 space-y-2">{children}</div>
    </Modal>
  );
}
