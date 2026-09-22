// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { CheckCheck, Pencil, Plus, Power, PowerOff, Trash2, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useEcosystemApprovers } from '@/hooks/useEcosystemApprovers';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { AutoRule, AutoRuleConditions, PublisherTier } from '@/types/ecosystem';
import { EcosystemActionDialog } from './EcosystemActionDialog';
import { ErrorAlert } from '@/components/ui/ErrorAlert';

interface Props {
  can: (permission: string) => boolean;
  /** The signed-in user — the proposer of a change can't approve it. */
  currentUserId: string;
}

const KIND_OPTIONS = [
  { value: 'new_version', label: 'New versions' },
  { value: 'listing_update', label: 'Listing updates' },
] as const;
const TIER_OPTIONS: ReadonlyArray<{ value: PublisherTier; label: string }> = [
  { value: 'official', label: 'Official' },
  { value: 'verified', label: 'Verified' },
  { value: 'community', label: 'Community' },
];
const BUMP_OPTIONS = [
  { value: 'patch', label: 'Patch' },
  { value: 'minor', label: 'Minor' },
] as const;

/** One line per condition, for the rule list and the confirmation. */
export function describeConditions(c: AutoRuleConditions): string[] {
  const out = [
    `Kinds: ${c.requestKinds.map((k) => (k === 'new_version' ? 'new versions' : 'listing updates')).join(', ') || 'none'}`,
    `Publisher tiers: ${c.publisherTiers.join(', ') || 'none'}`,
    `Version bumps: ${c.bumps.join(', ') || 'none'}`,
  ];
  if (c.submitterServiceAccount) out.push(`Submitted by service account ${c.submitterServiceAccount}`);
  if (c.textOnlyListingUpdates) out.push('Listing updates: text fields only (no links, no icon)');
  if (c.maxPerListingPerDay != null) out.push(`At most ${c.maxPerListingPerDay} per listing per day`);
  if (c.maxPerDay != null) out.push(`At most ${c.maxPerDay} per day`);
  if (c.instanceFlag) out.push(`Only while ${c.instanceFlag} is on`);
  return out;
}

const toggle = <T,>(list: readonly T[], value: T, on: boolean): T[] =>
  on ? [...new Set([...list, value])] : list.filter((v) => v !== value);

const EMPTY_CONDITIONS: AutoRuleConditions = {
  requestKinds: ['new_version'],
  publisherTiers: ['verified'],
  bumps: ['patch'],
};

/** The server's bounds (`AutoRuleConditionsSchema`, `parseName`), checked here
 *  first so a refusal never costs a step-up. */
const NAME_MAX = 255;
const MAX_PER_LISTING_PER_DAY = 1000;
const MAX_PER_DAY = 100_000;

/** Why a rule would be refused, or null. */
export function ruleProblem(value: { name: string; conditions: AutoRuleConditions }): string | null {
  const { name, conditions: c } = value;
  if (!name.trim()) return 'Give the rule a name.';
  if (name.trim().length > NAME_MAX) return `The name is at most ${NAME_MAX} characters.`;
  if (c.requestKinds.length === 0) return 'Choose at least one request kind.';
  if (c.publisherTiers.length === 0) return 'Choose at least one publisher tier.';
  if (c.requestKinds.includes('new_version') && c.bumps.length === 0) return 'Choose which version bumps new versions may auto-approve.';
  if (c.maxPerListingPerDay != null && (!Number.isInteger(c.maxPerListingPerDay) || c.maxPerListingPerDay > MAX_PER_LISTING_PER_DAY)) return `Max per listing per day is a whole number up to ${MAX_PER_LISTING_PER_DAY}.`;
  if (c.maxPerDay != null && (!Number.isInteger(c.maxPerDay) || c.maxPerDay > MAX_PER_DAY)) return `Max per day is a whole number up to ${MAX_PER_DAY}.`;
  return null;
}

type RuleValue = { name: string; conditions: AutoRuleConditions };

