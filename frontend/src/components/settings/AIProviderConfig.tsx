import { useEffect, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { type AIProviderStatus } from '@/types';
import { AI_PROVIDER_NAMES } from '@/lib/ai-constants';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';

interface AIProviderConfigProps {
  isAdmin: boolean;
}

/**
 * AI provider configuration section.
 * Manages viewing, adding, updating, and removing AI provider API keys.
 * Extracted from settings.tsx for reusability and readability.
 */
export function AIProviderConfig({ isAdmin }: AIProviderConfigProps) {
  const [providers, setProviders] = useState<Record<string, AIProviderStatus>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [selectedProvider, setSelectedProvider] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  // Inline edit state
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editApiKey, setEditApiKey] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const response = await api.getOrgAIConfig();
        if (response.data?.providers) {
          setProviders(response.data.providers);
        }
      } catch {
        // Non-critical — user may not have an org
      }
    })();
  }, []);

  const configuredIds = Object.entries(providers)
    .filter(([, s]) => s.configured)
    .map(([id]) => id);

  const availableProviders = Object.entries(AI_PROVIDER_NAMES)
    .filter(([id]) => !configuredIds.includes(id));

  const displayName = (id: string) => AI_PROVIDER_NAMES[id] || id;

  const handleAdd = async () => {
    const key = newApiKey.trim();
    if (!selectedProvider || !key) return;
    setError(null);
    setSuccess(null);
    setAddLoading(true);
    try {
      const response = await api.updateOrgAIConfig({ [selectedProvider]: key });
      if (response.data?.providers) setProviders(response.data.providers);
      setSuccess(`${displayName(selectedProvider)} added`);
      setSelectedProvider('');
      setNewApiKey('');
    } catch (err) {
      setError(formatError(err, 'Failed to add provider'));
    } finally {
      setAddLoading(false);
    }
  };

  const handleUpdate = async (id: string) => {
    const key = editApiKey.trim();
    if (!key) return;
    setError(null);
    setSuccess(null);
    setLoading(prev => ({ ...prev, [id]: true }));
    try {
      const response = await api.updateOrgAIConfig({ [id]: key });
      if (response.data?.providers) setProviders(response.data.providers);
      setSuccess(`${displayName(id)} API key updated`);
      setEditingProvider(null);
      setEditApiKey('');
    } catch (err) {
      setError(formatError(err, 'Failed to update API key'));
    } finally {
      setLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleRemove = async (id: string) => {
    setError(null);
    setSuccess(null);
    setLoading(prev => ({ ...prev, [id]: true }));
    try {
      const response = await api.updateOrgAIConfig({ [id]: null });
      if (response.data?.providers) setProviders(response.data.providers);
      setSuccess(`${displayName(id)} removed`);
      if (editingProvider === id) {
        setEditingProvider(null);
        setEditApiKey('');
      }
    } catch (err) {
      setError(formatError(err, 'Failed to remove provider'));
    } finally {
      setLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  return (
    <>
      <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">AI Providers</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Configure API keys for AI-powered pipeline generation. Keys are stored at the organization level.
      </p>

      {error && <div className="alert-error mb-4"><p>{error}</p></div>}
      {success && <div className="alert-success mb-4"><p>{success}</p></div>}

      {/* Configured providers */}
      {configuredIds.length > 0 && (
        <div className="space-y-3 mb-4">
          {configuredIds.map((id) => {
            const status = providers[id];
            const isItemLoading = loading[id] ?? false;
            const isEditing = editingProvider === id;

            return (
              <div key={id} className="flex items-center gap-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {displayName(id)}
                    </span>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                      Configured
                    </span>
                    {status?.hint && (
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        Key: {status.hint}
                      </span>
                    )}
                  </div>
                  {isAdmin && isEditing ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={editApiKey}
                        onChange={(e) => setEditApiKey(e.target.value)}
                        placeholder="Enter new API key"
                        className="input text-sm flex-1"
                        disabled={isItemLoading}
                      />
                      <button
                        onClick={() => handleUpdate(id)}
                        disabled={isItemLoading || !editApiKey.trim()}
                        className="btn btn-primary"
                      >
                        {isItemLoading ? <LoadingSpinner size="sm" /> : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingProvider(null); setEditApiKey(''); }}
                        disabled={isItemLoading}
                        className="btn btn-secondary"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : isAdmin ? (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { setEditingProvider(id); setEditApiKey(''); }}
                        className="btn btn-secondary"
                      >
                        Update
                      </button>
                      <button
                        onClick={() => handleRemove(id)}
                        disabled={isItemLoading}
                        className="btn btn-danger"
                      >
                        {isItemLoading ? <LoadingSpinner size="sm" /> : 'Remove'}
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Key ending in {status?.hint}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {configuredIds.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500 mb-4">No AI providers configured yet.</p>
      )}

      {/* Add new provider — admin only */}
      {isAdmin && availableProviders.length > 0 && (
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Add Provider</h3>
          <div className="flex items-end gap-3">
            <div className="flex-shrink-0">
              <label htmlFor="ai-provider-select" className="label text-xs">Provider</label>
              <select
                id="ai-provider-select"
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                className="input text-sm"
                disabled={addLoading}
              >
                <option value="">Select provider...</option>
                {availableProviders.map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label htmlFor="ai-api-key" className="label text-xs">API Key</label>
              <input
                id="ai-api-key"
                type="password"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder="Enter API key"
                className="input text-sm"
                disabled={addLoading || !selectedProvider}
              />
            </div>
            <button
              onClick={handleAdd}
              disabled={addLoading || !selectedProvider || !newApiKey.trim()}
              className="btn btn-primary"
            >
              {addLoading ? <LoadingSpinner size="sm" /> : 'Add'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
