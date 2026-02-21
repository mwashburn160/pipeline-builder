import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw, ChevronRight } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Badge } from '@/components/ui/Badge';
import { CopyButton } from '@/components/ui/CopyButton';
import api from '@/lib/api';
import { decodeJwt, formatTimestamp, isExpired, expiresIn } from '@/lib/jwt';

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
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
          >
            {showRaw ? 'Decoded' : 'Raw'}
          </button>
          <CopyButton text={token} />
        </div>
      </div>

      {showRaw ? (
        <pre className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4 text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
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
              <pre className="mt-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-3 text-xs font-mono text-gray-600 dark:text-gray-400">
                {JSON.stringify(decoded.header, null, 2)}
              </pre>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Payload</p>
            <div className="border border-gray-200 dark:border-gray-700 rounded-xl divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
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

export default function TokensPage() {
  const { user, isReady, isAuthenticated } = useAuthGuard();

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genSuccess, setGenSuccess] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const syncTokens = useCallback(() => {
    setAccessToken(api.getRawAccessToken());
    setRefreshToken(api.getRawRefreshToken());
  }, []);

  useEffect(() => {
    if (isAuthenticated) syncTokens();
  }, [isAuthenticated, syncTokens]);

  const handleGenerateToken = async () => {
    setGenerating(true);
    setGenError(null);
    setGenSuccess(null);

    try {
      await api.generateNewToken();
      syncTokens();
      setGenSuccess('New token pair generated successfully. Your session tokens have been updated.');
    } catch (error) {
      setGenError(error instanceof Error ? error.message : 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  };

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="API Tokens" maxWidth="4xl">
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
      </div>
    </DashboardLayout>
  );
}
