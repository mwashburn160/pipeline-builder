// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FormField } from '@/components/ui/FormField';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import type { PluginSummary } from '@/lib/api/domains/plugins';
import { formatError } from '@/lib/constants';

/** Which version-lifecycle action the dialog confirms. */
export type PluginLifecycleAction = 'deprecate' | 'undeprecate' | 'yank';

/** Max length of a deprecation message / yank reason (server: 500). */
export const LIFECYCLE_TEXT_MAX = 500;

/** Whether a version is yanked (the timestamp is authoritative). */
export function isYanked(p: Pick<PluginSummary, 'yankedAt'>): boolean {
  return Boolean(p.yankedAt);
}

/** Whether a version is deprecated (the timestamp is authoritative). */
export function isDeprecated(p: Pick<PluginSummary, 'deprecatedAt'>): boolean {
  return Boolean(p.deprecatedAt);
}

/**
 * The actions a writer may take on a version's lifecycle (W0.4): a yanked
 * version is final here, so it offers none; otherwise deprecate or clear it,
 * and yank.
 */
export function lifecycleActionsFor(p: Pick<PluginSummary, 'yankedAt' | 'deprecatedAt'>): PluginLifecycleAction[] {
  if (isYanked(p)) return [];
  return [isDeprecated(p) ? 'undeprecate' : 'deprecate', 'yank'];
}

const COPY: Record<PluginLifecycleAction, { title: string; confirm: string; done: string; failed: string }> = {
  deprecate: { title: 'Deprecate version', confirm: 'Deprecate', done: 'Version deprecated', failed: 'Failed to deprecate version' },
  undeprecate: { title: 'Clear deprecation', confirm: 'Clear deprecation', done: 'Deprecation cleared', failed: 'Failed to clear deprecation' },
  yank: { title: 'Yank version', confirm: 'Yank', done: 'Version yanked', failed: 'Failed to yank version' },
};

/**
 * Confirm a version-lifecycle action and run it: deprecate (with an optional
 * message for users), clear a deprecation, or yank (with a required reason).
 * The server enforces the same gates as edit (`plugins:write`, `plugins:publish`
 * for a public version); a version published to the ecosystem refuses a yank
 * with 409, surfaced here as the error.
 */
export function PluginLifecycleModal({ plugin, action, onClose, onDone }: {
  plugin: PluginSummary;
  action: PluginLifecycleAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const copy = COPY[action];
  const ref = `${plugin.name}@${plugin.version}`;

  const submit = async () => {
    const trimmed = text.trim();
    if (action === 'yank' && !trimmed) {
      setError('A reason is required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (action === 'yank') {
        const res = await api.yankPlugin(plugin.id, trimmed);
        const promoted = res.data?.promotedDefault;
        toast.success(promoted ? `${copy.done}; ${plugin.name}@${promoted.version} is now the default` : copy.done);
      } else if (action === 'deprecate') {
        await api.deprecatePlugin(plugin.id, trimmed ? { deprecated: true, message: trimmed } : { deprecated: true });
        toast.success(copy.done);
      } else {
        await api.deprecatePlugin(plugin.id, { deprecated: false });
        toast.success(copy.done);
      }
      onDone();
      onClose();
    } catch (err) {
      setError(formatError(err, copy.failed));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ConfirmDialog
      title={copy.title}
      confirmLabel={copy.confirm}
      tone={action === 'yank' ? 'danger' : 'primary'}
      loading={loading}
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      {action === 'deprecate' && (
        <p>
          <strong className="text-fg">{ref}</strong> keeps resolving, but synth prints a warning, AI suggestions stop
          offering it, and the organizations whose pipelines use it are notified.
        </p>
      )}
      {action === 'undeprecate' && (
        <p><strong className="text-fg">{ref}</strong> will no longer be marked deprecated.</p>
      )}
      {action === 'yank' && (
        <p>
          <strong className="text-fg">{ref}</strong> stops resolving for version ranges, <code>latest</code> and the
          default. Pipelines pinned to exactly this version still resolve it, with a warning showing your reason.
          {plugin.isDefault ? ' The next version becomes the default.' : ''} This cannot be undone here.
        </p>
      )}
      {action !== 'undeprecate' && (
        <FormField
          label={action === 'yank' ? 'Reason' : 'Message for users (optional)'}
          required={action === 'yank'}
          error={error ?? undefined}
        >
          <Textarea
            rows={3}
            maxLength={LIFECYCLE_TEXT_MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={action === 'yank' ? 'e.g. Leaks credentials in build logs; use 1.2.1' : 'e.g. Use 2.x — 1.x is no longer maintained'}
          />
        </FormField>
      )}
      {action === 'undeprecate' && error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </ConfirmDialog>
  );
}
