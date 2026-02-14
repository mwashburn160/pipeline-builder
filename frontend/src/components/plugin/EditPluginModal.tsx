import { useState, useEffect } from 'react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { FormField } from '@/components/ui/FormField';
import api from '@/lib/api';
import { Plugin } from '@/types';

interface EditPluginModalProps {
  plugin: Plugin;
  isSysAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditPluginModal({ plugin, isSysAdmin, onClose, onSaved }: EditPluginModalProps) {
  const [fullPlugin, setFullPlugin] = useState<Plugin | null>(null);
  const [fetching, setFetching] = useState(true);
  const [name, setName] = useState(plugin.name);
  const [description, setDescription] = useState(plugin.description || '');
  const [keywords, setKeywords] = useState(plugin.keywords?.join(', ') || '');
  const [version, setVersion] = useState(plugin.version);
  const [metadata, setMetadata] = useState(JSON.stringify(plugin.metadata || {}, null, 2));
  const [pluginType, setPluginType] = useState(plugin.pluginType);
  const [computeType, setComputeType] = useState(plugin.computeType);
  const [env, setEnv] = useState(JSON.stringify(plugin.env || {}, null, 2));
  const [installCommands, setInstallCommands] = useState(plugin.installCommands?.join('\n') || '');
  const [commands, setCommands] = useState(plugin.commands?.join('\n') || '');
  const [isActive, setIsActive] = useState(plugin.isActive);
  const [isDefault, setIsDefault] = useState(plugin.isDefault);
  const [primaryOutputDirectory, setPrimaryOutputDirectory] = useState(plugin.primaryOutputDirectory || '');
  const [accessModifier, setAccessModifier] = useState<'public' | 'private'>(plugin.accessModifier);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Fetch full plugin data by ID to ensure description/keywords are populated
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api.getPluginById(plugin.id);
        if (!cancelled) {
          const fetched = (response as unknown as Record<string, unknown>).plugin as Plugin | undefined;
          if (fetched) {
            setFullPlugin(fetched);
            setName(fetched.name);
            setDescription(fetched.description || '');
            setKeywords(fetched.keywords?.join(', ') || '');
            setVersion(fetched.version);
            setMetadata(JSON.stringify(fetched.metadata || {}, null, 2));
            setPluginType(fetched.pluginType);
            setComputeType(fetched.computeType);
            setEnv(JSON.stringify(fetched.env || {}, null, 2));
            setInstallCommands(fetched.installCommands?.join('\n') || '');
            setCommands(fetched.commands?.join('\n') || '');
            setIsActive(fetched.isActive);
            setIsDefault(fetched.isDefault);
            setPrimaryOutputDirectory(fetched.primaryOutputDirectory || '');
            setAccessModifier(fetched.accessModifier);
          } else {
            setFullPlugin(plugin);
          }
        }
      } catch {
        if (!cancelled) setFullPlugin(plugin);
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [plugin]);

  // Resolved plugin data (fetched by ID, or fallback to list data)
  const p = fullPlugin ?? plugin;

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    let parsedMetadata: Record<string, string | number | boolean> = {};
    let parsedEnv: Record<string, string> = {};

    try {
      parsedMetadata = metadata.trim() ? JSON.parse(metadata) : {};
    } catch {
      setError('Invalid JSON in metadata field');
      setLoading(false);
      return;
    }

    try {
      parsedEnv = env.trim() ? JSON.parse(env) : {};
    } catch {
      setError('Invalid JSON in env field');
      setLoading(false);
      return;
    }

    try {
      const response = await api.updatePlugin(plugin.id, {
        name,
        description,
        keywords: keywords.split(',').map(k => k.trim()).filter(k => k),
        version,
        metadata: parsedMetadata,
        pluginType,
        computeType,
        env: parsedEnv,
        installCommands: installCommands.split('\n').filter(c => c.trim()),
        commands: commands.split('\n').filter(c => c.trim()),
        isActive,
        isDefault,
        accessModifier,
        primaryOutputDirectory: primaryOutputDirectory.trim() || null,
      });

      if (response.success) {
        setSuccess('Plugin updated successfully!');
        onSaved();
        setTimeout(() => onClose(), 1500);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to update plugin');
    } finally {
      setLoading(false);
    }
  };

  const footer = (
    <div className="flex justify-end space-x-3">
      <button onClick={onClose} disabled={loading} className="btn btn-secondary">
        Cancel
      </button>
      <button onClick={handleSave} disabled={loading || fetching} className="btn btn-primary">
        {loading ? (<><LoadingSpinner size="sm" className="mr-2" />Saving...</>) : 'Save Changes'}
      </button>
    </div>
  );

