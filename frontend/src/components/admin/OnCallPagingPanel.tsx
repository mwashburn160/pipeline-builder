// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Would a support critical actually wake anyone?"
 *
 * WHY THIS PANEL EXISTS. Before it, answering that question meant shell access
 * to a running cluster and reading `.env`, two Secrets and four copies of
 * `alertmanager.yml` — and the answer was still a guess, because nothing
 * reported whether the rota had anybody on it. Every signal the paging feature
 * emits is a Prometheus series, which is the right home for a trend and the
 * wrong one for "is it configured right now, before I rely on it".
 *
 * THE HEADLINE IS THE PRODUCT. `wouldPage` is computed SERVER-SIDE and is the
 * only field worth acting on: paging can be declared on, with a provider
 * selected and an endpoint resolved, and still page nobody. Recomputing that
 * predicate here from the parts would let the UI drift from the real one, which
 * is how a dashboard ends up reassuring somebody about a system that is broken.
 *
 * NO CREDENTIAL EVER REACHES THIS COMPONENT. The endpoint reports presence as
 * booleans because a routing key and a webhook secret are bearer credentials —
 * anyone holding the key can raise incidents on the service. An API that read
 * them back would turn a read permission into a credential grant, so there is
 * deliberately nothing to reveal here and no `SecretReveal`.
 *
 * THE TEST BUTTON RINGS A PHONE. It is behind `can('oncall:manage')`, which is
 * system-org-only and in no built-in Role, and it reports `skipped` separately
 * from `sent`: paging being disabled returns HTTP 200, and showing that as
 * success would be the exact failure this whole feature is about — reporting
 * coverage that does not exist.
 */

