// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import {
  RUNNER_KEY_REVOKE_CONFIRM_CHARS, runnerKeyRevokeConfirmation,
  type RunnerKeyMode, type RunnerSigningKeyDto, type RunnerSigningKeySummary,
} from '@pipeline-builder/api-core/pipeline-runners';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { CopyableId } from '@/components/ui/CopyableId';
import { Disclosure } from '@/components/ui/Disclosure';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { usePolling } from '@/hooks/usePolling';
import api from '@/lib/api';

/** How often the card re-reads while a rotation or a key-mode switch is in
 *  progress, so a promotion shows without a reload. */
export const SIGNING_KEY_REFETCH_MS = 60_000;

/** One step-up-gated write to the org's signing key. `key` is the card state
 *  the dialog describes; revoke carries the typed confirmation as it is typed. */
export type KeyWrite =
  | { kind: 'key-generate'; key: RunnerSigningKeyDto }
  | { kind: 'key-rotate'; key: RunnerSigningKeyDto }
  | { kind: 'key-cancel'; key: RunnerSigningKeyDto }
  | { kind: 'key-finish'; key: RunnerSigningKeyDto }
  | { kind: 'key-revoke'; key: RunnerSigningKeyDto; confirm: string }
  | { kind: 'key-mode'; key: RunnerSigningKeyDto; mode: RunnerKeyMode };

export type KeyWriteKind = KeyWrite['kind'];

export function isKeyWrite(p: { kind: string }): p is KeyWrite {
  return p.kind.startsWith('key-');
}

/** A local clock time, e.g. "9:42 AM" (the full date in the tooltip). */
export function localTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function localDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/** The parent's name where the DTO carries it, else a generic phrase. (In own
 *  mode the DTO has no `inheritedFrom`; the panel may pass the parent's name.) */
function parentName(key: RunnerSigningKeyDto, fallback?: string): string {
  return key.inheritedFrom?.orgName || fallback || 'the parent organization';
}

/** "Used by 3 teams: Payments, Search, Web." for a parent's dialogs. */
function TeamsLine({ k }: { k: RunnerSigningKeyDto }) {
  if (k.inheritingTeams <= 0) return null;
  const names = k.inheritingTeamNames.filter(Boolean);
  return (
    <p data-testid="key-dialog-teams">
      This also changes the key for {k.inheritingTeams} {k.inheritingTeams === 1 ? 'team' : 'teams'} that
      {k.inheritingTeams === 1 ? ' inherits' : ' inherit'} it{names.length > 0 ? `: ${names.join(', ')}` : ''}
      {k.inheritingRunners > 0 ? ` (${k.inheritingRunners} ${k.inheritingRunners === 1 ? 'runner' : 'runners'} in all)` : ''}.
    </p>
  );
}

/** Everything one key write needs: the call, and its step-up dialog's copy. */
interface KeyWriteSpec<K extends KeyWriteKind> {
  send: (p: Extract<KeyWrite, { kind: K }>, stepUpToken: string) => Promise<{ success: boolean; message?: string; data?: unknown }>;
  title: (p: Extract<KeyWrite, { kind: K }>) => string;
  action: string;
  details: (p: Extract<KeyWrite, { kind: K }>, parentOrgName?: string) => ReactNode;
  toast: (p: Extract<KeyWrite, { kind: K }>, parentOrgName?: string) => string;
}

