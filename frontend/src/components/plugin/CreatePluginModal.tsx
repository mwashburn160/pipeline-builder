import { useState, useRef, useEffect, useId } from 'react';
import { useAsyncCallback } from '@/hooks/useAsync';
import { Upload, CheckCircle, XCircle } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { FormField } from '@/components/ui/FormField';
import AIPluginBuilderTab from './AIPluginBuilderTab';
import api from '@/lib/api';
import { PLUGIN_BUILD_TIMEOUT_MS } from '@/lib/constants';
import { useBuildStatus } from '@/hooks/useBuildStatus';

/** Props for the CreatePluginModal component. */
interface CreatePluginModalProps {
  /** Whether the current user can upload public plugins (admin only). */
  canUploadPublic: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback when a plugin is successfully created (upload or AI deploy). */
  onCreated: () => void;
  /** Which tab to open on mount. Defaults to 'ai'. */
  initialTab?: 'upload' | 'ai';
}

/** Tabbed modal for creating plugins via file upload or AI generation. */
export default function CreatePluginModal({ canUploadPublic, onClose, onCreated, initialTab = 'ai' }: CreatePluginModalProps) {
  const [activeTab, setActiveTab] = useState<'upload' | 'ai'>(initialTab);

  // Upload tab state
  const [file, setFile] = useState<File | null>(null);
  const [access, setAccess] = useState<'public' | 'private'>('private');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  // SSE build progress — driven by the requestId returned from the 202
  // upload response. Stays idle when requestId is null.
  const { status: buildStatus, events, lastEvent } = useBuildStatus(requestId);
  const isBuilding = requestId !== null && buildStatus === 'building';
  const isComplete = buildStatus === 'completed';
  const isFailed = buildStatus === 'failed';

  // Close modal shortly after a successful build so the user sees the
  // completion state before it disappears.
  useEffect(() => {
    if (buildStatus === 'completed') {
      const timer = setTimeout(() => {
        onCreated();
        onClose();
      }, 2000);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when buildStatus changes; callbacks are stable.
  }, [buildStatus]);

  const { execute: uploadAsync, loading, error: uploadError, clearError } = useAsyncCallback(
    async (f: File, a: 'public' | 'private') => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PLUGIN_BUILD_TIMEOUT_MS);
      try {
        return await api.uploadPlugin(f, a, { signal: controller.signal });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new Error('Upload timed out. Please try again with a smaller file or check your connection.');
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  );
  const error = validationError || uploadError;

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
    setSuccess(null);
    setRequestId(null);

    const response = await uploadAsync(file, access);

    if (response) {
      if (response.statusCode === 202 && response.data?.requestId) {
        // Build queued — start listening for SSE events. Clear the
        // file input so the user can't double-submit while building.
        setRequestId(response.data.requestId);
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else if (response.success) {
        // Fallback: synchronous response (shouldn't happen with queue, but
        // some deployments may bypass it).
        setSuccess('Plugin uploaded successfully!');
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        onCreated();
        setTimeout(() => onClose(), 2000);
      }
    }
  };

  const handleRetry = () => {
    setRequestId(null);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /** Shared reset run when switching tabs — keeps the inactive tab clean. */
  const resetUploadState = () => {
    setValidationError(null);
    clearError();
    setSuccess(null);
    setFile(null);
    setRequestId(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Disable tab-switching mid-build so the user can't tear down the SSE
  // subscription while events are still streaming in.
  const tabDisabled = isBuilding;

  const tabs = (
    <div className="border-b border-gray-200 dark:border-gray-700 px-6">
      <nav className="-mb-px flex space-x-8">
        <button
          onClick={() => {
            if (tabDisabled) return;
            setActiveTab('ai');
            resetUploadState();
          }}
          disabled={tabDisabled}
          className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
            activeTab === 'ai'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
          } ${tabDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          AI Builder
        </button>
        <button
          onClick={() => {
            if (tabDisabled) return;
            setActiveTab('upload');
            resetUploadState();
          }}
          disabled={tabDisabled}
          className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
            activeTab === 'upload'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
          } ${tabDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          Upload
        </button>
      </nav>
    </div>
  );

  const uploadDisabled = loading || isBuilding;
  const uploadFooter = (
    <div className="flex justify-end space-x-3">
      <button onClick={onClose} disabled={isBuilding} className="btn btn-secondary">
        {isComplete ? 'Close' : 'Cancel'}
      </button>
      {isFailed && (
        <button onClick={handleRetry} className="btn btn-primary">
          <Upload className="w-4 h-4 mr-2" />Retry
        </button>
      )}
      {!requestId && (
        <button onClick={handleUpload} disabled={uploadDisabled || !file} className="btn btn-primary">
          {loading ? (
            <><LoadingSpinner size="sm" className="mr-2" />Uploading...</>
          ) : (
            <><Upload className="w-4 h-4 mr-2" />Upload</>
          )}
        </button>
      )}
    </div>
  );

  const aiFooter = (
    <div className="flex justify-end">
      <button onClick={onClose} className="btn btn-secondary">
        Cancel
      </button>
    </div>
  );

  return (
    <Modal
      title="Create Plugin"
      onClose={onClose}
      maxWidth="max-w-2xl"
      subHeader={tabs}
      footer={activeTab === 'upload' ? uploadFooter : aiFooter}
    >
      {activeTab === 'upload' ? (
        <>
          {error && (
            <div className="alert-error mb-4">
              <p>{error}</p>
            </div>
          )}
          {success && (
            <div className="alert-success mb-4">
              <p>{success}</p>
            </div>
          )}
          {isComplete && (
            <div className="alert-success mb-4">
              <p className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4" />
                Plugin deployed successfully!
              </p>
            </div>
          )}
          {isFailed && lastEvent && (
            <div className="alert-error mb-4">
              <p className="flex items-center gap-2">
                <XCircle className="w-4 h-4" />
                {lastEvent.message}
              </p>
            </div>
          )}

          {/* Build progress log — shown once the upload has been queued
              (requestId set) and SSE events start arriving. */}
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

          {/* Upload form (hidden once a build is in flight — the progress
              log above is the active surface in that state). */}
          {!requestId && (
            <div className="space-y-4">
              <div>
                <label className="label">Plugin File (.zip or .tar.gz)</label>
                <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 dark:border-gray-600 border-dashed rounded-xl hover:border-gray-400 dark:hover:border-gray-500 transition-colors bg-gray-50/50 dark:bg-gray-800/50">
                  <div className="space-y-1 text-center">
                    <Upload className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" />
                    <div className="flex text-sm text-gray-600 dark:text-gray-400">
                      <label htmlFor={fileInputId} className="relative cursor-pointer rounded-md font-medium text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-blue-500">
                        <span>Select a file</span>
                        <input id={fileInputId} name="file-upload" type="file" className="sr-only" ref={fileInputRef} accept=".zip,.tar.gz,.tgz" onChange={handleFileSelect} disabled={uploadDisabled} />
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
                <select value={access} onChange={(e) => setAccess(e.target.value as 'public' | 'private')} className="input" disabled={uploadDisabled || !canUploadPublic}>
                  <option value="private">Private (Organization only)</option>
                  {canUploadPublic && <option value="public">Public (Available to all)</option>}
                </select>
              </FormField>
            </div>
          )}
        </>
      ) : (
        <AIPluginBuilderTab
          canUploadPublic={canUploadPublic}
          disabled={false}
          onCreated={onCreated}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}
