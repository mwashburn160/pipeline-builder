// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState } from 'react';
import api from '@/lib/api';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Button } from '@/components/ui/Button';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { ALL_FEATURE_FLAGS, FEATURE_METADATA, type FeatureFlag } from '@/lib/feature-flags';
import { useMutation } from '@/hooks/useMutation';

/**
 * Per-user, PER-ORG feature-flag override editor. Overrides are stored per
 * organization and only apply in that org; `organizationId` names the org whose
 * entry is being edited (and `initial` must be that org's overrides). Each flag
 * has three states:
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
  organizationId,
  organizationName,
  initial,
  onSaved,
}: {
  userId: string;
  /** The org whose overrides are edited. Omitted → the backend's default
   *  (an org admin's own org; for a sysadmin, the user's last-active org). */
  organizationId?: string;
  /** Display name of that org, shown so the operator knows the scope. */
  organizationName?: string;
  initial: Record<string, boolean>;
  onSaved: () => void;
}) {
  const [state, setState] = useState<Record<string, boolean | undefined>>(() => ({ ...initial }));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Granting capabilities needs a fresh password check; Save opens it.
  const [confirming, setConfirming] = useState(false);

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

  const save = useMutation({
    fn: async (stepUpToken: string) => {
      // Filter out `undefined` (inherit) and send only the explicit overrides.
      const overrides = Object.fromEntries(
        Object.entries(state).filter(([, v]) => typeof v === 'boolean'),
      ) as Record<string, boolean>;
      const res = await api.updateUserFeatures(userId, overrides, stepUpToken, organizationId);
      if (!res.success) throw new Error(res.message || 'Save failed');
    },
    scopeKey: `${userId}:${organizationId ?? ''}`,
    onSuccess: () => {
      setSavedAt(Date.now());
      onSaved();
    },
  });
  const saving = save.pending;
  const error = save.error;
  const { run: runSave } = save;

  const handleSave = useCallback(async (stepUpToken: string) => {
    setConfirming(false);
    await runSave(stepUpToken);
  }, [runSave]);

  return (
    <div className="rounded-lg border border-default px-3 py-2 text-sm">
      <div className="font-medium text-fg-muted mb-2">Feature overrides</div>
      <p className="text-xs text-fg-muted mb-2">
        {organizationName
          ? <>Overrides apply only in <span className="font-medium text-fg">{organizationName}</span>. </>
          : <>Overrides apply only in the user&apos;s current organization. </>}
        Each flag inherits from that org&apos;s tier by default. Override only
        when needed — overrides persist until removed.
      </p>
      <ul className="space-y-2">
        {ALL_FEATURE_FLAGS.map((flag) => {
          const value = state[flag];
          const meta = FEATURE_METADATA[flag];
          return (
            <li key={flag} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-fg">{meta.label}</div>
                <div className="text-xs text-fg-muted">{meta.description}</div>
              </div>
              <FilterSelect
                value={value === true ? 'on' : value === false ? 'off' : 'inherit'}
                onChange={(e) => {
                  const v = e.target.value;
                  setFlag(flag, v === 'on' ? true : v === 'off' ? false : undefined);
                }}
                className="text-xs"
                aria-label={`Override ${meta.label}`}
                disabled={saving}
              >
                <option value="inherit">inherit</option>
                <option value="on">on</option>
                <option value="off">off</option>
              </FilterSelect>
            </li>
          );
        })}
      </ul>
      <ErrorAlert message={error} className="mt-2 text-xs" />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-fg-muted">
          {savedAt && !dirty && 'Saved.'}
        </span>
        <Button
          variant="secondary"
          onClick={() => setConfirming(true)}
          disabled={saving || !dirty}
          className="text-xs"
        >
          {saving ? 'Saving…' : 'Save overrides'}
        </Button>
      </div>
      {confirming && (
        <StepUpModal
          action="Change this user's feature overrides"
          onConfirmed={(token) => { void handleSave(token); }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