import { useState } from 'react';
import { BellRing, Send, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { PostureHeadline } from '@/components/ui/PostureHeadline';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { RetryError } from '@/components/ui/RetryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { formatError } from '@/lib/constants';
import api from '@/lib/api';
import type { OnCallStatus } from '@/types/observability';

/** One presence row: a label, the env var behind it, and what it means when off. */
interface PostureRow {
  label: string;
  envVar: string;
  ok: boolean;
  /** Shown when `ok` is false — the CONSEQUENCE, not a restatement of the flag. */
  whenOff: string;
}

/**
 * Worst-signal-wins, computed here because `PostureHeadline` is presentation
 * only (its own module comment says so).
 *
 * THREE states and not two. "Paging works but nobody is rostered" is the most
 * dangerous configuration in this feature — the event is accepted, an incident
 * is created, and no phone rings — so it must not read the same as either a
 * healthy rota or a disabled pager.
 */
function headline(s: OnCallStatus): { tone: 'red' | 'yellow' | 'green'; Icon: typeof ShieldCheck; title: string; detail: string } {
  if (!s.wouldPage) {
    return {
      tone: 'red',
      Icon: ShieldX,
      title: 'Support criticals would not page anyone',
      detail: s.enabled
        ? 'Paging is enabled but not fully configured — a page would be attempted and fail.'
        : 'Paging is off. Support criticals still reach the ops Slack channel, and no phone rings.',
    };
  }
  if (!s.rotaReadable) {
    return {
      tone: 'yellow',
      Icon: ShieldAlert,
      title: 'Paging is configured; coverage is unknown',
      detail: 'The rota could not be read, so whether anyone is scheduled cannot be confirmed. Paging itself is unaffected.',
    };
  }
  if (s.rotaEntries === 0) {
    return {
      tone: 'yellow',
      Icon: ShieldAlert,
      title: 'Paging is configured, and nobody is on call',
      detail: `No on-call entries in the next ${s.lookaheadHours}h. A page would be accepted and create an incident that wakes no one.`,
    };
  }
  return {
    tone: 'green',
    Icon: ShieldCheck,
    title: 'Support criticals would page the on-call',
    detail: `${s.rotaEntries} on-call ${s.rotaEntries === 1 ? 'entry' : 'entries'} in the next ${s.lookaheadHours}h.`,
  };
}

function rowsFor(s: OnCallStatus): PostureRow[] {
  return [
    {
      label: 'Paging enabled',
      envVar: 'ONCALL_ENABLED',
      ok: s.enabled,
      whenOff: 'Opt-in, and it also requires SUPPORT_ENABLED — on-call pages about a support response target, so with support off there is nothing to page about.',
    },
    {
      label: 'Routing key present',
      envVar: 'PAGERDUTY_ROUTING_KEY',
      ok: s.routingKeyConfigured,
      whenOff: 'A per-service integration key, not a REST API key. Without it every page is logged as a failure and nobody is woken.',
    },
    {
      label: 'Events endpoint resolved',
      envVar: 'ONCALL_EVENTS_URL',
      ok: s.endpointConfigured,
      whenOff: 'ONCALL_PROVIDER=custom requires an explicit URL and does not fall back — falling back would send this deployment’s routing key to a provider nobody chose.',
    },
    {
      label: 'Acknowledgements verifiable',
      envVar: 'PAGERDUTY_WEBHOOK_SECRET',
      ok: s.ackWebhookConfigured,
      whenOff: 'The inbound webhook refuses every call without it (fail closed), so acknowledgements are never recorded and OnCallPageUnacknowledged fires on a healthy rota.',
    },
    {
      label: 'Rota readable',
      envVar: 'PAGERDUTY_API_TOKEN',
      ok: s.rotaReadable,
      whenOff: 'A REST token, account-wide and deliberately separate from the routing key. Without it a rota with nobody on it is invisible until 02:00.',
    },
  ];
}

export function OnCallPagingPanel({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const { data, loading, error, refetch } = useFetch(
    async (signal) => (await api.oncallStatus({ signal })).data,
    [],
  );

  const onTest = async () => {
    setTesting(true);
    try {
      const result = (await api.oncallTest()).data;
      // `skipped` is a 200 and NOT a success — paging is off, so nothing left
      // the building. Reporting it green is the one lie this panel must not tell.
      if (result?.skipped) toast.info('Paging is disabled — nothing was sent');
      else if (result?.sent) toast.success('Test page accepted by the provider (not proof a phone rang)');
      else toast.error(result?.error ?? 'The provider did not accept the test page');
    } catch (err) {
      toast.error(formatError(err, 'Could not send a test page'));
    } finally {
      setTesting(false);
      // The posture can change as a result — an empty routing key surfaces here.
      void refetch();
    }
  };

  const h = data ? headline(data) : null;

  return (
    <SectionCard
      title="On-call paging"
      description="Whether a support critical would wake a human, and a way to prove it without waiting for an incident."
      icon={BellRing}
      actions={canManage && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void onTest()}
          disabled={testing || loading}
          readOnly={!canManage}
          aria-label="Send a test page to the on-call"
          title="Sends a REAL page to whoever is on call right now"
          className="gap-1"
        >
          <Send className="w-3.5 h-3.5" /> {testing ? 'Sending…' : 'Send test page'}
        </Button>
      )}
    >
      {error && (
        <RetryError message={formatError(error, 'Failed to read the on-call posture')} onRetry={refetch} />
      )}

      {loading && !data && <Skeleton className="h-20" />}

      {data && h && (
        <>
          <PostureHeadline tone={h.tone} Icon={h.Icon} title={h.title} detail={h.detail} />

          <ul className="mt-4 divide-y divide-default">
            {rowsFor(data).map((row) => (
              <li key={row.envVar} className="py-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-sm font-medium text-fg">{row.label}</div>
                  <Badge color={row.ok ? 'green' : 'gray'}>{row.ok ? 'configured' : 'not set'}</Badge>
                </div>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-2 text-xs text-fg-muted">
                  <code className="bg-surface-muted px-1.5 py-0.5 rounded">{row.envVar}</code>
                  {!row.ok && <span>{row.whenOff}</span>}
                </div>
              </li>
            ))}
          </ul>

          <Callout variant="neutral" className="mt-4">
            Provider <code>{data.provider}</code>. These are deploy-time values — changing one means
            re-deploying with new env vars. Credentials are reported as present or absent only, never
            read back. See <code>docs/oncall-paging.md</code>.
          </Callout>
        </>
      )}
    </SectionCard>
  );
}
