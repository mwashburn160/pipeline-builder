import { useState, useRef } from 'react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { FormField } from '@/components/ui/FormField';
import { Upload } from 'lucide-react';
import api from '@/lib/api';

interface UploadPluginModalProps {
  canUploadPublic: boolean;
  onClose: () => void;
  onUploaded: () => void;
}

export default function UploadPluginModal({ canUploadPublic, onClose, onUploaded }: UploadPluginModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [access, setAccess] = useState<'public' | 'private'>('private');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      const validTypes = ['application/zip', 'application/x-zip-compressed', 'application/gzip', 'application/x-gzip'];
      const validExtensions = ['.zip', '.tar.gz', '.tgz'];
      const hasValidExtension = validExtensions.some(ext => selected.name.toLowerCase().endsWith(ext));

      if (!validTypes.includes(selected.type) && !hasValidExtension) {
        setError('Please select a .zip or .tar.gz file');
        return;
      }

      setFile(selected);
      setError(null);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      setError('Please select a file to upload');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await api.uploadPlugin(
        file,
        access,
        description || undefined,
        keywords || undefined,
      );

      if (response.success) {
        setSuccess('Plugin uploaded successfully!');
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        onUploaded();
        setTimeout(() => onClose(), 2000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload plugin');
    } finally {
      setLoading(false);
    }
  };

  const footer = (
    <div className="flex justify-end space-x-3">
      <button onClick={onClose} disabled={loading} className="btn btn-secondary">
        Cancel
      </button>
      <button onClick={handleUpload} disabled={loading || !file} className="btn btn-primary">
        {loading ? (
          <><LoadingSpinner size="sm" className="mr-2" />Uploading...</>
        ) : (
          <><Upload className="w-4 h-4 mr-2" />Upload</>
        )}
      </button>
    </div>
  );

  return (
    <Modal title="Upload Plugin" onClose={onClose} maxWidth="max-w-md" footer={footer}>
      {error && (
        <div className="alert-error">
          <p>{error}</p>
        </div>
      )}
      {success && (
        <div className="alert-success">
          <p>{success}</p>
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="label">Plugin File (.zip or .tar.gz)</label>
          <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 dark:border-gray-600 border-dashed rounded-xl hover:border-gray-400 dark:hover:border-gray-500 transition-colors bg-gray-50/50 dark:bg-gray-800/50">
            <div className="space-y-1 text-center">
              <Upload className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" />
              <div className="flex text-sm text-gray-600 dark:text-gray-400">
                <label htmlFor="file-upload" className="relative cursor-pointer rounded-md font-medium text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-blue-500">
                  <span>Select a file</span>
                  <input id="file-upload" name="file-upload" type="file" className="sr-only" ref={fileInputRef} accept=".zip,.tar.gz,.tgz" onChange={handleFileSelect} disabled={loading} />
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

        <FormField label="Description" className="mb-3">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Brief description of this plugin (overrides manifest)" className="input" disabled={loading} />
        </FormField>

        <FormField label="Keywords (comma-separated)" className="mb-3">
          <input type="text" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="keyword1, keyword2, keyword3 (overrides manifest)" className="input" disabled={loading} />
        </FormField>

        <FormField label="Access Level" hint={!canUploadPublic ? 'Only admins can upload public plugins' : undefined}>
          <select value={access} onChange={(e) => setAccess(e.target.value as 'public' | 'private')} className="input" disabled={loading || !canUploadPublic}>
            <option value="private">Private (Organization only)</option>
            {canUploadPublic && <option value="public">Public (Available to all)</option>}
          </select>
        </FormField>
      </div>
    </Modal>
  );
}
