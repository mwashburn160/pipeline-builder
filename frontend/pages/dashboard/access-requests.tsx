// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Access requests — approve or deny requests to view an account, and end live
 * sessions.
 *
 * Open to every signed-in user. The person most often asked is the impersonated
 * user themselves, who is usually not an admin; what each person sees is filtered
 * server-side by the same rules that authorize deciding and revoking, so this page
 * never shows a request the viewer couldn't act on.
 *
 * Confirmation, and why it differs per action:
 *   - APPROVE asks for confirmation and restates exactly what is being granted.
 *     Consent that isn't informed isn't consent.
 *   - END SESSION asks once too — never with a step-up, so stopping access is
 *     never harder than allowing it (both are one confirm). Ending a session
 *     can't be undone: the operator needs a new request, and a new consent, to
 *     get back in, so a stray click must not do it.
 *   - DENY acts immediately: a pending request costs nobody anything to refuse.
 *
 * Each list is paged server-side (newest first), so a long history is reachable
 * page by page instead of silently truncated.
 */

import { useState } from 'react';
import { KeyRound, MonitorPlay, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Pagination } from '@/components/ui/Pagination';
import { RetryError } from '@/components/ui/RetryError';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { formatRelativeTime } from '@/lib/relative-time';
import type { ImpersonationListView, ImpersonationRequestDto } from '@/lib/api/domains/admin';

/** Session length, for the approval summary. Mirrors the platform's session TTL. */
const SESSION_MINUTES = 15;

/**
 * A 409 from decide/revoke means the request moved on without us — someone else
 * answered, the window closed, or the session already ended. Detected by STATUS,
 * not by matching the server's message text, which would break silently the
 * moment that wording changed.
 */
const isStale = (e: unknown) => e instanceof ApiError && e.statusCode === 409;

/** Plain-language request states for the requester. */
const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved — ready to open',
  denied: 'Denied',
  consumed: 'Opened',
  expired: 'Expired',
  revoked: 'Ended early',
  undeliverable: 'Nobody could be asked',
};

/** Rows per page for each list. */
const PAGE_SIZE = 10;

/**
 * One server-paged view of impersonation requests. Re-reads when the viewer's
 * identity or active org changes (what they may act on changes with it).
 */
function useRequestView(view: ImpersonationListView, enabled: boolean, identity: string) {
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const q = useFetch(
    async (signal) => {
      if (!enabled) return null;
      const res = await api.listImpersonationRequests(view, { limit, offset }, { signal });
      if (!res.success || !res.data) throw new Error(res.message || 'Could not load access requests');
      return res.data;
    },
    [enabled, identity, offset, limit],
  );
  return {
    requests: q.data?.requests ?? [],
    total: q.data?.pagination.total ?? 0,
    loading: q.loading && !q.data,
    error: q.error,
    refetch: q.refetch,
    pager: { limit, offset, setOffset, setLimit: (n: number) => { setLimit(n); setOffset(0); } },
  };
}

type RequestView = ReturnType<typeof useRequestView>;

/** Pager under a list — only when there is more than one page. */
function ViewPager({ view }: { view: RequestView }) {
  if (view.total <= view.pager.limit) return null;
  return (
    <Pagination
      pagination={{ limit: view.pager.limit, offset: view.pager.offset, total: view.total }}
      onPageChange={view.pager.setOffset}
      onPageSizeChange={view.pager.setLimit}
      pageSizeOptions={[10, 25, 50, 100]}
    />
  );
}

