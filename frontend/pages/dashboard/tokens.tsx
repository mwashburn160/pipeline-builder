import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw, ChevronRight, ShieldOff } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { CopyButton } from '@/components/ui/CopyButton';
import api from '@/lib/api';
import { decodeJwt, formatTimestamp, isExpired, expiresIn } from '@/lib/jwt';

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
      <div className="card">
        <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">{title}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">No token available</p>
      </div>
    );
  }

  const expired = decoded ? isExpired(decoded.payload) : false;
  const ttl = decoded ? expiresIn(decoded.payload) : null;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">{title}</h2>
          {decoded && (
            expired
              ? <Badge color="red">Expired</Badge>
              : <Badge color="green">Valid</Badge>
          )}
          {ttl && !expired && <Badge color="blue">{ttl}</Badge>}
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="action-link text-xs"
          >
            {showRaw ? 'Decoded' : 'Raw'}
          </button>
          <CopyButton text={token} />
        </div>
      </div>

      {showRaw ? (
        <pre className="card p-4 text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
          {token}
        </pre>
      ) : decoded ? (
        <div className="space-y-4">
          <div>
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              <ChevronRight className={`w-3.5 h-3.5 mr-1 transition-transform ${expanded ? 'rotate-90' : ''}`} />
              Header
            </button>
            {expanded && (
              <pre className="card mt-2 p-3 text-xs font-mono text-gray-600 dark:text-gray-400">
                {JSON.stringify(decoded.header, null, 2)}
              </pre>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Payload</p>
            <div className="card p-0 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
              {Object.entries(decoded.payload).map(([key, value]) => {
                const label = FIELD_LABELS[key] || key;
                const isTime = KNOWN_TIME_FIELDS.has(key);
                const formattedTime = isTime ? formatTimestamp(value) : null;

                return (
                  <div key={key} className="flex items-start px-4 py-2.5 text-sm">
                    <span className="w-44 shrink-0 font-medium text-gray-500 dark:text-gray-400 truncate" title={key}>
                      {label}
                    </span>
                    <span className="text-gray-900 dark:text-gray-200 break-all font-mono text-xs leading-5">
                      {formattedTime ? (
                        <span>
                          {formattedTime}
                          <span className="ml-2 text-gray-400 dark:text-gray-500">({String(value)})</span>
                        </span>
                      ) : typeof value === 'object' ? (
                        JSON.stringify(value)
                      ) : (
                        String(value)
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-red-600 dark:text-red-400">Failed to decode token</p>
      )}
    </div>
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

  const handleRevokeAll = async () => {
    if (!window.confirm('Sign out of every session everywhere? Your current tab will stay logged in with a fresh token, but all other sessions, CLI tokens, and integrations will need to re-authenticate.')) return;
    setRevoking(true);
    setRevokeError(null);
    setRevokeSuccess(null);
    try {
      await api.revokeAllTokens();
      syncTokens();
      void loadHistory();
      setRevokeSuccess('All previously-issued tokens have been revoked. Your session has been refreshed with a new token.');
    } catch (error) {
      setRevokeError(error instanceof Error ? error.message : 'Failed to revoke tokens');
    } finally {
      setRevoking(false);
    }
  };

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="API Tokens" subtitle="Create and revoke API tokens" maxWidth="4xl">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="card mb-6"
      >
        <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Generate New Token</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Generate a fresh access / refresh token pair. This replaces your current session tokens and
          can be used for CLI or API access.
        </p>

        {genError && (
          <div className="alert-error"><p>{genError}</p></div>
        )}
        {genSuccess && (
          <div className="alert-success"><p>{genSuccess}</p></div>
        )}

        <button onClick={handleGenerateToken} disabled={generating} className="btn btn-primary">
          {generating ? <LoadingSpinner size="sm" className="mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          {generating ? 'Generating...' : 'Generate Token'}
        </button>
      </motion.div>

      <div className="space-y-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.1 }}>
          <TokenCard title="Access Token" token={accessToken} />
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.2 }}>
          <TokenCard title="Refresh Token" token={refreshToken} />
        </motion.div>

        {/* ─── Token history + sign-out-everywhere ─── */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.3 }} className="card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Recent token issuance</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Last 20 access tokens issued for your account, with computed status. JWTs cannot be revoked individually — use &ldquo;Sign out everywhere&rdquo; to invalidate all of them at once.
              </p>
            </div>
            <button
              onClick={handleRevokeAll}
              disabled={revoking}
              className="btn btn-danger flex-shrink-0"
            >
              {revoking ? <LoadingSpinner size="sm" className="mr-2" /> : <ShieldOff className="w-4 h-4 mr-2" />}
              {revoking ? 'Revoking…' : 'Sign out everywhere'}
            </button>
          </div>

          {historyError && <div className="alert-error mb-3"><p>{historyError}</p></div>}
          {revokeError && <div className="alert-error mb-3"><p>{revokeError}</p></div>}
          {revokeSuccess && <div className="alert-success mb-3"><p>{revokeSuccess}</p></div>}

          {history.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 italic">No tokens issued yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <th className="py-2 pr-4">ID</th>
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2 pr-4">Expires</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((t) => (
                  <tr key={t.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs text-gray-500 dark:text-gray-500">{t.id}</td>
                    <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{new Date(t.createdAt).toLocaleString()}</td>
                    <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{new Date(t.expiresAt).toLocaleString()}</td>
                    <td className="py-2">
                      <Badge color={t.status === 'active' ? 'green' : t.status === 'expired' ? 'gray' : 'red'}>
                        {t.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </motion.div>
      </div>
    </DashboardLayout>
  );
}
