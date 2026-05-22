// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState } from 'react';
import api from '@/lib/api';
import { ALL_FEATURE_FLAGS, FEATURE_METADATA, type FeatureFlag } from '@/lib/feature-flags';

/**
 * Per-user feature-flag override editor. Each flag has three states:
 *   inherit (no override) | on (force-enable) | off (force-disable).
 *
 * The diff between `initial` and `state` is sent on Save — keys that
 * went back to `inherit` are omitted because the backend takes a full
 * `overrides` object that replaces the prior one.
 *
 * Sysadmin-only on the route layer; org admins are also accepted for
 * users in their own org. The user-edit modal is sysadmin-gated, so in
 * practice this only renders for sysadmin operators.
 */
export function FeatureOverridesEditor({
  userId,
  initial,
  onSaved,
}: {
  userId: string;
  initial: Record<string, boolean>;
  onSaved: () => void;
}) {
  const [state, setState] = useState<Record<string, boolean | undefined>>(() => ({ ...initial }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty = useMemo(() => {
    const keys = new Set([...Object.keys(initial), ...Object.keys(state)]);
    for (const k of keys) {
      if (initial[k] !== state[k]) return true;
    }
    return false;
  }, [initial, state]);

  const setFlag = useCallback((flag: FeatureFlag, value: boolean | undefined) => {
    setState((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[flag];
      else next[flag] = value;
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      // Filter out `undefined` (inherit) and send only the explicit overrides.
      const overrides = Object.fromEntries(
        Object.entries(state).filter(([, v]) => typeof v === 'boolean'),
      ) as Record<string, boolean>;
      const res = await api.updateUserFeatures(userId, overrides);
      if (res.success) {
        setSavedAt(Date.now());
        onSaved();
      } else {
        setError(res.message || 'Save failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [userId, state, onSaved]);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm">
      <div className="font-medium text-gray-700 dark:text-gray-300 mb-2">Feature overrides</div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
        Each flag inherits from the user&apos;s org tier by default. Override only
        when needed — overrides persist until removed.
      </p>
      <ul className="space-y-2">
        {ALL_FEATURE_FLAGS.map((flag) => {
          const value = state[flag];
          const meta = FEATURE_METADATA[flag];
          return (
            <li key={flag} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-gray-800 dark:text-gray-200">{meta.label}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{meta.description}</div>
              </div>
              <select
                value={value === true ? 'on' : value === false ? 'off' : 'inherit'}
                onChange={(e) => {
                  const v = e.target.value;
                  setFlag(flag, v === 'on' ? true : v === 'off' ? false : undefined);
                }}
                className="filter-select text-xs"
                aria-label={`Override ${meta.label}`}
                disabled={saving}
              >
                <option value="inherit">inherit</option>
                <option value="on">on</option>
                <option value="off">off</option>
              </select>
            </li>
          );
        })}
      </ul>
      {error && <div className="alert-error mt-2 text-xs"><p>{error}</p></div>}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {savedAt && !dirty && 'Saved.'}
        </span>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="btn btn-secondary text-xs"
        >
          {saving ? 'Saving…' : 'Save overrides'}
        </button>
      </div>
    </div>
  );
}
