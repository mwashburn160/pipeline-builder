import { ChevronDown, ChevronUp } from 'lucide-react';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { getProviderSourceLabel } from '@/lib/ai-constants';
import type { UseAIProvidersResult } from '@/hooks/useAIProviders';

/** Props for the {@link AiProviderModelPicker} component. */
interface AiProviderModelPickerProps {
  /** Provider/model selection state from the {@link useAIProviders} hook. */
  ai: UseAIProvidersResult;
  /** Whether the picker inputs should be disabled. */
  disabled?: boolean;
}

/**
 * Shared provider/model selector with a collapsible custom-API-key override.
 *
 * Renders a Provider `<Select>` over `ai.providers`, a Model `<Select>` over
 * `ai.currentModels`, and the API-key override toggle whose copy adapts to the
 * selected provider's source (`none` / `org` / `server`). Used by all three AI
 * generation tabs (prompt, git-url, plugin) to keep the picker UX identical.
 */
export function AiProviderModelPicker({ ai, disabled }: AiProviderModelPickerProps) {
  return (
    <>
      {/* Provider and Model Selection */}
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Provider">
          <Select
            value={ai.selectedProvider}
            onChange={(e) => ai.setSelectedProvider(e.target.value)}
            disabled={disabled}
          >
            {ai.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {getProviderSourceLabel(p)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Model">
          <Select
            value={ai.selectedModel}
            onChange={(e) => ai.setSelectedModel(e.target.value)}
            disabled={disabled}
          >
            {ai.currentModels.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </Select>
        </FormField>
      </div>

      {/* Custom API Key Override */}
      <div>
        <button
          type="button"
          onClick={() => ai.setShowKeyOverride(!ai.showKeyOverride)}
          aria-expanded={ai.showKeyOverride}
          className="flex items-center text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
        >
          {ai.showKeyOverride ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
          {ai.currentSource === 'none' ? 'Enter API key' : 'Use custom API key'}
        </button>
        {ai.showKeyOverride && (
          <div className="mt-2">
            <Input
              type="password"
              autoComplete="off"
              value={ai.customApiKey}
              onChange={(e) => ai.setCustomApiKey(e.target.value)}
              placeholder={
                ai.currentSource === 'none'
                  ? 'Enter API key for this provider'
                  : ai.currentSource === 'org' ? 'Leave empty to use organization key' : 'Leave empty to use server key'
              }
              className="text-sm"
              disabled={disabled}
            />
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              {ai.currentSource === 'none'
                ? 'An API key is required to use this provider.'
                : `Overrides the ${ai.currentSource === 'org' ? 'organization' : 'server'} key for this request only.`}
            </p>
          </div>
        )}
      </div>
    </>
  );
}
