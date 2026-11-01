// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { LifeBuoy, Trash2 } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { responseTargetLabel } from '@/components/message/MessageList';
import type { SupportContactDto, SupportContactsDto } from '@/lib/api/domains/organizations';
import type { OrganizationMember } from '@/types';

/** The label a level gets in this card. */
const LEVEL_NAMES: Readonly<Record<string, string>> = {
  support_standard: 'Standard Support',
  support_priority: 'Priority Support',
  support_premium: 'Premium Support',
};

/**
 * Who in this organization may raise and own a support case.
 *
 * WITHOUT THIS CARD THE ADD-ON IS INERT. A case can only be opened by a
 * designated contact (`canOpenCase` is `ownOrgContacts > 0`), so an org that
 * buys support but designates nobody has every support send land as a plain
 * message with no case number, no response target and no place in the queue —
 * silently, because the send still succeeds.
 *
 * TWO SCOPES, and the card has to say which is which or the numbers look wrong:
 *
 *  - The ALLOWANCE pools across the whole account, like seats. "4 of 5 used"
 *    counts contacts in sibling teams the admin may not even be able to see, so
 *    it is labelled as the account's figure. Otherwise an admin looking at two
 *    local contacts and a cap of five cannot understand why the third is
 *    refused.
 *  - OWNERSHIP is own-org. The list below is this org's contacts only, and
 *    removing one here never touches a sibling's.
 *
 * Gated at the backend on `org:settings` plus tenancy; `readOnly` mirrors the
 * other settings cards, showing everything disabled for a read-only
 * impersonation session rather than hiding the state under investigation.
 */
