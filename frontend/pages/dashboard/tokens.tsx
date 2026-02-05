import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

interface JwtPayload {
  [key: string]: unknown;
}

interface JwtParts {
  header: Record<string, unknown>;
  payload: JwtPayload;
  signature: string;
}

function decodeJwt(token: string): JwtParts | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const header = JSON.parse(atob(parts[0]));
    const payload = JSON.parse(atob(parts[1]));

    return { header, payload, signature: parts[2] };
  } catch {
    return null;
  }
}

function formatTimestamp(value: unknown): string | null {
  if (typeof value !== 'number') return null;
  // JWT timestamps are seconds‑based; convert to ms
  const ms = value < 1e12 ? value * 1000 : value;
  return new Date(ms).toLocaleString();
}

function isExpired(payload: JwtPayload): boolean {
  if (typeof payload.exp !== 'number') return false;
  return Date.now() > payload.exp * 1000;
}

function expiresIn(payload: JwtPayload): string | null {
  if (typeof payload.exp !== 'number') return null;
  const diff = payload.exp * 1000 - Date.now();
  if (diff <= 0) return 'Expired';
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

// ---------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select‑all inside a temp textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={copy}
      className="inline-flex items-center px-2 py-1 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
    >
      {copied ? (
        <>
          <svg className="w-3.5 h-3.5 mr-1 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

function Badge({ children, color }: { children: React.ReactNode; color: 'green' | 'red' | 'gray' | 'blue' }) {
  const colors = {
    green: 'bg-green-100 text-green-800',
    red: 'bg-red-100 text-red-800',
    gray: 'bg-gray-100 text-gray-800',
    blue: 'bg-blue-100 text-blue-800',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[color]}`}>
      {children}
    </span>
  );
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

function TokenCard({ title, token }: { title: string; token: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const decoded = useMemo(() => (token ? decodeJwt(token) : null), [token]);

  if (!token) {
    return (
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-2">{title}</h2>
        <p className="text-sm text-gray-500">No token available</p>
      </div>
    );
  }

  const expired = decoded ? isExpired(decoded.payload) : false;
  const ttl = decoded ? expiresIn(decoded.payload) : null;

  return (
    <div className="bg-white shadow rounded-lg p-6">
      {/* Header row */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <h2 className="text-lg font-medium text-gray-900">{title}</h2>
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
            className="text-xs font-medium text-blue-600 hover:text-blue-800"
          >
            {showRaw ? 'Decoded' : 'Raw'}
          </button>
          <CopyButton text={token} />
        </div>
      </div>

      {showRaw ? (
        /* Raw JWT */
        <pre className="bg-gray-50 border border-gray-200 rounded-md p-4 text-xs font-mono text-gray-700 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
          {token}
        </pre>
      ) : decoded ? (
        /* Decoded view */
        <div className="space-y-4">
          {/* Header */}
          <div>
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-700"
            >
              <svg
                className={`w-3.5 h-3.5 mr-1 transition-transform ${expanded ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Header
            </button>
            {expanded && (
              <pre className="mt-2 bg-gray-50 border border-gray-200 rounded-md p-3 text-xs font-mono text-gray-600">
                {JSON.stringify(decoded.header, null, 2)}
              </pre>
            )}
          </div>

          {/* Payload */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Payload</p>
            <div className="border border-gray-200 rounded-md divide-y divide-gray-100">
              {Object.entries(decoded.payload).map(([key, value]) => {
                const label = FIELD_LABELS[key] || key;
                const isTime = KNOWN_TIME_FIELDS.has(key);
                const formattedTime = isTime ? formatTimestamp(value) : null;

                return (
                  <div key={key} className="flex items-start px-4 py-2.5 text-sm">
                    <span className="w-44 shrink-0 font-medium text-gray-500 truncate" title={key}>
                      {label}
                    </span>
                    <span className="text-gray-900 break-all font-mono text-xs leading-5">
                      {formattedTime ? (
                        <span>
                          {formattedTime}
                          <span className="ml-2 text-gray-400">({String(value)})</span>
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
        <p className="text-sm text-red-600">Failed to decode token</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TokensPage() {
  const router = useRouter();
  const { user, isAuthenticated, isInitialized, isLoading: authLoading } = useAuth();

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [genSuccess, setGenSuccess] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  // Sync tokens from api client
  const syncTokens = useCallback(() => {
    setAccessToken(api.getRawAccessToken());
    setRefreshToken(api.getRawRefreshToken());
  }, []);

  useEffect(() => {
    if (isInitialized && !authLoading && !isAuthenticated) {
      router.push('/auth/login');
    }
  }, [isAuthenticated, isInitialized, authLoading, router]);

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
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  };

  if (!isInitialized || authLoading) {
    return <LoadingPage message="Loading..." />;
  }

  if (!isAuthenticated || !user) {
    return <LoadingPage message="Redirecting..." />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <Link href="/dashboard" className="text-gray-500 hover:text-gray-700">
              ← Back
            </Link>
            <h1 className="text-2xl font-bold text-gray-900">API Tokens</h1>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-4xl mx-auto py-6 px-4 sm:px-6 lg:px-8 space-y-6">
        {/* Generate Token */}
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="text-lg font-medium text-gray-900 mb-2">Generate New Token</h2>
          <p className="text-sm text-gray-500 mb-4">
            Generate a fresh access / refresh token pair. This replaces your current session tokens and
            can be used for CLI or API access.
          </p>

          {genError && (
            <div className="rounded-md bg-red-50 p-3 mb-4">
              <p className="text-sm text-red-800">{genError}</p>
            </div>
          )}
          {genSuccess && (
            <div className="rounded-md bg-green-50 p-3 mb-4">
              <p className="text-sm text-green-800">{genSuccess}</p>
            </div>
          )}

          <button
            onClick={handleGenerateToken}
            disabled={generating}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {generating ? <LoadingSpinner size="sm" className="mr-2" /> : (
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            {generating ? 'Generating...' : 'Generate Token'}
          </button>
        </div>

        {/* Current tokens */}
        <TokenCard title="Access Token" token={accessToken} />
        <TokenCard title="Refresh Token" token={refreshToken} />
      </main>
    </div>
  );
}
