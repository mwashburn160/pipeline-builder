import { useState, useRef, useEffect } from 'react';
import { useAsyncCallback } from '@/hooks/useAsync';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { FormField } from '@/components/ui/FormField';
import { Upload, CheckCircle, XCircle } from 'lucide-react';
import api from '@/lib/api';
import { useBuildStatus } from '@/hooks/useBuildStatus';

/** Props for the UploadPluginModal component. */
interface UploadPluginModalProps {
  /** Whether the current user can upload public plugins (admin only). */
  canUploadPublic: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback when the plugin upload and build complete successfully. */
  onUploaded: () => void;
}

/** Modal for uploading plugin ZIP/TAR archives with real-time build progress via SSE. */
export default function UploadPluginModal({ canUploadPublic, onClose, onUploaded }: UploadPluginModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [access, setAccess] = useState<'public' | 'private'>('private');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const { execute: uploadAsync, loading, error: uploadError } = useAsyncCallback(
    (f: File, a: 'public' | 'private') => api.uploadPlugin(f, a),
  );
  const error = validationError || uploadError;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { status: buildStatus, events, lastEvent } = useBuildStatus(requestId);

  // Close modal on successful build
  useEffect(() => {
    if (buildStatus === 'completed') {
      const timer = setTimeout(() => {
        onUploaded();
        onClose();
      }, 2000);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildStatus]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      const validTypes = ['application/zip', 'application/x-zip-compressed', 'application/gzip', 'application/x-gzip'];
      const validExtensions = ['.zip', '.tar.gz', '.tgz'];
      const hasValidExtension = validExtensions.some(ext => selected.name.toLowerCase().endsWith(ext));

      if (!validTypes.includes(selected.type) && !hasValidExtension) {
        setValidationError('Please select a .zip or .tar.gz file');
        return;
      }

      setFile(selected);
      setValidationError(null);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      setValidationError('Please select a file to upload');
      return;
    }

    setValidationError(null);
    setRequestId(null);

    const response = await uploadAsync(file, access);

    if (response) {
      if (response.statusCode === 202 && response.data?.requestId) {
        // Build queued — start listening for SSE events
        setRequestId(response.data.requestId);
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else if (response.success) {
        // Fallback: synchronous response (shouldn't happen with queue)
        onUploaded();
        setTimeout(() => onClose(), 2000);
      }
    }
  };

  const isBuilding = requestId !== null && buildStatus === 'building';
  const isComplete = buildStatus === 'completed';
  const isFailed = buildStatus === 'failed';
  const isDisabled = loading || isBuilding;

  const footer = (
    <div className="flex justify-end space-x-3">
      <button onClick={onClose} disabled={isBuilding} className="btn btn-secondary">
        {isComplete ? 'Close' : 'Cancel'}
      </button>
      {!requestId && (
        <button onClick={handleUpload} disabled={isDisabled || !file} className="btn btn-primary">
          {loading ? (
            <><LoadingSpinner size="sm" className="mr-2" />Uploading...</>
          ) : (
            <><Upload className="w-4 h-4 mr-2" />Upload</>
          )}
        </button>
      )}
    </div>
  );

  return (
    <Modal title="Upload Plugin" onClose={onClose} maxWidth="max-w-md" footer={footer}>
      {error && (
        <div className="alert-error">
          <p>{error}</p>
        </div>
      )}
      {isComplete && (
        <div className="alert-success">
          <p className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            Plugin deployed successfully!
          </p>
        </div>
      )}
      {isFailed && lastEvent && (
        <div className="alert-error">
          <p className="flex items-center gap-2">
            <XCircle className="w-4 h-4" />
            {lastEvent.message}
          </p>
        </div>
      )}

      {/* Build progress log */}
      {requestId && events.length > 0 && (
        <div className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 max-h-48 overflow-y-auto">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Build Log</p>
          {events.map((event, i) => (
            <div key={i} className={`text-xs font-mono py-0.5 ${
              event.type === 'ERROR' ? 'text-red-600 dark:text-red-400' :
              event.type === 'COMPLETED' ? 'text-green-600 dark:text-green-400' :
              'text-gray-600 dark:text-gray-400'
            }`}>
              {event.message}
            </div>
          ))}
          {isBuilding && (
            <div className="flex items-center gap-2 mt-1 text-xs text-blue-600 dark:text-blue-400">
              <LoadingSpinner size="sm" /> Building...
            </div>
          )}
        </div>
      )}

      {/* Upload form (hidden once build is queued) */}
      {!requestId && (
        <div className="space-y-4">
          <div>
            <label className="label">Plugin File (.zip or .tar.gz)</label>
            <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 dark:border-gray-600 border-dashed rounded-xl hover:border-gray-400 dark:hover:border-gray-500 transition-colors bg-gray-50/50 dark:bg-gray-800/50">
              <div className="space-y-1 text-center">
                <Upload className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" />
                <div className="flex text-sm text-gray-600 dark:text-gray-400">
                  <label htmlFor="file-upload" className="relative cursor-pointer rounded-md font-medium text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-blue-500">
                    <span>Select a file</span>
                    <input id="file-upload" name="file-upload" type="file" className="sr-only" ref={fileInputRef} accept=".zip,.tar.gz,.tgz" onChange={handleFileSelect} disabled={isDisabled} />
                  </label>
                  <p className="pl-1">or drag and drop</p>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">ZIP or TAR.GZ up to 100MB</p>
              </div>
            </div>
            {file && (
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                Selected: <span className="font-medium text-gray-900 dark:text-gray-200">{file.name}</span>
                <span className="text-gray-400 dark:text-gray-500 ml-2">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
              </p>
            )}
          </div>

          <FormField label="Access Level" hint={!canUploadPublic ? 'Only admins can upload public plugins' : undefined}>
            <select value={access} onChange={(e) => setAccess(e.target.value as 'public' | 'private')} className="input" disabled={isDisabled || !canUploadPublic}>
              <option value="private">Private (Organization only)</option>
              {canUploadPublic && <option value="public">Public (Available to all)</option>}
            </select>
          </FormField>
        </div>
      )}
    </Modal>
  );
}
