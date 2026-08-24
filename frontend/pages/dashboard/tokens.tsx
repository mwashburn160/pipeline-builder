import { useEffect, useState, useCallback, useMemo } from 'react';
import { RefreshCw, ChevronRight, ShieldOff, KeyRound } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { SectionCard } from '@/components/ui/SectionCard';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { DescriptionList, type DescriptionItem } from '@/components/ui/DescriptionList';
import { SegmentedFilter } from '@/components/ui/SegmentedFilter';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { CopyButton } from '@/components/ui/CopyButton';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { DataTable, type Column } from '@/components/ui/DataTable';
import api from '@/lib/api';
import { PatSection } from '@/components/settings/PatSection';
import { decodeJwt, formatTimestamp, isExpired, expiresIn } from '@/lib/jwt';
import { redactString, redactDetails } from '@/lib/redact';

interface TokenHistoryEntry {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: 'active' | 'expired' | 'revoked';
}

// ---------------------------------------------------------------------------
// Token card
// ---------------------------------------------------------------------------

const KNOWN_TIME_FIELDS = new Set(['exp', 'iat', 'nbf']);
const FIELD_LABELS: Record<string, string> = {
  sub: 'Subject (User ID)',
  iss: 'Issuer',
  aud: 'Audience',
  exp: 'Expires At',
  iat: 'Issued At',
  nbf: 'Not Before',
  jti: 'Token ID',
  role: 'Role',
  email: 'Email',
  username: 'Username',
  organizationId: 'Organization ID',
  organizationName: 'Organization',
  tokenVersion: 'Token Version',
  type: 'Token Type',
};

/**
 * Displays a JWT token with decoded payload fields, expiry status, and raw/copy toggle.
 * @param title - Display label for the token card (e.g. "Access Token").
 * @param token - Raw JWT string, or null if unavailable.
 */
