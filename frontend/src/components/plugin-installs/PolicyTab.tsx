// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Select } from '@/components/ui/Select';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { clearPluginCache } from '@/hooks/usePlugins';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import {
  addBlockedListing, diffPolicy, parseListingRef, policyWarnings, PUBLISHER_TIER_LABELS, PUBLISHER_TIERS,
  removeBlockedListing, toggleTier, type TierListKey,
} from '@/lib/plugin-installs';
import type { ConsumptionPolicy, InstallPolicyResponse } from '@/types/plugin-installs';

const TIER_LISTS: Array<{ key: TierListKey; label: string; hint: string }> = [
  { key: 'allowedTiers', label: 'Allowed publisher tiers', hint: 'Pipelines may use listings only from these tiers; others are blocked.' },
  { key: 'requireApprovalTiers', label: 'Tiers that need approval to install', hint: 'For allowed tiers: a member’s install becomes a request an approver decides.' },
  { key: 'secretsAllowedTiers', label: 'Tiers that may receive secrets', hint: 'Other tiers get no secrets, even if the plugin declares them.' },
];

/**
 * The org's plugin CONSUMPTION policy (§3.2): which publisher tiers pipelines
 * may use, which need approval, which get secrets, the advisory block, whether
 * Official plugins are installed implicitly (D16), and blocked listings.
 * Org-local — it never affects the ecosystem. Editing needs
 * `plugin_installs:manage` and a step-up; a team's policy is merged with its
 * root org's and can only be stricter.
 */
