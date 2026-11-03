import { useEffect, useState } from 'react';
import { useFetch } from '@/hooks/useFetch';
import { RetryError } from '@/components/ui/RetryError';
import { Sparkles } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { SectionCard } from '@/components/ui/SectionCard';
import { Badge } from '@/components/ui/Badge';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { ToggleRow } from '@/components/ui/SettingRow';
import { type AIProviderStatus } from '@/types';
import { AI_KEY_PROVIDER_IDS } from '@pipeline-builder/api-core/ai-catalog';
import { AI_PROVIDER_NAMES } from '@/lib/ai-constants';
import api, { ApiError } from '@/lib/api';
import { formatError } from '@/lib/constants';

interface AIProviderConfigProps {
  /** Whether the current user can edit org AI config (`org_settings:write` capability).
   *  Gates the add/update/remove affordances; everyone else sees read-only. */
  canEdit: boolean;
}

/**
 * AI provider configuration section.
 * Manages the organization's AI switch and viewing, adding, updating, and
 * removing AI provider API keys. Extracted from settings.tsx for reusability
 * and readability.
 */
export function AIProviderConfig({ canEdit }: AIProviderConfigProps) {
  const [providers, setProviders] = useState<Record<string, AIProviderStatus>>({});
  // The org's AI switch. `null` until read; an org whose config has no switch is ON.
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);
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

  // Writing a provider secret is step-up-gated server-side. Hold the intended op
  // until the user re-confirms their password in StepUpModal; the fresh token is
  // then forwarded to the PUT. Mirrors OrgKmsConfigModal.
  // Turning AI off (or on) for the whole org rides the same step-up-gated PUT.
  const [pendingOp, setPendingOp] = useState<
    { type: 'add' } | { type: 'update'; id: string } | { type: 'remove'; id: string } | { type: 'toggle'; enabled: boolean } | null
  >(null);

  // The stored config seeds `providers`; each write then replaces it with the
  // write's answer. 404 = the user has no org yet — an empty config, not an error.
  const read = useFetch(async (signal) => {
    try {
      const data = (await api.getOrgAIConfig({ signal })).data;
      return { providers: data?.providers ?? {}, aiEnabled: data?.aiEnabled !== false };
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) return { providers: {}, aiEnabled: true };
      throw err;
    }
  }, []);
  useEffect(() => {
    if (!read.data) return;
    setProviders(read.data.providers);
    setAiEnabled(read.data.aiEnabled);
  }, [read.data]);

  const configuredIds = Object.entries(providers)
    .filter(([, s]) => s.configured)
    .map(([id]) => id);

  // Key-based providers only: a keyless one (Amazon Bedrock runs on the
  // deployment's IAM role) has no key to bring, and the backend refuses to
  // store or serve one — offering the slot asked an admin to clear a step-up
  // and paste a key that no AI call would ever use.
  const availableProviders = Object.entries(AI_PROVIDER_NAMES)
    .filter(([id]) => AI_KEY_PROVIDER_IDS.includes(id) && !configuredIds.includes(id));

  const displayName = (id: string) => AI_PROVIDER_NAMES[id] || id;

  // ── request* : validate, then hand off to the step-up modal ──
  const requestAdd = () => {
    if (!selectedProvider || !newApiKey.trim()) return;
    setError(null);
    setSuccess(null);
    setPendingOp({ type: 'add' });
  };

  const requestUpdate = (id: string) => {
    if (!editApiKey.trim()) return;
    setError(null);
    setSuccess(null);
    setPendingOp({ type: 'update', id });
  };

  const requestRemove = (id: string) => {
    setError(null);
    setSuccess(null);
    setPendingOp({ type: 'remove', id });
  };

  const requestToggle = (enabled: boolean) => {
    setError(null);
    setSuccess(null);
    setPendingOp({ type: 'toggle', enabled });
  };

  // ── execute* : run the gated PUT with the fresh step-up token ──
  const executeToggle = async (enabled: boolean, stepUpToken: string) => {
    setToggleLoading(true);
    try {
      const response = await api.updateOrgAIConfig({ aiEnabled: enabled }, stepUpToken);
      setAiEnabled(response.data?.aiEnabled ?? enabled);
      if (response.data?.providers) setProviders(response.data.providers);
      // Every AI service caches the switch briefly, so say when it takes hold.
      setSuccess(enabled
        ? 'AI features turned on for this organization (takes effect within a minute).'
        : 'AI features turned off for this organization (takes effect within a minute).');
    } catch (err) {
      setError(formatError(err, 'Failed to change the AI setting'));
    } finally {
      setToggleLoading(false);
    }
  };

  const executeAdd = async (stepUpToken: string) => {
    const key = newApiKey.trim();
    if (!selectedProvider || !key) return;
    setAddLoading(true);
    try {
      const response = await api.updateOrgAIConfig({ [selectedProvider]: key }, stepUpToken);
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

  const executeUpdate = async (id: string, stepUpToken: string) => {
    const key = editApiKey.trim();
    if (!key) return;
    setLoading(prev => ({ ...prev, [id]: true }));
    try {
      const response = await api.updateOrgAIConfig({ [id]: key }, stepUpToken);
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

  const executeRemove = async (id: string, stepUpToken: string) => {
    setLoading(prev => ({ ...prev, [id]: true }));
    try {
      const response = await api.updateOrgAIConfig({ [id]: null }, stepUpToken);
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

  const onStepUpConfirmed = async (stepUpToken: string) => {
    const op = pendingOp;
    setPendingOp(null);
    if (!op) return;
    if (op.type === 'add') await executeAdd(stepUpToken);
    else if (op.type === 'update') await executeUpdate(op.id, stepUpToken);
    else if (op.type === 'toggle') await executeToggle(op.enabled, stepUpToken);
    else await executeRemove(op.id, stepUpToken);
  };

  return (
    <SectionCard
      icon={Sparkles}
      title="AI providers"
      description="Whether AI features are available to this organization, and the API keys they use (stored at the organization level)."
    >
      <ErrorAlert message={error} className="mb-4" />
      <SuccessAlert message={success} className="mb-4" />
      {read.error && (
        <RetryError className="mb-4" message={formatError(read.error, 'Could not load AI providers')} onRetry={read.refetch} />
      )}

      {/* The org's AI switch. Off = every AI entry point (Ask, pipeline and
          plugin generation, report summaries) refuses before any quota is
          reserved or any provider is contacted. Read-only without org_settings:write. */}
      {aiEnabled !== null && (
        <ToggleRow
          className="mb-4 border-b border-default"
          label="AI features"
          description={aiEnabled
            ? 'On — members can use the Ask assistant, AI pipeline and plugin generation, and AI report summaries.'
            : 'Off — every AI feature is unavailable to this organization, and no AI provider is contacted.'}
          checked={aiEnabled}
          onChange={requestToggle}
          disabled={!canEdit || toggleLoading}
        />
      )}

      {/* Configured providers */}
      {configuredIds.length > 0 && (
        <div className="space-y-3 mb-4">
          {configuredIds.map((id) => {
            const status = providers[id];
            const isItemLoading = loading[id] ?? false;
            const isEditing = editingProvider === id;

            return (
              <div key={id} className="flex items-center gap-4 p-3 rounded-xl border border-default bg-surface-muted">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-fg">
                      {displayName(id)}
                    </span>
                    <Badge color="green">Configured</Badge>
                    {status?.hint && (
                      <span className="text-xs text-fg-muted">
                        Key: {status.hint}
                      </span>
                    )}
                  </div>
                  {canEdit && isEditing ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="password"
                        autoComplete="off"
                        value={editApiKey}
                        onChange={(e) => setEditApiKey(e.target.value)}
                        placeholder="Enter new API key"
                        className="text-sm flex-1"
                        disabled={isItemLoading}
                      />
                      <Button
                        onClick={() => requestUpdate(id)}
                        disabled={isItemLoading || !editApiKey.trim()}
                      >
                        {isItemLoading ? <LoadingSpinner size="sm" /> : 'Save'}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => { setEditingProvider(null); setEditApiKey(''); }}
                        disabled={isItemLoading}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : canEdit ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => { setEditingProvider(id); setEditApiKey(''); }}
                      >
                        Update
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => requestRemove(id)}
                        disabled={isItemLoading}
                      >
                        {isItemLoading ? <LoadingSpinner size="sm" /> : 'Remove'}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-fg-muted">
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
        <p className="text-sm text-fg-muted mb-4">No AI providers configured yet.</p>
      )}

      {/* Add new provider — admin only */}
      {canEdit && availableProviders.length > 0 && (
        <div className="border-t border-default pt-4">
          <h3 className="text-sm font-medium text-fg mb-3">Add provider</h3>
          <div className="flex items-end gap-3">
            <div className="flex-shrink-0">
              <FormField label="Provider">
                <Select
                  value={selectedProvider}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                  disabled={addLoading}
                >
                  <option value="">Select provider...</option>
                  {availableProviders.map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </Select>
              </FormField>
            </div>
            <div className="flex-1">
              <FormField label="API key">
                <Input
                  type="password"
                  autoComplete="off"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  placeholder="Enter API key"
                  disabled={addLoading || !selectedProvider}
                />
              </FormField>
            </div>
            <Button
              onClick={requestAdd}
              disabled={addLoading || !selectedProvider || !newApiKey.trim()}
            >
              {addLoading ? <LoadingSpinner size="sm" /> : 'Add'}
            </Button>
          </div>
        </div>
      )}

      {pendingOp && (
        <StepUpModal
          action={
            pendingOp.type === 'remove'
              ? `Re-confirm your password to remove the ${displayName(pendingOp.id)} API key.`
              : pendingOp.type === 'toggle'
                ? `Re-confirm your password to turn AI features ${pendingOp.enabled ? 'on' : 'off'} for this organization.`
                : 'Re-confirm your password to save an AI provider API key.'
          }
          onConfirmed={onStepUpConfirmed}
          onClose={() => setPendingOp(null)}
        />
      )}
    </SectionCard>
  );
}