export default function AccessRequestsPage() {
  const { isReady, user, isReadOnly } = useAuthGuard();
  const toast = useToast();

  const enabled = isReady && !!user;
  const identity = `${user?.id ?? ''}:${user?.organizationId ?? ''}`;
  const toDecideView = useRequestView('to-decide', enabled, identity);
  const sessionsView = useRequestView('sessions', enabled, identity);
  const mineView = useRequestView('mine', enabled, identity);
  const toDecide = toDecideView.requests;
  const sessions = sessionsView.requests;
  const mine = mineView.requests;
  const loadError = toDecideView.error ?? sessionsView.error ?? mineView.error;

  const [redeeming, setRedeeming] = useState<ImpersonationRequestDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ImpersonationRequestDto | null>(null);
  const [ending, setEnding] = useState<ImpersonationRequestDto | null>(null);

  const load = () => {
    toDecideView.refetch();
    sessionsView.refetch();
    mineView.refetch();
  };

  const decide = async (req: ImpersonationRequestDto, approve: boolean) => {
    setBusyId(req.id);
    try {
      await api.decideImpersonationRequest(req.id, approve);
      toast.success(approve ? 'Request approved' : 'Request denied');
    } catch (e) {
      // 409: someone else answered first, or the window closed. Under admin
      // fan-out every admin holds the same prompt — say so plainly, then refresh
      // rather than leaving a stale row that looks actionable.
      if (isStale(e)) {
        toast.info('This request was already answered or has expired.');
      } else {
        setError(formatError(e));
      }
    } finally {
      setBusyId(null);
      setConfirming(null);
      load();
    }
  };

  const revoke = async (session: ImpersonationRequestDto) => {
    setBusyId(session.id);
    try {
      const res = await api.revokeImpersonationSession(session.id);
      if (res.success && res.data?.revokedEverywhere === false) {
        // Don't claim it's over when it isn't: the platform refuses the token, but
        // other services couldn't be told and may accept it until it expires.
        toast.warning(`Session ended here, but it may keep working in other services for up to ${SESSION_MINUTES} minutes.`);
      } else {
        toast.success('Session ended');
      }
    } catch (e) {
      if (isStale(e)) {
        toast.info('That session had already ended.');
      } else {
        setError(formatError(e));
      }
    } finally {
      setBusyId(null);
      setEnding(null);
      load();
    }
  };

  /** Open an approved request. Step-up gated server-side: it mints the token. */
  const redeem = async (req: ImpersonationRequestDto, stepUpToken: string) => {
    try {
      const res = await api.redeemImpersonationRequest(req.id, stepUpToken);
      if (res.success && res.data?.accessToken) {
        api.startImpersonation(res.data.accessToken, res.data.requestId);
        window.location.href = '/dashboard';
        return;
      }
      setError(res.message || 'Could not open the session');
    } catch (e) {
      if (isStale(e)) toast.info('That request can no longer be opened. It may have expired.');
      else setError(formatError(e));
      load();
    } finally {
      setRedeeming(null);
    }
  };

  if (!isReady || !user) return <LoadingPage />;

  const isYou = (id: string) => id === user.id;
  const who = (p: { id: string; name: string }) => (isYou(p.id) ? 'you' : p.name);

  return (
    <DashboardLayout
      title="Access requests"
      subtitle="Who has asked to view an account, and who is viewing one now"
      actions={
        <Button type="button" variant="secondary" onClick={load} disabled={toDecideView.loading || sessionsView.loading}>
          <RefreshCw className="w-4 h-4 mr-1.5" /> Refresh
        </Button>
      }
    >
      <div className="space-y-6">
        {error && <ErrorAlert message={error} />}
        {loadError && <RetryError message={formatError(loadError, 'Could not load access requests')} onRetry={load} />}

        <ReadOnlyNotice show={isReadOnly} />

        <SectionCard
          icon={KeyRound}
          title="Waiting for your decision"
          description={`Approving lets the requester see that account, read-only, for ${SESSION_MINUTES} minutes.`}
          actions={toDecideView.total > 0 ? <Badge color="yellow">{toDecideView.total} pending</Badge> : undefined}
        >
          {toDecideView.loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-[var(--pb-text-muted)]">
              <LoadingSpinner size="sm" /> Loading…
            </div>
          ) : toDecide.length === 0 ? (
            <p className="py-2 text-sm text-[var(--pb-text-muted)]">Nothing is waiting for you.</p>
          ) : (
            <ul className="space-y-3">
              {toDecide.map((r) => (
                <li key={r.id} className="rounded-lg border border-[var(--pb-border)] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm">
                        <span className="font-medium">{who(r.requester)}</span>
                        {' wants to view '}
                        <span className="font-medium">{isYou(r.target.id) ? 'your account' : `${r.target.name}'s account`}</span>
                      </p>
                      {r.breakglass && (
                        <Badge color="red">
                          <ShieldAlert className="w-3 h-3 mr-1 inline" />
                          Emergency access — you are the second administrator
                        </Badge>
                      )}
                      {/* Operator-written: React renders it as text, never markup. */}
                      <p className="text-sm text-[var(--pb-text-muted)] break-words">
                        {r.reason ? <>Reason: &ldquo;{r.reason}&rdquo;</> : 'No reason given.'}
                      </p>
                      <p className="text-xs text-[var(--pb-text-muted)]">
                        Asked {formatRelativeTime(r.createdAt)} · expires {formatRelativeTime(r.expiresAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        readOnly={isReadOnly}
                        disabled={busyId === r.id}
                        onClick={() => setConfirming(r)}
                      >
                        Approve
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        readOnly={isReadOnly}
                        disabled={busyId === r.id}
                        onClick={() => void decide(r, false)}
                      >
                        Deny
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <ViewPager view={toDecideView} />
        </SectionCard>

        <SectionCard
          icon={MonitorPlay}
          title="Live sessions"
          description="Read-only sessions in progress that you can end. Ending one takes effect on its next request."
        >
          {sessionsView.loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-[var(--pb-text-muted)]">
              <LoadingSpinner size="sm" /> Loading…
            </div>
          ) : sessions.length === 0 ? (
            <p className="py-2 text-sm text-[var(--pb-text-muted)]">No one is viewing an account right now.</p>
          ) : (
            <ul className="space-y-2">
              {sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--pb-border)] p-2.5">
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span className="font-medium">{who(s.requester)}</span>
                      {' is viewing '}
                      <span className="font-medium">{isYou(s.target.id) ? 'your account' : `${s.target.name}'s account`}</span>
                      {s.breakglass && <Badge color="red" className="ml-2">Emergency</Badge>}
                    </p>
                    {s.consumedAt && (
                      <p className="text-xs text-[var(--pb-text-muted)]">Started {formatRelativeTime(s.consumedAt)}</p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    readOnly={isReadOnly}
                    disabled={busyId === s.id}
                    onClick={() => setEnding(s)}
                  >
                    End session
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <ViewPager view={sessionsView} />
        </SectionCard>
        {/* Only people who ask for access have requests of their own — most
            users never will, so the section is hidden rather than empty. */}
        {!mineView.loading && mineView.total > 0 && (
          <SectionCard
            icon={Send}
            title="Your requests"
            description="Requests you've made to view an account. Open an approved one within an hour of approval."
          >
            <ul className="space-y-2">
              {mine.map((r) => {
                const openable = r.status === 'approved' && new Date(r.expiresAt).getTime() > Date.now();
                return (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--pb-border)] p-2.5">
                    <div className="min-w-0">
                      <p className="text-sm">
                        <span className="font-medium">{r.target.name}</span>
                        {r.breakglass && <Badge color="red" className="ml-2">Emergency</Badge>}
                      </p>
                      <p className="text-xs text-[var(--pb-text-muted)]">
                        {STATUS_LABEL[r.status] ?? r.status} · asked {formatRelativeTime(r.createdAt)}
                      </p>
                    </div>
                    {openable && (
                      <Button type="button" readOnly={isReadOnly} onClick={() => setRedeeming(r)}>
                        Open session
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            <ViewPager view={mineView} />
          </SectionCard>
        )}
      </div>

      {redeeming && (
        <StepUpModal
          action={`Open a read-only session as ${redeeming.target.name}`}
          /* Backed by a route that accepts only a SECOND FACTOR (#8) — a
             passkey or an authenticator code. A password re-prompt proves
             nothing an attacker holding this session doesn't already have. */
          requireStrongFactor
          onConfirmed={(token) => redeem(redeeming, token)}
          onClose={() => setRedeeming(null)}
        />
      )}

      {ending && (
        <ConfirmDialog
          title="End this session?"
          confirmLabel="End session"
          tone="danger"
          loading={busyId === ending.id}
          onCancel={() => setEnding(null)}
          onConfirm={() => void revoke(ending)}
        >
          <p>
            <strong>{who(ending.requester)}</strong> stops seeing{' '}
            <strong>{isYou(ending.target.id) ? 'your account' : `${ending.target.name}'s account`}</strong>{' '}
            on their next request.
          </p>
          <p>This can&apos;t be undone — to look again they must ask again, and be approved again.</p>
        </ConfirmDialog>
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming.breakglass ? 'Approve emergency access?' : 'Approve access?'}
          confirmLabel="Approve"
          tone={confirming.breakglass ? 'danger' : 'primary'}
          loading={busyId === confirming.id}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void decide(confirming, true)}
        >
          {/* Restate exactly what is being granted — who, whose account, for how
              long, what they can't do, and that it can be stopped. */}
          <div className="space-y-2 text-sm">
            <p>
              <strong>{who(confirming.requester)}</strong> will be able to see{' '}
              <strong>{isYou(confirming.target.id) ? 'your account' : `${confirming.target.name}'s account`}</strong>{' '}
              exactly as it appears, for up to {SESSION_MINUTES} minutes.
            </p>
            <p>It&apos;s view-only: nothing can be changed. You can end the session at any time from this page.</p>
            {confirming.breakglass && (
              <p className="text-[var(--pb-danger)]">
                This bypasses the organization&apos;s impersonation policy. You are approving as the second administrator.
              </p>
            )}
          </div>
        </ConfirmDialog>
      )}
    </DashboardLayout>
  );
}