export const KEY_WRITES: { [K in KeyWriteKind]: KeyWriteSpec<K> } = {
  'key-generate': {
    send: (_p, t) => api.generateRunnerSigningKey(t),
    title: () => 'Generate a signing key?',
    action: 'Generate this organization\'s runner signing key',
    details: () => <p>Your runners will verify requests with a key only this organization uses. Nothing changes in your AWS account.</p>,
    toast: () => 'Signing key generated',
  },
  'key-rotate': {
    send: (_p, t) => api.rotateRunnerSigningKey(t),
    title: () => 'Rotate the signing key?',
    action: 'Rotate this organization\'s runner signing key',
    details: (p) => (
      <>
        <p>A new key is published now and starts signing in 10 minutes. The old key stays valid for 1 hour after that.</p>
        <TeamsLine k={p.key} />
      </>
    ),
    toast: () => 'New signing key published — it starts signing in about 10 minutes',
  },
  'key-cancel': {
    send: (_p, t) => api.cancelRunnerSigningKeyRotation(t),
    title: () => 'Cancel the rotation?',
    action: 'Cancel the runner signing key rotation',
    details: () => <p>The new key is withdrawn before it signs anything. The current key keeps signing.</p>,
    toast: () => 'Rotation cancelled',
  },
  'key-finish': {
    send: (_p, t) => api.finishRunnerSigningKeyRotation(t),
    title: () => 'Remove the old key now?',
    action: 'Finish the runner signing key rotation',
    details: () => <p>The old key leaves your runners&apos; public keys now. Requests are already signed with the new key.</p>,
    toast: () => 'Rotation finished — the old key is removed',
  },
  'key-revoke': {
    send: (p, t) => api.revokeRunnerSigningKey(p.confirm.trim(), t),
    title: () => 'Revoke the signing key?',
    action: 'Revoke this organization\'s runner signing key',
    details: () => (
      <p>
        The active key is retired at once and a new key signs from now on. Requests already signed with this key will be
        refused and retried with the new one.
      </p>
    ),
    toast: () => 'Signing key revoked — a new key is signing',
  },
  'key-mode': {
    send: (p, t) => api.setRunnerSigningKeyMode(p.mode, t),
    title: (p) => (p.mode === 'own' ? 'Use our own signing key?' : 'Inherit the parent\'s signing key?'),
    action: 'Change this organization\'s runner key mode',
    details: (p, parent) => (p.mode === 'own'
      ? (
        <>
          <p>
            This organization gets its own key. It is published for your runners now and starts signing in 10 minutes;
            {' '}{parentName(p.key, parent)}&apos;s keys leave your runners&apos; public keys 1 hour later.
          </p>
          <p>Runners {parentName(p.key, parent)} shares with you keep using its key.</p>
        </>
      )
      : (
        <>
          <p>
            {parentName(p.key, parent)}&apos;s keys are published for your runners now and start signing in 10 minutes.
            Your own keys are retired 1 hour later.
          </p>
          <TeamsLine k={p.key} />
        </>
      )),
    toast: (p, parent) => (p.mode === 'own' ? 'Switching to your own signing key' : `Switching to ${parentName(p.key, parent)}'s signing key`),
  },
};

/** The catalog entry for `p`'s kind (the cast is TypeScript's correlated-union limit). */
export function keyWriteSpec(p: KeyWrite): KeyWriteSpec<KeyWriteKind> {
  return KEY_WRITES[p.kind] as unknown as KeyWriteSpec<KeyWriteKind>;
}

/** Revoke's typed confirmation: the last characters of the active key id. Null when it matches. */
export function revokeConfirmProblem(p: KeyWrite): string | null {
  if (p.kind !== 'key-revoke') return null;
  const kid = p.key.active?.kid;
  if (!kid) return 'There is no active key to revoke.';
  return p.confirm.trim() === runnerKeyRevokeConfirmation(kid) ? null : `Type the last ${RUNNER_KEY_REVOKE_CONFIRM_CHARS} characters of the key id.`;
}

/** The typed-confirmation field revoke's dialog shows. */
export function RevokeConfirmField({ write, onChange }: { write: Extract<KeyWrite, { kind: 'key-revoke' }>; onChange: (confirm: string) => void }) {
  const kid = write.key.active?.kid ?? '';
  return (
    <FormField label={`Type the last ${RUNNER_KEY_REVOKE_CONFIRM_CHARS} characters of the key id (${kid}) to confirm`}>
      <Input
        value={write.confirm}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono max-w-[12rem]"
        spellCheck={false}
        autoComplete="off"
        aria-label="Last characters of the key id"
        data-testid="key-revoke-confirm"
      />
    </FormField>
  );
}

function KeyLine({ label, k, testId, children }: { label: string; k: RunnerSigningKeySummary; testId: string; children?: ReactNode }) {
  return (
    <div className="text-sm" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg-muted">{label}</span>
        <CopyableId value={k.kid} size="sm" label={`Copy the ${label.toLowerCase()} id`} />
      </div>
      {children && <div className="text-xs text-fg-muted mt-0.5">{children}</div>}
    </div>
  );
}

/** Whether the card is in a state the server will move on its own (it then refetches). */
export function signingKeyInProgress(k: RunnerSigningKeyDto | null | undefined): boolean {
  if (!k) return false;
  return k.rotation !== 'none' || !!k.transition || (k.inheritedFrom?.rotation ?? 'none') !== 'none';
}

