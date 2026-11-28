import { Component, createContext, useContext, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { reportClientError } from '@/lib/error-reporter';
import { reportBoundaryError, type ErrorBoundaryName } from '@/lib/telemetry/web-vitals';

/**
 * The route PATTERN (`router.pathname`) error boundaries below report under.
 * The dashboard layout provides it, so a boundary deep in a page (a chart, the
 * Ask panel) needs no router of its own.
 */
const RouteContext = createContext<string | null>(null);

/** Provide the route pattern for every {@link ErrorBoundary} beneath. */
export function ErrorBoundaryRoute({ route, children }: { route: string; children: ReactNode }) {
  return <RouteContext.Provider value={route}>{children}</RouteContext.Provider>;
}

/** Reported when no route is known; the server folds it into `other`. */
const UNKNOWN_ROUTE = '/_unknown';

interface Props {
  /** Child components to render when no error is present */
  children: ReactNode;
  /** Which kind of boundary this is — the `boundary` label on the telemetry counter. */
  boundary: ErrorBoundaryName;
  /** Route pattern to report under; defaults to the nearest {@link ErrorBoundaryRoute}. */
  route?: string;
  /** Custom UI to display instead of the default card */
  fallback?: ReactNode;
  /** Callback invoked when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** When this value changes, a caught error is cleared automatically. Pass a
   *  full-path key (e.g. `router.asPath`) so navigating within the same dynamic
   *  route (id→id, query-only change) recovers instead of stranding the error UI. */
  resetKey?: unknown;
  /** A small inline card (charts, panels) instead of the page-sized one. */
  compact?: boolean;
  /** What failed, for a compact card ("Log volume"). */
  label?: string;
  /** Extra classes on the card's outer element (e.g. a grid column span). */
  className?: string;
  /** Offer a Close button beside Retry (a drawer that can be dismissed instead). */
  onDismiss?: () => void;
}

interface InnerProps extends Omit<Props, 'route'> {
  route: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundaryInner extends Component<InnerProps, State> {
  constructor(props: InnerProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // The full error goes to the single reporting sink (logs in dev; relayed to
    // the runtime ERROR_REPORT_URL collector when configured) …
    reportClientError(error, { source: 'react', componentStack: errorInfo.componentStack ?? undefined });
    // … and a bounded count — boundary + route pattern, no message — to metrics.
    reportBoundaryError(this.props.boundary, this.props.route);
    this.props.onError?.(error, errorInfo);
  }

  componentDidUpdate(prevProps: InnerProps) {
    // Clear a caught error when the reset key changes (e.g. the user navigated to
    // a different record under the same dynamic route), so it doesn't strand.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    const { compact, label, className = '', onDismiss } = this.props;
    const details = this.state.error && process.env.NODE_ENV !== 'production' && (
      <details className="mt-3 text-left text-sm text-fg-muted">
        <summary className="cursor-pointer hover:text-fg">Error details</summary>
        <pre className="mt-2 overflow-auto rounded bg-surface-muted p-2 text-xs">
          {this.state.error.message}
          {'\n'}
          {this.state.error.stack}
        </pre>
      </details>
    );

    if (compact) {
      return (
        <div role="alert" className={`rounded-lg border border-default bg-surface p-4 flex flex-col items-center justify-center gap-2 text-center ${className}`.trimEnd()}>
          <AlertTriangle className="h-5 w-5 text-danger" aria-hidden="true" />
          <p className="text-sm font-medium text-fg">
            {label ? `${label} could not be displayed` : 'Something went wrong'}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="xs" onClick={this.handleRetry}>
              <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
              Retry
            </Button>
            {onDismiss && <Button variant="ghost" size="xs" onClick={onDismiss}>Close</Button>}
          </div>
          {details}
        </div>
      );
    }

    return (
      <div className={`min-h-[400px] flex items-center justify-center p-8 ${className}`.trimEnd()}>
        <div role="alert" className="text-center max-w-md rounded-xl border border-default bg-surface p-6 shadow-sm">
          <AlertTriangle className="mx-auto mb-4 h-12 w-12 text-danger" aria-hidden="true" />
          <h2 className="text-xl font-semibold text-fg mb-2">Something went wrong</h2>
          <p className="text-fg-muted mb-4">
            This part of the page hit an unexpected error. Retry to load it again.
          </p>
          <Button onClick={this.handleRetry}>
            <RotateCw className="w-4 h-4" aria-hidden="true" />
            Retry
          </Button>
          {details}
        </div>
      </div>
    );
  }
}

/**
 * React error boundary: catches rendering errors in its subtree and shows a
 * "Something went wrong — Retry" card (`role="alert"`, so it is announced; a
 * native, focusable Retry button that remounts the subtree), or `fallback`.
 * Each catch is counted on the observability stack by `boundary` and route
 * pattern (src/lib/telemetry/web-vitals.ts).
 */
export function ErrorBoundary({ route, ...props }: Props) {
  const contextRoute = useContext(RouteContext);
  return <ErrorBoundaryInner {...props} route={route ?? contextRoute ?? UNKNOWN_ROUTE} />;
}