export function PolicyTab({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const read = useFetch(async (signal): Promise<InstallPolicyResponse | null> =>
    (await api.getInstallPolicy({ signal })).data ?? null, []);
  const data = read.data;
  const [draft, setDraft] = useState<ConsumptionPolicy | null>(null);
  const [blockInput, setBlockInput] = useState('');
  const [blockError, setBlockError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => { if (data) setDraft(data.policy); }, [data]);

  const readOnly = !canManage || !data?.canEdit;
  const changes = useMemo(() => (data && draft ? diffPolicy(data.policy, draft) : {}), [data, draft]);
  const dirty = Object.keys(changes).length > 0;
  const warnings = useMemo(() => (draft ? policyWarnings(draft) : []), [draft]);

  const save = async (stepUpToken: string) => {
    try {
      const res = await api.updateInstallPolicy(changes, stepUpToken);
      if (res.data) setDraft(res.data.policy);
      toast.success('Plugin consumption policy saved');
      clearPluginCache();
      setError(null);
      read.refetch();
    } catch (e) {
      setError(formatError(e, 'Could not save the policy'));
    } finally {
      setConfirming(false);
    }
  };

  const addBlocked = () => {
    const ref = parseListingRef(blockInput);
    if (!ref) { setBlockError('Enter a listing as publisher/name, e.g. acme/terraform-plan.'); return; }
    setBlockError(null);
    setDraft((d) => (d ? { ...d, blockedListings: addBlockedListing(d.blockedListings, ref) } : d));
    setBlockInput('');
  };

  if (read.error && !data) {
    return <RetryError message={formatError(read.error, 'Could not load the plugin policy')} onRetry={read.refetch} />;
  }
  if (!data || !draft) {
    return <div className="flex items-center gap-2 py-6 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading the policy…</div>;
  }

  return (
    <div className="space-y-4" data-testid="policy-tab">
      {error && <ErrorAlert message={error} onDismiss={() => setError(null)} />}
      {data.inheritsFromRoot && (
        <Callout variant="neutral" title="Inherited from your root organization">
          Your root organization&apos;s policy applies here too. Settings below can only make it stricter; the policy in force is summarized at the bottom.
        </Callout>
      )}
      {readOnly && (
        <Callout variant="info">
          {canManage ? 'This policy is managed elsewhere.' : 'Only members with the Manage plugin installs permission can change this policy.'}
        </Callout>
      )}

      <SectionCard icon={ShieldCheck} title="Plugin consumption policy" description="Decides what this organization’s pipelines may use. It never affects other organizations.">
        <div className="space-y-5">
          {TIER_LISTS.map(({ key, label, hint }) => (
            <fieldset key={key} className="space-y-2">
              <legend className="text-sm font-medium text-fg">{label}</legend>
              <p className="text-xs text-fg-muted">{hint}</p>
              <div className="flex flex-wrap gap-4">
                {PUBLISHER_TIERS.map((tier) => (
                  <label key={tier} className="flex items-center gap-2 text-sm text-fg">
                    <Checkbox
                      checked={draft[key].includes(tier)}
                      disabled={readOnly}
                      aria-label={`${label}: ${PUBLISHER_TIER_LABELS[tier]}`}
                      onChange={(e) => setDraft({ ...draft, [key]: toggleTier(draft[key], tier, e.target.checked) })}
                    />
                    {PUBLISHER_TIER_LABELS[tier]}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}

          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Block on security advisory" hint="Listings with an active advisory at or above this severity stop resolving.">
              <Select
                aria-label="Block on security advisory"
                value={draft.blockOnAdvisory}
                disabled={readOnly}
                onChange={(e) => setDraft({ ...draft, blockOnAdvisory: e.target.value as ConsumptionPolicy['blockOnAdvisory'] })}
              >
                <option value="critical">Critical advisories</option>
                <option value="high">High or critical advisories</option>
                <option value="never">Never block</option>
              </Select>
            </FormField>
            <FormField label="Official plugins" hint="Implicit: every Official plugin is available without installing it.">
              <Select
                aria-label="Official plugins"
                value={draft.officialInstalls}
                disabled={readOnly}
                onChange={(e) => setDraft({ ...draft, officialInstalls: e.target.value as ConsumptionPolicy['officialInstalls'] })}
              >
                <option value="implicit">Installed automatically</option>
                <option value="explicit">Must be installed deliberately</option>
              </Select>
            </FormField>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-fg">Blocked listings</legend>
            <p className="text-xs text-fg-muted">Blocked listings don&apos;t resolve for this organization&apos;s pipelines, including Official ones, and can&apos;t be installed.</p>
            {draft.blockedListings.length === 0 ? (
              <p className="text-sm text-fg-subtle">None.</p>
            ) : (
              <ul className="flex flex-wrap gap-2" aria-label="Blocked listings">
                {draft.blockedListings.map((l) => (
                  <li key={`${l.publisher}/${l.name}`} className="inline-flex items-center gap-1 rounded-full border border-default bg-surface-muted px-2 py-0.5 font-mono text-xs text-fg">
                    {l.publisher}/{l.name}
                    {!readOnly && (
                      <button
                        type="button"
                        aria-label={`Unblock ${l.publisher}/${l.name}`}
                        className="rounded p-0.5 text-fg-subtle hover:text-fg"
                        onClick={() => setDraft({ ...draft, blockedListings: removeBlockedListing(draft.blockedListings, l) })}
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <div className="flex max-w-md items-start gap-2">
                <Input
                  aria-label="Block a listing"
                  placeholder="publisher/name"
                  value={blockInput}
                  onChange={(e) => setBlockInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBlocked(); } }}
                />
                <Button variant="secondary" onClick={addBlocked} disabled={!blockInput.trim()}>Block</Button>
              </div>
            )}
            {blockError && <p className="text-xs text-danger-strong">{blockError}</p>}
          </fieldset>

          {warnings.length > 0 && (
            <Callout variant="warning" title="Check before saving">
              <ul className="list-disc space-y-1 pl-4">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </Callout>
          )}

          {!readOnly && (
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" disabled={!dirty} onClick={() => setDraft(data.policy)}>Discard changes</Button>
              <Button disabled={!dirty} onClick={() => setConfirming(true)}>Save policy</Button>
            </div>
          )}
          {data.updatedAt && (
            <p className="text-xs text-fg-subtle">
              Last changed <RelativeTime value={data.updatedAt} />{data.updatedBy ? ` by ${data.updatedBy}` : ''}.
            </p>
          )}
        </div>
      </SectionCard>

      {data.inheritsFromRoot && <EffectivePolicy policy={data.effective} />}

      {confirming && (
        <StepUpModal
          title="Save the plugin consumption policy?"
          action="Change which plugins this organization's pipelines may use"
          details={<p>The new policy applies to every synth from now on, including pipelines already deployed when they next synthesize.</p>}
          onConfirmed={save}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/** The policy in force after team inheritance (read-only summary). */
function EffectivePolicy({ policy }: { policy: ConsumptionPolicy }) {
  const tiers = (list: ConsumptionPolicy['allowedTiers']) => (list.length ? list.map((t) => PUBLISHER_TIER_LABELS[t]).join(', ') : 'none');
  return (
    <SectionCard title="In force for this team" description="Your root organization’s policy merged with this team’s — the stricter setting wins.">
      <dl className="grid gap-2 text-sm md:grid-cols-2" data-testid="effective-policy">
        <div><dt className="text-fg-muted">Allowed tiers</dt><dd className="text-fg">{tiers(policy.allowedTiers)}</dd></div>
        <div><dt className="text-fg-muted">Need approval</dt><dd className="text-fg">{tiers(policy.requireApprovalTiers)}</dd></div>
        <div><dt className="text-fg-muted">May receive secrets</dt><dd className="text-fg">{tiers(policy.secretsAllowedTiers)}</dd></div>
        <div><dt className="text-fg-muted">Block on advisory</dt><dd className="text-fg">{policy.blockOnAdvisory}</dd></div>
        <div><dt className="text-fg-muted">Official plugins</dt><dd className="text-fg">{policy.officialInstalls === 'implicit' ? 'Installed automatically' : 'Must be installed'}</dd></div>
        <div><dt className="text-fg-muted">Blocked listings</dt><dd className="font-mono text-fg">{policy.blockedListings.map((l) => `${l.publisher}/${l.name}`).join(', ') || 'none'}</dd></div>
      </dl>
    </SectionCard>
  );
}
