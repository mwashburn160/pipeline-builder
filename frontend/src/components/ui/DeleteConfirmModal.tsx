import { LoadingSpinner } from './Loading';

interface DeleteConfirmModalProps {
  title: string;
  itemName: string;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmModal({ title, itemName, loading, onConfirm, onCancel }: DeleteConfirmModalProps) {
  return (
    <div className="modal-backdrop" onClick={() => !loading && onCancel()}>
      <div className="modal-panel max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">{title}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
          Are you sure you want to delete <strong className="text-gray-700 dark:text-gray-200">{itemName}</strong>?
        </p>
        <p className="text-sm text-red-600 dark:text-red-400 mb-4">This action cannot be undone.</p>
        <div className="flex justify-end space-x-3">
          <button onClick={onCancel} disabled={loading} className="btn btn-secondary">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={loading} className="btn btn-danger">
            {loading ? (
              <><LoadingSpinner size="sm" className="mr-2" />Deleting...</>
            ) : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