function TokenCard({ title, token }: { title: string; token: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const decoded = useMemo(() => (token ? decodeJwt(token) : null), [token]);

  if (!token) {
    return (
      <SectionCard title={title}>
        <p className="text-sm text-[var(--pb-text-muted)]">No token available</p>
      </SectionCard>
    );
  }

  const expired = decoded ? isExpired(decoded.payload) : false;
  const ttl = decoded ? expiresIn(decoded.payload) : null;

  const payloadItems: DescriptionItem[] = decoded
    ? Object.entries(decoded.payload).map(([key, value]) => {
      const label = FIELD_LABELS[key] || key;
      const isTime = KNOWN_TIME_FIELDS.has(key);
      const formattedTime = isTime ? formatTimestamp(value) : null;
      return {
        label: <span title={key}>{label}</span>,
        // Claim keys are kept as-is; claim VALUES can carry an account-id-shaped
        // token (e.g. an ARN in a custom claim), so redact id-shaped runs first.
        value: (
          <span className="font-mono text-xs leading-5">
            {formattedTime ? (
              <span>{formattedTime}<span className="ml-2 text-[var(--pb-text-muted)]">({String(value)})</span></span>
            ) : typeof value === 'object' ? (
              JSON.stringify(redactDetails(value))
            ) : (
              redactString(String(value))
            )}
          </span>
        ),
      };
    })
    : [];

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          {title}
          {decoded && (expired ? <Badge color="red">Expired</Badge> : <Badge color="green">Valid</Badge>)}
          {ttl && !expired && <Badge color="blue">{ttl}</Badge>}
        </span>
      }
      actions={
        <>
          <button onClick={() => setShowRaw(!showRaw)} className="action-link text-xs">
            {showRaw ? 'Decoded' : 'Raw'}
          </button>
          <CopyButton text={token} />
        </>
      }
    >
      {showRaw ? (
        <CodeBlock code={token} language="jwt" copyable={false} className="max-h-48 overflow-y-auto" />
      ) : decoded ? (
        <div className="space-y-4">
          <div>
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center text-xs font-semibold text-[var(--pb-text-muted)] uppercase tracking-wider hover:text-[var(--pb-text)] transition-colors"
            >
              <ChevronRight className={`w-3.5 h-3.5 mr-1 transition-transform ${expanded ? 'rotate-90' : ''}`} />
              Header
            </button>
            {expanded && <CodeBlock className="mt-2" language="json" copyable={false} code={JSON.stringify(decoded.header, null, 2)} />}
          </div>

          <div>
            <p className="text-xs font-semibold text-[var(--pb-text-muted)] uppercase tracking-wider mb-1">Payload</p>
            <DescriptionList items={payloadItems} />
          </div>
        </div>
      ) : (
        <p className="text-sm text-[var(--pb-danger)]">Failed to decode token</p>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** API token management page. Generates new access/refresh token pairs and displays decoded JWT details. */
export default function TokensPage() {
  const { user, isReady, isAuthenticated } = useAuthGuard();

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genSuccess, setGenSuccess] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const [history, setHistory] = useState<TokenHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeSuccess, setRevokeSuccess] = useState<string | null>(null);
  // "Sign out everywhere" kills every other session + all CLI/PAT tokens, so it's
  // gated behind a step-up password re-verify (not a bare window.confirm). The
  // step-up token is forwarded to the revoke-all endpoint, which requires it.
  const [pendingRevokeAll, setPendingRevokeAll] = useState(false);

  // Active sessions = tokens that the backend reports as 'active'. The
  // backend's status computation already accounts for revocation
  // (tokenVersion bumps) and expiry, so this is the authoritative count.
  const activeSessionCount = useMemo(
    () => history.filter((t) => t.status === 'active').length,
    [history],
  );

  // Client-side status facet over the already-loaded token history.
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'expired' | 'revoked'>('all');
  const filteredHistory = useMemo(
    () => (statusFilter === 'all' ? history : history.filter((t) => t.status === statusFilter)),
    [history, statusFilter],
  );

  const loadHistory = useCallback(async () => {
    try {
      const res = await api.listTokenHistory();
      setHistory(res.data?.tokens ?? []);
      setHistoryError(null);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load token history');
    }
  }, []);

  const syncTokens = useCallback(() => {
    setAccessToken(api.getAccessToken());
    setRefreshToken(api.getRefreshToken());
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      syncTokens();
      void loadHistory();
    }
  }, [isAuthenticated, syncTokens, loadHistory]);

  const handleGenerateToken = async () => {
    setGenerating(true);
    setGenError(null);
    setGenSuccess(null);

    try {
      await api.generateNewToken();
      syncTokens();
      void loadHistory();
      setGenSuccess('New token pair generated successfully. Your session tokens have been updated.');
    } catch (error) {
      setGenError(error instanceof Error ? error.message : 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  };

  const handleRevokeAll = async (stepUpToken: string) => {
    setRevoking(true);
    setRevokeError(null);
    setRevokeSuccess(null);
    try {
      await api.revokeAllTokens(stepUpToken);
      syncTokens();
      void loadHistory();
      setRevokeSuccess('All previously-issued tokens have been revoked. Your session has been refreshed with a new token.');
    } catch (error) {
      setRevokeError(error instanceof Error ? error.message : 'Failed to revoke tokens');
    } finally {
      setRevoking(false);
    }
  };

  const tokenHistoryColumns: Column<TokenHistoryEntry>[] = [
    { id: 'id', header: 'ID', cellClassName: 'font-mono text-xs text-[var(--pb-text-muted)]', render: (t) => t.id },
    { id: 'created', header: 'Created', cellClassName: 'text-[var(--pb-text)]', render: (t) => <RelativeTime value={t.createdAt} /> },
    { id: 'expires', header: 'Expires', cellClassName: 'text-[var(--pb-text)]', render: (t) => <RelativeTime value={t.expiresAt} /> },
    {
      id: 'status',
      header: 'Status',
      render: (t) => (
        <Badge color={t.status === 'active' ? 'green' : t.status === 'expired' ? 'gray' : 'red'}>{t.status}</Badge>
      ),
    },
  ];

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="API Tokens" subtitle="Create and revoke API tokens" maxWidth="4xl">
      <div className="space-y-6">
        <SectionCard
          icon={KeyRound}
          title="Generate new token"
          description="Generate a fresh access / refresh token pair. This replaces your current session tokens and can be used for CLI or API access."
        >
          <ErrorAlert message={genError} />
          <SuccessAlert message={genSuccess} />

          <Button onClick={handleGenerateToken} loading={generating} className={genError || genSuccess ? 'mt-4' : ''}>
            {generating ? 'Generating...' : <><RefreshCw className="w-4 h-4 mr-2" />Generate Token</>}
          </Button>
        </SectionCard>

        <PatSection />

        <TokenCard title="Access Token" token={accessToken} />
        <TokenCard title="Refresh Token" token={refreshToken} />

        {/* ─── Token history + sign-out-everywhere ─── */}
        <SectionCard
          title={
            <span className="inline-flex items-center gap-2">
              Active sessions &amp; recent tokens
              <Badge color={activeSessionCount > 0 ? 'green' : 'gray'}>{activeSessionCount} active</Badge>
            </span>
          }
          description="Last 20 access tokens issued for your account, with computed status. Each unexpired + unrevoked token is an active session. JWTs cannot be revoked individually — use “Sign out everywhere” to invalidate all of them at once."
          actions={
            <Button variant="danger" onClick={() => setPendingRevokeAll(true)} loading={revoking} className="flex-shrink-0">
              {revoking ? 'Revoking…' : <><ShieldOff className="w-4 h-4 mr-2" />Sign out everywhere</>}
            </Button>
          }
        >
          <ErrorAlert message={historyError} className="mb-3" />
          <ErrorAlert message={revokeError} className="mb-3" />
          <SuccessAlert message={revokeSuccess} className="mb-3" />

          {history.length === 0 ? (
            <p className="text-sm text-[var(--pb-text-muted)] italic">No tokens issued yet.</p>
          ) : (
            <>
              <SegmentedFilter
                className="mb-3 flex-wrap"
                ariaLabel="Filter tokens by status"
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: 'all', label: 'All', count: history.length },
                  { value: 'active', label: 'Active', count: history.filter((t) => t.status === 'active').length },
                  { value: 'expired', label: 'Expired', count: history.filter((t) => t.status === 'expired').length },
                  { value: 'revoked', label: 'Revoked', count: history.filter((t) => t.status === 'revoked').length },
                ]}
              />
              <DataTable
                data={filteredHistory}
                columns={tokenHistoryColumns}
                isLoading={false}
                animated={false}
                getRowKey={(t) => t.id}
                emptyState={{
                  icon: KeyRound,
                  title: statusFilter === 'all' ? 'No tokens' : `No ${statusFilter} tokens`,
                  description: 'No tokens match the selected status filter.',
                }}
              />
            </>
          )}
        </SectionCard>
      </div>

      {pendingRevokeAll && (
        <StepUpModal
          action="Sign out everywhere — revoke all other sessions, CLI tokens, and integrations (your current tab stays signed in with a fresh token)"
          onConfirmed={handleRevokeAll}
          onClose={() => setPendingRevokeAll(false)}
        />
      )}
    </DashboardLayout>
  );
}
