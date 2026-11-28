// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AiProviderModelPicker } from '@/components/ui/AiProviderModelPicker';
import { Disclosure } from '@/components/ui/Disclosure';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import type { UseAIProvidersResult } from '@/hooks/useAIProviders';

interface AskModelSettingsProps {
  ai: UseAIProvidersResult;
  /** The private-repository token forwarded to the agent's repo-analysis tool. */
  repoToken: string;
  onRepoTokenChange: (token: string) => void;
  /** A turn is streaming: the choice is locked until it settles. */
  busy: boolean;
}

/** The Ask panel's provider/model picker and private-repository token, collapsed by default. */
export function AskModelSettings({ ai, repoToken, onRepoTokenChange, busy }: AskModelSettingsProps) {
  // Which model answers, and what it may read. Collapsed by default — the
  // defaults are the ask-agent service's own and work untouched.
  return (
    <Disclosure
      title="Model and repository access"
      className="group mt-3 border border-default rounded-xl"
      summaryClassName="cursor-pointer list-none w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-fg-muted hover:text-fg"
      bodyClassName="px-3 pb-3 pt-1 space-y-3 border-t border-default"
    >
      <AiProviderModelPicker ai={ai} disabled={busy} />
      <FormField
        label="Private repository token"
        hint="Sent with this conversation only, so the agent can analyse a private repo you name. It is never shown to the model and is not stored."
      >
        <Input
          type="password"
          autoComplete="off"
          value={repoToken}
          onChange={(e) => onRepoTokenChange(e.target.value)}
          placeholder="Leave empty for public repositories"
          className="text-sm"
          disabled={busy}
        />
      </FormField>
    </Disclosure>
  );
}