  return (
    <Modal title="Edit Plugin" onClose={onClose} maxWidth="max-w-2xl" tall footer={footer}>
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

      {fetching ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
      ) : (
        <div className="space-y-4">
          {/* Read-only Fields */}
          <div className="border-b border-gray-200 dark:border-gray-700 pb-4">
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">System Information (Read-only)</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">ID</label>
                <p className="text-sm text-gray-700 dark:text-gray-300 font-mono bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{p.id}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Org ID</label>
                <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{p.orgId}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Created By</label>
                <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{p.createdBy}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Created At</label>
                <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{new Date(p.createdAt).toLocaleString()}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Updated By</label>
                <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{p.updatedBy}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Updated At</label>
                <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg">{new Date(p.updatedAt).toLocaleString()}</p>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Image Tag</label>
                <p className="text-sm text-gray-700 dark:text-gray-300 font-mono bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg break-all">{p.imageTag}</p>
              </div>
              {p.dockerfile && (
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Dockerfile</label>
                  <pre className="text-xs text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 px-2 py-1 rounded-lg overflow-x-auto max-h-24">{p.dockerfile}</pre>
                </div>
              )}
            </div>
          </div>

          {/* Core Information */}
          <div className="border-b border-gray-200 dark:border-gray-700 pb-4">
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Core Information</h3>
            <FormField label="Name" className="mb-3">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input" disabled={loading} />
            </FormField>
            <FormField label="Description" className="mb-3">
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="input" disabled={loading} />
            </FormField>
            <FormField label="Keywords (comma-separated)" className="mb-3">
              <input type="text" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="keyword1, keyword2, keyword3" className="input" disabled={loading} />
            </FormField>
            <FormField label="Version" className="mb-3">
              <input type="text" value={version} onChange={(e) => setVersion(e.target.value)} className="input" disabled={loading} />
            </FormField>
          </div>

          {/* Plugin Configuration */}
          <div className="border-b border-gray-200 dark:border-gray-700 pb-4">
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Plugin Configuration</h3>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <FormField label="Plugin Type">
                <select value={pluginType} onChange={(e) => setPluginType(e.target.value)} className="input" disabled={loading}>
                  <option value="CodeBuildStep">CodeBuildStep</option>
                  <option value="ShellStep">ShellStep</option>
                  <option value="ManualApprovalStep">ManualApprovalStep</option>
                </select>
              </FormField>
              <FormField label="Compute Type">
                <select value={computeType} onChange={(e) => setComputeType(e.target.value)} className="input" disabled={loading}>
                  <option value="SMALL">SMALL</option>
                  <option value="MEDIUM">MEDIUM</option>
                  <option value="LARGE">LARGE</option>
                  <option value="X2_LARGE">X2_LARGE</option>
                </select>
              </FormField>
            </div>
            <FormField label="Primary Output Directory" className="mb-3" hint="Directory where build artifacts are output (used for pipeline artifact tracking)">
              <input type="text" value={primaryOutputDirectory} onChange={(e) => setPrimaryOutputDirectory(e.target.value)} className="input" disabled={loading} placeholder="e.g. cdk.out, dist, build" />
            </FormField>
            <FormField label="Metadata (JSON)" className="mb-3">
              <textarea value={metadata} onChange={(e) => setMetadata(e.target.value)} rows={3} className="input font-mono text-xs" disabled={loading} placeholder='{"key": "value"}' />
            </FormField>
          </div>

          {/* Build Configuration */}
          <div className="border-b border-gray-200 dark:border-gray-700 pb-4">
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Build Configuration</h3>
            <FormField label="Environment Variables (JSON)" className="mb-3">
              <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} className="input font-mono text-xs" disabled={loading} placeholder='{"API_URL": "https://api.example.com"}' />
            </FormField>
            <FormField label="Install Commands (one per line)" className="mb-3">
              <textarea value={installCommands} onChange={(e) => setInstallCommands(e.target.value)} rows={3} className="input font-mono text-xs" disabled={loading} placeholder={"npm install\npip install -r requirements.txt"} />
            </FormField>
            <FormField label="Commands (one per line)" className="mb-3">
              <textarea value={commands} onChange={(e) => setCommands(e.target.value)} rows={3} className="input font-mono text-xs" disabled={loading} placeholder={"npm run build\nnpm test"} />
            </FormField>
          </div>

          {/* Access & Status */}
          <div>
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Access & Status</h3>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <FormField label="Access Modifier" hint={!isSysAdmin ? 'Only system admins can change access level' : undefined}>
                <select value={accessModifier} onChange={(e) => setAccessModifier(e.target.value as 'public' | 'private')} className="input disabled:bg-gray-100 disabled:text-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500" disabled={loading || !isSysAdmin}>
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </FormField>
            </div>
            <div className="flex items-center space-x-6">
              <div className="flex items-center">
                <input id="editIsActive" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded" disabled={loading} />
                <label htmlFor="editIsActive" className="ml-2 block text-sm text-gray-700 dark:text-gray-300">Active</label>
              </div>
              <div className="flex items-center">
                <input id="editIsDefault" type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded" disabled={loading} />
                <label htmlFor="editIsDefault" className="ml-2 block text-sm text-gray-700 dark:text-gray-300">Default</label>
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