export function SupportContactSettings({ orgId, readOnly = false }: { orgId: string; readOnly?: boolean }) {
  const toast = useToast();
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Contacts + the account allowance, and the roster to nominate from. Read
  // together because the picker is unusable without both: it has to exclude
  // people who are already contacts.
  const read = useFetch(
    async (signal): Promise<{ support: SupportContactsDto | null; members: OrganizationMember[] }> => {
      const [s, m] = await Promise.all([
        api.listSupportContacts(orgId, { signal }),
        api.getOrganizationMembers(orgId, { limit: 200 }, { signal }),
      ]);
      return { support: s.data ?? null, members: m.data?.members ?? [] };
    },
    [orgId],
  );

  const support = read.data?.support;
  const contacts = support?.contacts ?? [];
  const designated = new Set(contacts.map((c) => c.userId));
  // Active members who are not already contacts. An inactive member cannot be
  // designated — the server refuses it — so offering them would only ever
  // produce a failed write.
  const candidates = (read.data?.members ?? []).filter((m) => m.isActive && !designated.has(m.id));

  // `message` is where a refusal arrives, NOT `error` -- the API's failure shape
  // has no `error` field at all. An earlier version of this signature declared
  // one, which typechecked and then silently swallowed every server message in
  // favour of the generic fallback, defeating the whole point of the comment
  // below.
  const run = async (label: string, fn: () => Promise<{ success: boolean; message?: string }>) => {
    setBusy(label);
    setError('');
    try {
      const res = await fn();
      // The server's own message is the useful one here: "no support add-on"
      // and "all contacts are in use" are different problems with different
      // fixes, and an admin who cannot tell them apart buys the wrong thing.
      if (!res.success) {
        setError(res.message ?? 'That change was not applied');
      } else {
        toast.success(res.message ?? 'Saved');
        setPick('');
        await read.refetch();
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = (c: SupportContactDto) => run(c.userId, async () => {
    const res = await api.removeSupportContact(orgId, c.userId);
    const open = res.data?.openCases ?? [];
    // Revoking is deliberately not blocked on open cases — refusing to remove a
    // departed employee because they still own cases would be worse than
    // handing the cases on — so the orphans are surfaced instead of swallowed.
    if (res.success && open.length) {
      toast.warning(
        `${open.length} open case(s) still name that contact: ${open.map((o) => `#${o.displayNumber}`).join(', ')}. Hand them to someone else from the case view.`,
      );
    }
    return res;
  });

  return (
    <SectionCard title="Support contacts" icon={LifeBuoy}>
      {read.loading && <LoadingSpinner />}
      {read.error && <RetryError message="Support contacts could not be loaded" onRetry={read.refetch} />}

      {!read.loading && !read.error && support && (
        <div className="space-y-3">
          {/* No add-on at all: say what to buy rather than showing an empty
              list that looks like a configuration mistake. */}
          {!support.level ? (
            <Callout variant="info">
              This account has no support add-on, so support messages reach us but do not open a tracked
              case with a response target. Support is sold per contact on every plan — see Billing.
            </Callout>
          ) : (
            <>
              <p className="text-sm text-fg-muted">
                {LEVEL_NAMES[support.level] ?? support.level}
                {responseTargetLabel(support.level) ? ` — first response within ${responseTargetLabel(support.level)}.` : '.'}
                {' '}
                Only a designated contact can open a case and be its owner.
              </p>

              {/* The POOLED figure, labelled as the account's. Unlimited prints
                  no fraction at all rather than "4 of -1". */}
              <p className="text-xs text-fg-muted">
                {support.limit < 0
                  ? `${support.used} designated across this account (no limit).`
                  : `${support.used} of ${support.limit} contacts used across this account — the allowance is shared by every team under it, like seats.`}
              </p>

              {/* The premium UPGRADE allowance, stated separately because it is a
                  separate cap: the account holds N contacts and upgrades M of
                  them. Without this an admin at the upgrade cap sees a refusal
                  with no number behind it. */}
              {support.premium && (
                <p className="text-xs text-fg-muted">
                  {support.premiumLimit < 0
                    ? `${support.premiumUsed} contact(s) upgraded to 24×7 (no limit).`
                    : `${support.premiumUsed} of ${support.premiumLimit} 24×7 upgrade(s) used across this account. An upgraded contact gets a first response within 8 hours any day, and is the only one who may raise an urgent case.`}
                </p>
              )}

              {error && <ErrorAlert message={error} />}

              {contacts.length === 0 ? (
                <EmptyState
                  title="Nobody is designated here"
                  description="Until somebody is, support messages from this organization open no case and carry no response target."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {contacts.map((c) => (
                    <li key={c.userId} className="flex items-center gap-3 py-2 text-sm">
                      <span className="font-medium">{c.username ?? '(account removed)'}</span>
                      <span className="text-fg-muted">{c.email ?? ''}</span>
                      {c.isPremium && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-info-bg text-info">24×7</span>
                      )}

                      {/* The upgrade toggle, shown only when the account HOLDS
                          the upgrade — an org with no premium add-on would
                          otherwise see a control that can only fail. Downgrading
                          is always offered, because an account whose add-on
                          lapsed still has to be able to tidy up contacts that
                          are still marked upgraded. */}
                      {support.premium && (c.isPremium || support.canUpgrade) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="ml-auto"
                          loading={busy === `level:${c.userId}`}
                          readOnly={readOnly}
                          onClick={() => run(
                            `level:${c.userId}`,
                            () => api.setSupportContactLevel(orgId, c.userId, !c.isPremium),
                          )}
                        >
                          {c.isPremium ? 'Remove 24×7' : 'Upgrade to 24×7'}
                        </Button>
                      )}

                      <Button
                        variant="secondary"
                        size="sm"
                        className={support.premium && (c.isPremium || support.canUpgrade) ? '' : 'ml-auto'}
                        loading={busy === c.userId}
                        readOnly={readOnly}
                        onClick={() => remove(c)}
                        aria-label={`Remove ${c.username ?? c.userId} as a support contact`}
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {/* At the cap: explain rather than show a control that always
                  fails. The cap is the ACCOUNT's, so the fix may be in another
                  team entirely — which is why the message says so. */}
              {!support.canDesignate && support.limit >= 0 ? (
                <Callout variant="warning">
                  Every support contact in this account is in use. Remove one here or in another team, or
                  add contacts in Billing.
                </Callout>
              ) : candidates.length === 0 ? (
                <p className="text-xs text-fg-muted">
                  Every active member of this organization is already a support contact.
                </p>
              ) : (
                <div className="flex items-end gap-2">
                  <label className="flex flex-col gap-1 flex-1">
                    <span className="text-xs text-fg-muted">Add a contact</span>
                    <Select
                      value={pick}
                      onChange={(e) => setPick(e.target.value)}
                      disabled={readOnly || busy !== null}
                      aria-label="Member to designate as a support contact"
                    >
                      <option value="">Choose a member…</option>
                      {candidates.map((m) => (
                        <option key={m.id} value={m.id}>{m.username} — {m.email}</option>
                      ))}
                    </Select>
                  </label>
                  <Button
                    disabled={!pick}
                    loading={busy === 'add'}
                    readOnly={readOnly}
                    onClick={() => run('add', () => api.addSupportContact(orgId, pick))}
                  >
                    Add
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
}
