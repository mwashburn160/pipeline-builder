import { useRef } from 'react';
import { Modal } from './Modal';
import { ModalFooter } from './ModalFooter';

/** Props for the DeleteConfirmModal component. */
interface DeleteConfirmModalProps {
  /** Dialog heading (e.g. "Delete pipeline") */
  title: string;
  /** Name of the item being deleted, shown in bold in the confirmation message */
  itemName: string;
  /** When true, buttons are disabled and a spinner is shown on the Delete button */
  loading: boolean;
  /** Callback fired when the user confirms deletion */
  onConfirm: () => void;
  /** Callback fired when the user cancels (via Cancel button, Escape, or backdrop click) */
  onCancel: () => void;
  /** Extra classes appended to the modal panel. */
  className?: string;
}

/**
 * Destructive-action confirmation dialog with a warning message and Cancel/Delete
 * buttons. Built on {@link Modal} for the shared focus-trap / Escape / portal /
 * scroll-lock behavior; the Cancel button receives initial focus so a stray
 * Enter can't confirm the deletion.
 *
 * For a delete the server STEP-UP gates, use `StepUpModal` alone instead: it
 * takes the heading and what is lost as `title` + `details` and collects the
 * factor in the same dialog. Chaining this in front of it double-prompts for one
 * decision, and `test/one-dialog-rule.test.ts` fails the build when it happens.
 */
export function DeleteConfirmModal({ title, itemName, loading, onConfirm, onCancel, className = '' }: DeleteConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // While a delete is in flight the modal must not be dismissible — swallow the
  // Escape/backdrop/close paths until it resolves.
  const handleClose = () => { if (!loading) onCancel(); };

  return (
    <Modal
      title={title}
      onClose={handleClose}
      initialFocusRef={cancelRef}
      maxWidth={`max-w-md ${className}`.trim()}
      footer={(
        <ModalFooter
          cancelRef={cancelRef}
          confirmLabel={loading ? 'Deleting...' : 'Delete'}
          confirmVariant="danger"
          loading={loading}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    >
      <p className="text-sm text-fg-muted mb-1">
        Are you sure you want to delete <strong className="text-fg">{itemName}</strong>?
      </p>
      <p className="text-sm text-danger">This action cannot be undone.</p>
    </Modal>
  );
}
