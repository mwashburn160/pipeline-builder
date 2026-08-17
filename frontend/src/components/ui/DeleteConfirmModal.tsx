import { useRef } from 'react';
import { LoadingSpinner } from './Loading';
import { Modal } from './Modal';

/** Props for the DeleteConfirmModal component. */
interface DeleteConfirmModalProps {
  /** Dialog heading (e.g. "Delete Pipeline") */
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
        <div className="flex justify-end space-x-3">
          <button ref={cancelRef} onClick={onCancel} disabled={loading} className="btn btn-secondary">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={loading} className="btn btn-danger">
            {loading ? (
              <><LoadingSpinner size="sm" className="mr-2" />Deleting...</>
            ) : 'Delete'}
          </button>
        </div>
      )}
    >
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
        Are you sure you want to delete <strong className="text-gray-700 dark:text-gray-200">{itemName}</strong>?
      </p>
      <p className="text-sm text-red-600 dark:text-red-400">This action cannot be undone.</p>
    </Modal>
  );
}
