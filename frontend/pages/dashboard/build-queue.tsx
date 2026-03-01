import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Clock, Loader, CheckCircle2, XCircle, PauseCircle, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LoadingPage } from '@/components/ui/Loading';
import type { QueueStatus } from '@/types';
import api from '@/lib/api';

const POLL_INTERVAL = 10_000;

interface StatCardProps {
  label: string;
  value: number | null;
  icon: LucideIcon;
  accent: string;
  delay: number;
}

function StatCard({ label, value, icon: Icon, accent, delay }: StatCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay }}
      className="card flex items-center gap-4"
    >
      <div className={`rounded-xl p-3 text-white ${accent}`}>
        <Icon className="w-6 h-6" />
      </div>
      <div>
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{label}</p>
        {value !== null ? (
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
            {value.toLocaleString()}
          </p>
        ) : (
          <div className="h-8 w-16 skeleton rounded" />
        )}
      </div>
    </motion.div>
  );
}

function queueHealth(status: QueueStatus | null): { label: string; color: string } {
  if (!status) return { label: 'Loading', color: 'bg-gray-400' };
  if (status.failed > 0) return { label: 'Failures Detected', color: 'bg-red-500' };
  if (status.waiting > 5) return { label: 'Backlogged', color: 'bg-yellow-500' };
  if (status.active > 0) return { label: 'Processing', color: 'bg-blue-500' };
  return { label: 'Idle', color: 'bg-green-500' };
}

export default function BuildQueuePage() {
  const { user, isReady } = useAuthGuard({ requireSystemAdmin: true });
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const res = await api.getQueueStatus();
      if (res.data) {
        setStatus(res.data);
        setLastUpdated(new Date());
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch queue status');
    }
  }, []);

  useEffect(() => {
    if (!isReady || !user) return;
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isReady, user, fetchStatus]);

  if (!isReady || !user) return <LoadingPage />;

  const health = queueHealth(status);

  const cards: Omit<StatCardProps, 'delay'>[] = [
    { label: 'Waiting', value: status?.waiting ?? null, icon: Clock, accent: 'bg-yellow-500' },
    { label: 'Active', value: status?.active ?? null, icon: Loader, accent: 'bg-blue-500' },
    { label: 'Completed', value: status?.completed ?? null, icon: CheckCircle2, accent: 'bg-green-500' },
    { label: 'Failed', value: status?.failed ?? null, icon: XCircle, accent: 'bg-red-500' },
    { label: 'Delayed', value: status?.delayed ?? null, icon: PauseCircle, accent: 'bg-gray-500' },
  ];

  return (
    <DashboardLayout
      title="Build Queue"
      actions={
        <button onClick={fetchStatus} className="btn-secondary flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      }
    >
      {error && (
        <div className="alert-error mb-6">
          {error}
        </div>
      )}

      {/* Health indicator */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mb-6 flex items-center gap-3"
      >
        <span className={`inline-block w-3 h-3 rounded-full ${health.color}`} />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {health.label}
        </span>
        {lastUpdated && (
          <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </motion.div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {cards.map((card, i) => (
          <StatCard key={card.label} {...card} delay={0.05 + i * 0.05} />
        ))}
      </div>
    </DashboardLayout>
  );
}