/** Create or edit a rule's name and conditions (the step-up confirmation follows). */
function RuleFormDialog({ rule, draft, initialError, onClose, onSave }: {
  rule: AutoRule | null;
  /** What was typed before the confirmation (or the server) refused it. */
  draft?: RuleValue;
  initialError?: string | null;
  onClose: () => void;
  onSave: (value: RuleValue) => void;
}) {
  const [name, setName] = useState(draft?.name ?? rule?.name ?? '');
  const [c, setC] = useState<AutoRuleConditions>(draft?.conditions ?? rule?.conditions ?? EMPTY_CONDITIONS);
  const num = (v: string) => (v.trim() === '' ? undefined : Math.max(0, Math.floor(Number(v))));
  const problem = ruleProblem({ name, conditions: c });
  const valid = problem === null;

  return (
    <Modal
      title={rule ? `Edit rule: ${rule.name}` : 'New auto-approval rule'}
      onClose={onClose}
      maxWidth="max-w-lg"
      footer={(
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => onSave({ name: name.trim(), conditions: c })}
          confirmLabel="Continue"
          confirmDisabled={!valid}
        />
      )}
    >
      <div className="space-y-4 text-sm">
        <ErrorAlert message={initialError ?? null} />
        <p className="text-xs text-fg-muted">
          {rule
            ? 'Changing the conditions (or re-enabling the rule) is a proposal: it takes effect once a second approver confirms it.'
            : 'New rules start disabled. They take effect once a second approver confirms them.'}
        </p>
        <FormField label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <fieldset className="space-y-1">
          <legend className="label">Request kinds</legend>
          {KIND_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-center gap-2">
              <Checkbox checked={c.requestKinds.includes(o.value)} onChange={(e) => setC({ ...c, requestKinds: toggle(c.requestKinds, o.value, e.target.checked) })} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="label">Publisher tiers</legend>
          {TIER_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-center gap-2">
              <Checkbox checked={c.publisherTiers.includes(o.value)} onChange={(e) => setC({ ...c, publisherTiers: toggle(c.publisherTiers, o.value, e.target.checked) })} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="label">Version bumps</legend>
          {BUMP_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-center gap-2">
              <Checkbox checked={c.bumps.includes(o.value)} onChange={(e) => setC({ ...c, bumps: toggle(c.bumps, o.value, e.target.checked) })} />
              {o.label}
            </label>
          ))}
          <p className="form-hint">Majors and breaking versions never auto-approve.</p>
        </fieldset>
        <label className="flex items-center gap-2">
          <Checkbox checked={!!c.textOnlyListingUpdates} onChange={(e) => setC({ ...c, textOnlyListingUpdates: e.target.checked || undefined })} />
          Listing updates: text fields only (no links, no icon)
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Max per listing per day">
            <Input type="number" min={0} value={c.maxPerListingPerDay ?? ''} onChange={(e) => setC({ ...c, maxPerListingPerDay: num(e.target.value) })} />
          </FormField>
          <FormField label="Max per day">
            <Input type="number" min={0} value={c.maxPerDay ?? ''} onChange={(e) => setC({ ...c, maxPerDay: num(e.target.value) })} />
          </FormField>
        </div>
        {problem && name.trim() && <p className="text-xs text-warning-strong" role="status">{problem}</p>}
      </div>
    </Modal>
  );
}

type Pending =
  | { kind: 'form'; rule: AutoRule | null; draft?: RuleValue; error?: string | null }
  | { kind: 'save'; rule: AutoRule | null; value: RuleValue }
  | { kind: 'enable' | 'disable' | 'approve' | 'delete'; rule: AutoRule };

/**
 * Ecosystem console → Auto-approval rules. Rules decide
 * routine requests without a human; creating, widening or re-enabling one is
 * itself two-person — the proposer can't approve their own change. Disabling
 * applies at once. Every write is step-up gated.
 */