/**
 * The Signing key card, at the top of Settings → Organization → Pipeline
 * runners. Shows key ids and dates only — the browser never sees key material.
 * Every action goes through the panel's `onWrite` (its one step-up dialog).
 *
 * States: no key yet (Generate), active (Rotate, over-age badge), rotation
 * pending (Cancel rotation), rotation overlap (Finish now once the old key's
 * time has passed), inherited from a parent (read-only, Use our own key),
 * unreadable (no actions), and a danger zone with Revoke.
 */
export function RunnerSigningKeyCard({ signingKey: k, readOnly, locked, hasRunners, parentOrgName, onWrite, onRefetch, now = Date.now() }: {
  signingKey: RunnerSigningKeyDto;
  readOnly: boolean;
  /** Read-only, or a write in flight. */
  locked: boolean;
  /** Whether the org has registered a runner (the first one creates the key). */
  hasRunners: boolean;
  /** The parent's name for own mode's "Inherit from …" (the DTO carries it only in inherit mode). */
  parentOrgName?: string;
  onWrite: (p: KeyWrite) => void;
  onRefetch?: () => unknown;
  /** Injected clock (tests). */
  now?: number;
}) {
  usePolling(() => onRefetch?.(), SIGNING_KEY_REFETCH_MS, { immediate: false, enabled: !!onRefetch && signingKeyInProgress(k) });

  const header = (
    <div className="flex items-center gap-2 mb-2">
      <KeyRound className="w-4 h-4 text-fg-muted" />
      <h4 className="text-sm font-semibold">Signing key</h4>
      {k.inheritingTeams > 0 && (
        <span data-testid="key-used-by-teams"><Badge color="blue">Used by {k.inheritingTeams} {k.inheritingTeams === 1 ? 'team' : 'teams'}</Badge></span>
      )}
    </div>
  );
  const frame = (children: ReactNode) => (
    <div className="rounded-lg border border-default p-3" data-testid="runner-signing-key">
      {header}
      <div className="space-y-2">{children}</div>
    </div>
  );

  if (k.unreadable) {
    return frame(
      <Callout variant="danger" title="Your signing key can't be read.">
        <p data-testid="key-unreadable">Runs through your runners are paused until your platform operator fixes it.</p>
      </Callout>,
    );
  }

  const act = !readOnly;
  const transition = k.transition && (
    <p className="text-xs text-fg-muted" data-testid="key-transition">
      {k.transition.kind === 'to_own' && <>Switching to this organization&apos;s own key. It starts signing around {localTime(k.transition.switchAt)}; the parent&apos;s keys are removed at {localTime(k.transition.until)}.</>}
      {k.transition.kind === 'to_inherit' && <>Switching to {parentName(k, parentOrgName)}&apos;s key. It starts signing around {localTime(k.transition.switchAt)}; this organization&apos;s keys are removed at {localTime(k.transition.until)}.</>}
      {k.transition.kind === 'ancestry' && <>The organization this one inherits from changed. The new key starts signing around {localTime(k.transition.switchAt)}; the previous keys are removed at {localTime(k.transition.until)}.</>}
    </p>
  );

  // Inherit mode (outside a switch to own): the parent's key, read-only here.
  if (k.mode === 'inherit' && k.inheritedFrom && k.transition?.kind !== 'to_own') {
    const from = k.inheritedFrom;
    return frame(
      <>
        <p className="text-sm" data-testid="key-inherited-from">Inherited from <strong>{from.orgName}</strong></p>
        {from.activeKid
          ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-fg-muted">Active key</span>
              <CopyableId value={from.activeKid} size="sm" label="Copy the inherited key id" />
            </div>
          )
          : <p className="text-xs text-fg-muted">{from.orgName} has no signing key yet.</p>}
        {from.rotation === 'pending' && <p className="text-xs text-fg-muted" data-testid="key-inherited-rotation">{from.orgName} is rotating its key: a new key starts signing soon.</p>}
        {from.rotation === 'overlap' && <p className="text-xs text-fg-muted" data-testid="key-inherited-rotation">{from.orgName} rotated its key; the old one is removed within the hour.</p>}
        {transition}
        <p className="text-xs text-fg-muted">Rotations by {from.orgName} reach this organization&apos;s runners with no step here.</p>
        {act && !k.isRootOrg && (
          <div>
            <Button type="button" size="xs" variant="secondary" disabled={locked || !!k.transition}
              disabledReason={k.transition ? 'A key-mode change is already in progress.' : undefined}
              onClick={() => onWrite({ kind: 'key-mode', key: k, mode: 'own' })}>
              Use our own key
            </Button>
          </div>
        )}
      </>,
    );
  }

  const { active, next, retiring } = k;
  const busy = k.rotation !== 'none' || !!k.transition;
  const overAge = !!active && k.maxAgeDays > 0 && active.ageDays >= k.maxAgeDays;
  const finishAt = retiring?.retireAfter ? Date.parse(retiring.retireAfter) : NaN;
  const finishReady = Number.isFinite(finishAt) && finishAt <= now;

  if (!active && !next) {
    return frame(
      <>
        <p className="text-sm text-fg-muted" data-testid="key-none">
          {hasRunners
            ? 'This organization has no signing key yet, so its runners cannot be sent requests.'
            : 'A signing key is created when you register your first runner.'}
        </p>
        {transition}
        {act && (
          <Button type="button" size="xs" variant="secondary" disabled={locked} onClick={() => onWrite({ kind: 'key-generate', key: k })}>
            Generate key
          </Button>
        )}
      </>,
    );
  }

  return frame(
    <>
      {active && (
        <KeyLine label="Active key" k={active} testId="key-active">
          Created {localDate(active.createdAt)}{active.createdBy ? <> by <code>{active.createdBy}</code></> : null} · {active.ageDays} {active.ageDays === 1 ? 'day' : 'days'} old
        </KeyLine>
      )}
      {next && (
        <KeyLine label="New key" k={next} testId="key-next">
          <span title={new Date(next.activatesAt).toLocaleString()}>Starts signing around {localTime(next.activatesAt)}</span>
        </KeyLine>
      )}
      {retiring && (
        <KeyLine label="Retiring key" k={retiring} testId="key-retiring">
          <span title={retiring.retireAfter ? new Date(retiring.retireAfter).toLocaleString() : undefined}>Old key removed at {localTime(retiring.retireAfter)}</span>
        </KeyLine>
      )}
      {transition}

      {act && (
        <div className="flex flex-wrap items-center gap-2">
          {k.rotation === 'none' && active && (
            <Button type="button" size="xs" variant="secondary" disabled={locked || busy}
              disabledReason={k.transition ? 'A key-mode change is in progress.' : undefined}
              onClick={() => onWrite({ kind: 'key-rotate', key: k })}>
              Rotate key
            </Button>
          )}
          {k.rotation === 'none' && overAge && active && (
            <span data-testid="key-over-age"><Badge color="yellow">Key is {active.ageDays} days old, consider rotating</Badge></span>
          )}
          {k.rotation === 'pending' && next && (
            <Button type="button" size="xs" variant="secondary" disabled={locked} onClick={() => onWrite({ kind: 'key-cancel', key: k })}>
              Cancel rotation
            </Button>
          )}
          {k.rotation === 'overlap' && retiring && (
            <Button type="button" size="xs" variant="secondary" disabled={locked || !finishReady}
              disabledReason={finishReady ? undefined : `Available at ${localTime(retiring.retireAfter)}, once runners no longer need the old key.`}
              onClick={() => onWrite({ kind: 'key-finish', key: k })}>
              Finish now
            </Button>
          )}
          {!k.isRootOrg && k.mode === 'own' && (
            <Button type="button" size="xs" variant="ghost" disabled={locked || busy}
              disabledReason={busy ? 'Wait for the rotation or key-mode change to finish.' : undefined}
              onClick={() => onWrite({ kind: 'key-mode', key: k, mode: 'inherit' })}>
              Inherit from {parentName(k, parentOrgName)}
            </Button>
          )}
        </div>
      )}
      {/* Over age is worth seeing for a read-only viewer too. */}
      {!act && overAge && active && <span data-testid="key-over-age"><Badge color="yellow">Key is {active.ageDays} days old, consider rotating</Badge></span>}

      {act && active && (
        <div data-testid="key-danger-zone">
        <Disclosure title={<span className="text-xs font-medium text-danger">Danger zone</span>} className="group border border-default rounded-md">
          <div className="space-y-2 text-xs">
            <p className="text-fg-muted">
              Suspect the key leaked? Revoke it: a new key signs at once
              {k.inheritingRunners > 0 ? `, for the ${k.inheritingRunners} ${k.inheritingRunners === 1 ? 'runner' : 'runners'} that verify with it` : ''}.
            </p>
            <Button type="button" size="xs" variant="danger-outline" disabled={locked} onClick={() => onWrite({ kind: 'key-revoke', key: k, confirm: '' })}>
              Revoke key
            </Button>
          </div>
        </Disclosure>
        </div>
      )}
    </>,
  );
}