export function AutoApprovalRulesPanel({ can, currentUserId }: Props) {
  const toast = useToast();
  const mayModerate = can('plugins:moderate');
  const rulesQ = useFetch(async (signal) => {
    const res = await api.listAutoRules({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load rules');
    return res.data.rules;
  }, []);
  // A new or widened rule only takes effect through a second approver; with
  // fewer than two managers that second approver has to be a superadmin.
  const approvers = useEcosystemApprovers();
  const tooFewApprovers = approvers?.moderate.belowTwoPerson ?? false;
  const [pending, setPending] = useState<Pending | null>(null);
  const close = () => setPending(null);
  const rules = rulesQ.data ?? [];

  /** From a save confirmation back to the form, values intact (only if that
   *  confirmation is still the current step — see AdvisoriesPanel). */
  const backToForm = (p: Pending, error: string | null) => {
    setPending((cur) => (cur === p && p.kind === 'save' ? { kind: 'form', rule: p.rule, draft: p.value, error } : cur === p ? null : cur));
  };

  const run = async (token?: string) => {
    if (!pending) return;
    if (pending.kind === 'save') {
      const current = pending;
      try {
        if (current.rule) {
          await api.updateAutoRule(current.rule.id, current.value, token);
          toast.success('Change proposed. It takes effect once a second approver confirms it.');
        } else {
          await api.createAutoRule(current.value, token);
          toast.success('Rule created, disabled until a second approver confirms it.');
        }
      } catch (err) {
        // A refusal returns to the filled-in form with the reason.
        backToForm(current, formatError(err, 'Could not save the rule'));
        return;
      }
      close(); // done — the dialog's own close that follows must not reopen the form
    } else if (pending.kind === 'enable') {
      await api.updateAutoRule(pending.rule.id, { enabled: true }, token);
      toast.success('Enabling proposed. It takes effect once a second approver confirms it.');
    } else if (pending.kind === 'disable') {
      await api.updateAutoRule(pending.rule.id, { enabled: false }, token);
      toast.success(`Disabled ${pending.rule.name}`);
    } else if (pending.kind === 'approve') {
      await api.approveAutoRuleChange(pending.rule.id, token);
      toast.success(`Approved the change to ${pending.rule.name}`);
    } else if (pending.kind === 'delete') {
      await api.deleteAutoRule(pending.rule.id, token);
      toast.success(`Deleted ${pending.rule.name}`);
    }
    void rulesQ.refetch();
  };

  return (
    <SectionCard
      icon={Zap}
      title="Auto-approval rules"
      description="Routine requests these rules match are approved without a human. Anything riskier waits in the queue."
      actions={mayModerate ? (
        <Button size="sm" onClick={() => setPending({ kind: 'form', rule: null })}>
          <Plus className="w-4 h-4 mr-1" aria-hidden />New rule
        </Button>
      ) : undefined}
    >
      {mayModerate && tooFewApprovers && (
        <p className="mb-3 text-xs text-warning-strong" data-testid="rules-too-few-approvers">
          A new rule stays disabled until a second approver confirms it. With fewer than two Ecosystem Managers, that
          has to be a superadmin.
        </p>
      )}
      {rulesQ.loading && !rulesQ.data ? (
        <Skeleton className="h-24 w-full" />
      ) : rulesQ.error ? (
        <RetryError message={formatError(rulesQ.error, 'Failed to load rules')} onRetry={rulesQ.refetch} />
      ) : rules.length === 0 ? (
        <EmptyState compact icon={Zap} title="No rules" description="Every request waits for a human decision." />
      ) : (
        <ul className="space-y-3" aria-label="Auto-approval rules">
          {rules.map((r) => {
            const ownProposal = !!r.pendingChange && r.pendingChange.requestedBy === currentUserId;
            return (
              <li key={r.id} className="rounded-lg border border-default p-3 space-y-2" data-testid={`rule-${r.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-fg">{r.name}</span>
                      {r.seeded && <Badge color="blue">Seeded</Badge>}
                      {r.enabled ? <Badge color="green">Enabled</Badge> : <Badge color="gray">Disabled</Badge>}
                      {r.flagDisabled && <Badge color="yellow">Off by instance flag</Badge>}
                      {r.pendingChange && <Badge color="indigo">Change pending</Badge>}
                    </div>
                    <p className="text-xs text-fg-muted">{r.approvedToday} approved today</p>
                    <ul className="list-disc pl-5 text-xs text-fg-muted">
                      {describeConditions(r.conditions).map((line) => <li key={line}>{line}</li>)}
                    </ul>
                  </div>
                  {mayModerate && (
                    <div className="flex flex-wrap gap-1">
                      <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'form', rule: r })} aria-label={`Edit ${r.name}`}>
                        <Pencil className="w-3.5 h-3.5 mr-1" aria-hidden />Edit
                      </Button>
                      {r.enabled ? (
                        <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'disable', rule: r })} aria-label={`Disable ${r.name}`}>
                          <PowerOff className="w-3.5 h-3.5 mr-1" aria-hidden />Disable
                        </Button>
                      ) : (
                        <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'enable', rule: r })} disabled={!!r.pendingChange} aria-label={`Enable ${r.name}`}>
                          <Power className="w-3.5 h-3.5 mr-1" aria-hidden />Enable
                        </Button>
                      )}
                      <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'delete', rule: r })} aria-label={`Delete ${r.name}`}>
                        <Trash2 className="w-3.5 h-3.5 mr-1" aria-hidden />Delete
                      </Button>
                    </div>
                  )}
                </div>

                {r.pendingChange && (
                  <div className="rounded-md bg-surface-muted p-2 text-xs space-y-1" data-testid={`rule-pending-${r.id}`}>
                    <p>
                      Proposed <RelativeTime value={r.pendingChange.requestedAt} /> by{' '}
                      <span className="font-medium">{ownProposal ? 'you' : r.pendingChange.requestedBy}</span>:{' '}
                      {r.pendingChange.enabled ? 'enabled' : 'disabled'}, named &ldquo;{r.pendingChange.name}&rdquo;.
                    </p>
                    <ul className="list-disc pl-5 text-fg-muted">
                      {describeConditions(r.pendingChange.conditions).map((line) => <li key={line}>{line}</li>)}
                    </ul>
                    {mayModerate && (ownProposal ? (
                      <p className="text-fg-muted" data-testid="own-proposal-note">You proposed this change; a different Ecosystem Manager or a superadmin must approve it.</p>
                    ) : (
                      <Button size="xs" onClick={() => setPending({ kind: 'approve', rule: r })} aria-label={`Approve the change to ${r.name}`}>
                        <CheckCheck className="w-3.5 h-3.5 mr-1" aria-hidden />Approve change
                      </Button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {pending?.kind === 'form' && (
        <RuleFormDialog
          rule={pending.rule}
          draft={pending.draft}
          initialError={pending.error}
          onClose={close}
          onSave={(value) => setPending({ kind: 'save', rule: pending.rule, value })}
        />
      )}
      {pending?.kind === 'save' && (
        <EcosystemActionDialog
          title={pending.rule ? 'Propose this change?' : 'Create this rule?'}
          action={pending.rule ? `Propose a change to ${pending.rule.name}` : `Create the rule ${pending.value.name}`}
          details={<ul className="list-disc pl-5 text-xs">{describeConditions(pending.value.conditions).map((l) => <li key={l}>{l}</li>)}</ul>}
          stepUp
          onSubmit={(_r, token) => run(token)}
          onClose={() => backToForm(pending, null)}
        />
      )}
      {pending && pending.kind !== 'form' && pending.kind !== 'save' && (
        <EcosystemActionDialog
          title={{
            enable: `Enable ${pending.rule.name}?`,
            disable: `Disable ${pending.rule.name}?`,
            approve: `Approve the change to ${pending.rule.name}?`,
            delete: `Delete ${pending.rule.name}?`,
          }[pending.kind]}
          action={{
            enable: 'Propose enabling this rule (a second approver confirms it)',
            disable: 'Disable this rule now; matching requests wait in the queue',
            approve: 'Approve the pending change as the second approver',
            delete: 'Delete this rule permanently',
          }[pending.kind]}
          stepUp
          onSubmit={(_r, token) => run(token)}
          onClose={close}
        />
      )}
    </SectionCard>
  );
}
